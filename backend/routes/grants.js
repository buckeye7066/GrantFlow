import express from 'express';
import crypto from 'crypto';
import { safeParseJSON } from '../utils/safeJson.js';
import { validatePagination, validateRequiredFields, sanitizeColumns } from '../utils/validation.js';
import { formatError } from '../middleware/errorHandler.js';
import { mutationRateLimiter } from '../middleware/rateLimiting.js';
import { withProfileScope } from '../middleware/profileContext.js'
import { GRANT_STATUSES } from '../config/constants.js';
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js'
import {
  ensureGrantAccess as ensureGrantAccessUtil,
  ensureOrganizationAccess,
  ensureProfileAccess,
  getAccessibleOrganizationIds,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'
import { scheduleGrantApplicationApproach } from '../services/grantApplicationApproachAdvisor.js'
import { evaluatePipelineSource } from '../config/pipelineAllowedSources.js'
import { evaluateApplicantTypeEligibility } from '../services/applicantTypeGate.js'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { loadProfileContext, mergeOpportunitySignals } from '../services/profileHelpers.js'
import { decorateOpportunityFreshness, saveToProfilePipeline } from '../services/opportunityMatcher.js'
import {
  gateOpportunityForPipeline,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'
import {
  grantFingerprintFromOpportunity,
  chooseGrantUrl,
  GRANT_FINGERPRINT_VERSION,
} from '../utils/grantFingerprint.js'
import { assertSafeIdentifier } from '../utils/safeSql.js'
import {
  recordDismissal as recordPipelineDismissal,
  clearDismissal as clearPipelineDismissal,
  isDismissed as isDismissedFromPipeline,
} from '../services/pipelineDismissals.js'
import { recordBehaviorEvent } from '../services/behaviorLearning.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:grants')

const router = express.Router();

function runLegacyProfilelessGrantQuery(fn) {
  return withProfileScope({ bypass: true }, fn)
}

async function loadGrantByIdForProfileAwareResponse(db, id, profileId) {
  const hasProfileId = await grantsHasProfileIdColumn(db, { refresh: true }).catch(() => false)
  if (hasProfileId && profileId) {
    return db.prepare('SELECT * FROM grants WHERE id = ? AND profile_id = ?').get(String(id), String(profileId))
  }
  return runLegacyProfilelessGrantQuery(() =>
    db.prepare('SELECT * FROM grants WHERE id = ?').get(String(id)),
  )
}

function isUniqueGrantConflict(error) {
  const msg = String(error?.message || '')
  return (
    error?.code === '23505' ||
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (error?.code === 'SQLITE_CONSTRAINT' && /unique/i.test(msg)) ||
    /duplicate key value|unique constraint failed|ux_grants_profile_opportunity/i.test(msg)
  )
}

async function findExistingGrantByProfileOpportunity(db, profileId, opportunityId) {
  if (!profileId || !opportunityId) return null
  return db
    .prepare(
      `SELECT *
         FROM grants
        WHERE profile_id = ?
          AND funding_opportunity_id = ?
        LIMIT 1`,
    )
    .get(String(profileId), String(opportunityId))
}

function parseOpportunityContact(opportunity) {
  let ci = {}
  try {
    const raw = opportunity.contact_info
    ci = typeof raw === 'string' ? JSON.parse(raw) : (raw || {})
  } catch { /* ignore */ }
  const desc = `${opportunity.description || ''} ${opportunity.applicationNote || ''}`.toLowerCase()
  let method = opportunity.application_method || null
  if (!method) {
    if (desc.includes('fax')) method = 'fax'
    else if (desc.includes('mail') && !desc.includes('email')) method = 'print_and_mail'
    else if (opportunity.application_url || opportunity.url) method = 'portal'
  }
  return {
    name: ci.name || opportunity.contact_name || null,
    email: ci.email || opportunity.contact_email || null,
    phone: ci.phone || opportunity.contact_phone || null,
    fax: ci.fax || opportunity.funder_fax || null,
    address: ci.address || opportunity.funder_address || null,
    method,
  }
}

const FIELD_ALIASES = {
  funder_email: 'contact_email',
  funder_phone: 'contact_phone',
  url: 'application_url',
  portal_url: 'application_url',
  application_instructions: 'application_steps',
}

function normalizeGrantFields(data) {
  const out = {}
  for (const [key, value] of Object.entries(data)) {
    out[FIELD_ALIASES[key] || key] = value
  }
  return out
}

// Whitelist of allowed columns for UPDATE operations
const ALLOWED_GRANT_COLUMNS = new Set([
  'organization_id', 'funding_opportunity_id', 'title', 'funder', 'deadline',
  'status', 'priority', 'amount_requested', 'amount_awarded', 'amount_min', 'amount_max',
  'application_url',
  // Outcome dates. `amount_awarded` was already writable but these were not, so
  // an award could never be dated and "time to award" analytics read from two
  // columns nothing could populate. The whole find->apply->submit->confirmed
  // chain terminates here; without them the product cannot record that a
  // profile actually received money.
  'submitted_date', 'award_date',
  'match_score', 'match_reasons', 'notes', 'requirements', 'eligibility',
  'application_steps', 'contact_name', 'contact_email', 'contact_phone',
  'funder_fax', 'funder_address', 'application_method',

  // AI Coach input fields
  'program_description',
  'eligibility_summary',
  'selection_criteria',

  // AI Coach outputs / status tracking
  'ai_status',
  'ai_summary',
  'ai_error',
  'ai_updated_at',

  // optional back-compat fields used by some UIs
  'portal_url',

  // Canonical URL + fingerprint + match-decision metadata (migration 058).
  // These are permitted so the UI / crawlers can round-trip the exact value
  // that matchEngine persists without stripping it at the route boundary.
  'url',
  'fingerprint',
  'fingerprint_version',
  'match_decision',
  'match_explanation',
  'matched_needs',
  'eligibility_status',
  'ineligibility_reasons',
  'profile_fingerprint',
  'opportunity_fingerprint',
  'matcher_version',
  'evaluated_at',
  'match_confidence',
]);

// NOTE: Access control is centralized in `backend/utils/accessControl.js`

let postgresHasGrantsProfileIdColumn = null
let sqliteHasGrantsProfileIdColumn = null
let ensuredGrantAiColumns = false

async function hasColumn(db, { tableName, columnName }) {
  const dialect = db?.dialect || 'sqlite'
  if (dialect === 'postgres') {
    const row = await db
      .prepare(
        `
          SELECT 1 AS ok
          FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name=?
            AND column_name=?
          LIMIT 1
        `,
      )
      .get(String(tableName), String(columnName))
    return Boolean(row?.ok)
  }

  // SQLite
  const rows = await db.prepare(`PRAGMA table_info(${String(tableName)})`).all()
  return rows.some((r) => String(r?.name || '').toLowerCase() === String(columnName).toLowerCase())
}

async function grantsHasProfileIdColumn(db, { refresh = false } = {}) {
  const dialect = db?.dialect || 'sqlite'
  if (dialect === 'postgres') {
    if (refresh || postgresHasGrantsProfileIdColumn === null) {
      postgresHasGrantsProfileIdColumn = await hasColumn(db, { tableName: 'grants', columnName: 'profile_id' })
    }
    return postgresHasGrantsProfileIdColumn
  }

  if (refresh || sqliteHasGrantsProfileIdColumn === null) {
    sqliteHasGrantsProfileIdColumn = await hasColumn(db, { tableName: 'grants', columnName: 'profile_id' })
  }
  return sqliteHasGrantsProfileIdColumn
}

async function ensureGrantAiColumns(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredGrantAiColumns) {
    const hasProfileId = await grantsHasProfileIdColumn(db, { refresh: true }).catch(() => true)
    if (hasProfileId) return
  }

  try {
    const columnsToEnsure = [
      { name: 'program_description', pg: 'TEXT', sqlite: 'TEXT' },
      { name: 'eligibility_summary', pg: 'TEXT', sqlite: 'TEXT' },
      { name: 'selection_criteria', pg: 'TEXT', sqlite: 'TEXT' },
      { name: 'ai_status', pg: 'TEXT', sqlite: 'TEXT' },
      { name: 'ai_summary', pg: 'TEXT', sqlite: 'TEXT' },
      { name: 'ai_error', pg: 'TEXT', sqlite: 'TEXT' },
      { name: 'ai_updated_at', pg: 'TIMESTAMPTZ', sqlite: 'DATETIME' },
      { name: 'amount_min', pg: 'DOUBLE PRECISION', sqlite: 'REAL' },
      { name: 'amount_max', pg: 'DOUBLE PRECISION', sqlite: 'REAL' },
    ]

    // Ensure profile_id exists too (many code paths expect it).
    const needsProfileId = !(await grantsHasProfileIdColumn(db, { refresh: true }))
    const cols = needsProfileId ? [{ name: 'profile_id', pg: 'TEXT', sqlite: 'TEXT' }, ...columnsToEnsure] : columnsToEnsure

    if (db.dialect === 'postgres') {
      for (const c of cols) {
        await db.prepare(`ALTER TABLE grants ADD COLUMN IF NOT EXISTS ${c.name} ${c.pg};`).run()
      }
      postgresHasGrantsProfileIdColumn = true
      ensuredGrantAiColumns = true
      return
    }

    // SQLite: detect via PRAGMA, then ALTER TABLE (no IF NOT EXISTS in older versions)
    const info = await db.prepare('PRAGMA table_info(grants)').all()
    const existing = new Set((info || []).map((r) => String(r?.name || '').toLowerCase()))
    for (const c of cols) {
      if (existing.has(String(c.name).toLowerCase())) continue
      // audit:allow dynamic-sql — c is from a hardcoded module-local constant list
      const colName = assertSafeIdentifier(c.name, 'identifier')
      const colType = assertSafeIdentifier(String(c.sqlite).split(' ')[0], 'identifier')
      const tail = String(c.sqlite).slice(colType.length).replace(/[^A-Za-z0-9 \t_'"-]/g, '')
      await db.prepare(`ALTER TABLE grants ADD COLUMN ${colName} ${colType}${tail};`).run()
      if (c.name === 'profile_id') sqliteHasGrantsProfileIdColumn = true
    }
  } catch (error) {
    // Do not 500 normal grant routes if schema drift exists; log and continue.
    console.warn('[grants] ensureGrantAiColumns failed (continuing):', error?.message || String(error))
  } finally {
    ensuredGrantAiColumns = true
  }
}

function normalizeOrganizationApplicantType(raw) {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!v) return null
  const key = v.toLowerCase()
  // Must match organizations.applicant_type CHECK constraint.
  const allowed = new Set([
    'individual_need',
    'family',
    'organization',
    'nonprofit',
    'small_business',
    'student',
    'college_student',
    'high_school_student',
    'medical_assistance',
    'government',
    'other',
  ])
  if (allowed.has(key)) return key
  return null
}

function deriveOrganizationApplicantTypeFromProfile(profileRow) {
  // Prefer explicit types when present.
  const direct =
    normalizeOrganizationApplicantType(profileRow?.primary_type) ??
    normalizeOrganizationApplicantType(profileRow?.applicant_type) ??
    null
  if (direct) return direct

  // Heuristic fallback.
  const name = String(profileRow?.display_name || '').toLowerCase()
  if (name.includes('inc') || name.includes('llc') || name.includes('company')) return 'small_business'
  if (name.includes('church') || name.includes('ministry') || name.includes('foundation')) return 'nonprofit'
  return 'individual_need'
}

function normalizeDateForDb(value) {
  if ((value === null || value === undefined) || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const raw = typeof value === 'string' ? value.trim() : String(value)
  if (!raw) return null

  const lowered = raw.toLowerCase()
  // Common non-date values from crawlers/discovery.
  if (
    lowered === 'rolling' ||
    lowered === 'ongoing' ||
    lowered === 'open' ||
    lowered === 'continuous' ||
    lowered === 'varies' ||
    lowered === 'tbd' ||
    lowered === 'unknown'
  ) {
    return null
  }

  // Extract date-like string but ALWAYS validate by parsing
  let candidate = null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    candidate = raw
  } else if (/^\d{4}-\d{2}-\d{2}t/i.test(raw)) {
    candidate = raw.slice(0, 10)
  }

  if (candidate) {
    // Validate the extracted date is actually valid (e.g., not 2026-13-45)
    const [year, month, day] = candidate.split('-').map(Number)
    const testDate = new Date(Date.UTC(year, month - 1, day))
    if (
      !Number.isNaN(testDate.getTime()) &&
      testDate.getUTCFullYear() === year &&
      testDate.getUTCMonth() === month - 1 &&
      testDate.getUTCDate() === day
    ) {
      return candidate
    }
    // Invalid date like 2026-02-30 - fall through to Date parsing
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function normalizeMoney(value) {
  if ((value === null || value === undefined) || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const s = String(value).trim()
  if (!s) return null
  const cleaned = s
    .replace(/[$,]/g, '')
    .replace(/usd/gi, '')
    .replace(/\s+/g, '')
  const n = Number.parseFloat(cleaned)
  if (!Number.isFinite(n)) return null
  return n
}

function normalizeMatchScore(value) {
  if ((value === null || value === undefined) || value === '') return null
  let n = null
  if (typeof value === 'number' && Number.isFinite(value)) n = value
  else {
    const s = String(value).trim().replace('%', '')
    const parsed = Number.parseFloat(s)
    if (Number.isFinite(parsed)) n = parsed
  }
  if ((n === null || n === undefined)) return null
  // If it looks like a fraction (0..1), treat as 0..100.
  if (n > 0 && n <= 1) n = n * 100
  const rounded = Math.round(n)
  return Math.max(0, Math.min(100, rounded))
}

function coerceString(value, { maxLen } = {}) {
  if ((value === null || value === undefined)) return null
  const s = String(value).trim()
  if (!s) return null
  if (typeof maxLen === 'number' && maxLen > 0 && s.length > maxLen) return s.slice(0, maxLen)
  return s
}

function coerceArray(value) {
  if (Array.isArray(value)) return value
  if ((value === null || value === undefined)) return []
  // Try JSON if it looks like it.
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        return [trimmed]
      }
    }
    return [trimmed]
  }
  return [value]
}

function normalizeSortColumn(raw) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!key) return 'g.created_at'

  // Back-compat for older UI sort keys.
  const normalizedKey =
    key === 'created_date' ? 'created_at' :
    key === 'updated_date' ? 'updated_at' :
    key

  // Only allow known columns (prevent SQL injection via sort param).
  const allowed = new Set([
    'created_at',
    'updated_at',
    'deadline',
    'status',
    'priority',
    'title',
    'funder',
    'amount_requested',
    'amount_awarded',
    'match_score',
  ])

  if (!allowed.has(normalizedKey)) return 'g.created_at'
  return `g.${normalizedKey}`
}

function normalizeSortOrder(raw) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return key === 'asc' ? 'ASC' : 'DESC'
}

export function mapAutomationEvent(row) {
  if (!row) return null

  // `recommended_actions` is historically a JSON column that can hold either:
  //   - an array of action strings (legacy shape), OR
  //   - an object like { actions: [...], application_steps: "...", ... }
  //     (the shape the pipeline_automation worker has been emitting).
  //
  // The UI handoff panel needs both `actions` (a normalised array) and
  // `application_steps` (a free-form multi-line string the user can print
  // or read). Previously we returned the raw parsed value as
  // `recommended_actions` and the application_steps were buried inside an
  // object that the frontend had to introspect itself.
  const parsed = safeParseJSON(row.recommended_actions, [])
  const actions = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.actions)
      ? parsed.actions
      : []

  const applicationStepsRaw =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.application_steps
      : null
  const application_steps =
    typeof applicationStepsRaw === 'string' && applicationStepsRaw.trim()
      ? applicationStepsRaw.trim()
      : null

  return {
    id: row.id,
    created_at: row.created_at,
    grant_id: row.grant_id,
    job_id: row.job_id,
    previous_status: row.previous_status,
    suggested_status: row.suggested_status,
    applied_status: row.applied_status,
    confidence: row.confidence,
    handoff_required: Boolean(row.handoff_required),
    handoff_reason: row.handoff_reason,
    recommended_actions: actions,
    application_steps,
    ai_summary: row.ai_summary,
  }
}

// List all grants
router.get('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    // IMPORTANT:
    // Many production DBs predate `grants.profile_id` (and the newer AI columns).
    // If the UI sends `X-Profile-Id` (it does), referencing `g.profile_id` without this
    // guard causes a hard 500. Keep this self-healing and non-fatal.
    await ensureGrantAiColumns(req.db)

    const { organization_id, status } = req.query;
    const sortCol = normalizeSortColumn(req.query.sort)
    const sortOrder = normalizeSortOrder(req.query.order)
    const headerProfileId = typeof req.headers['x-profile-id'] === 'string' ? req.headers['x-profile-id'] : null
    const profile_id = (typeof req.query.profile_id === 'string' ? req.query.profile_id : null) || headerProfileId
    const urlFilter = typeof req.query.url === 'string' ? req.query.url : null
    const { limit, offset } = validatePagination(req.query);
    
    // Expose a geographic state for analytics/reporting. grants rows do not
    // carry their own state column, so we surface it from the best available
    // upstream source: the linked funding opportunity first (most specific to
    // the grant), then the owning organization/profile. Geographic Analysis
    // (src/pages/AdvancedAnalytics.jsx) buckets on `grant.state`; without this
    // every grant fell into "Unknown".
    let query = `
      SELECT g.*, o.name as organization_name,
             COALESCE(fo.state, o.state) AS state
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
      LEFT JOIN funding_opportunities fo ON g.funding_opportunity_id = fo.id
      WHERE 1=1
    `;
    const params = [];

    if (req.ctx?.isAdmin !== true) {
      // If an active profile is selected, list the profile-scoped pipeline.
      if (profile_id) {
        if (!(await ensureProfileAccess(req, res, String(profile_id)))) return
        query += ` AND g.profile_id = ?`
        params.push(String(profile_id))
      } else {
        // Backward compatible: fall back to organization-scoped listing.
        // Also include any profile-scoped grants the user can access (in case org_id is null).
        const ctxProfiles = req.ctx?.accessibleProfileIds instanceof Set ? Array.from(req.ctx.accessibleProfileIds) : []
        const orgIds = await getAccessibleOrganizationIds(req.db, user)
        const ctxOrgs = orgIds instanceof Set ? Array.from(orgIds) : []

        if (ctxProfiles.length === 0 && ctxOrgs.length === 0) {
          return res.json([])
        }

        const clauses = []
        if (ctxProfiles.length > 0) {
          clauses.push(`g.profile_id IN (${ctxProfiles.map(() => '?').join(',')})`)
          params.push(...ctxProfiles)
        }
        if (ctxOrgs.length > 0) {
          clauses.push(`g.organization_id IN (${ctxOrgs.map(() => '?').join(',')})`)
          params.push(...ctxOrgs)
        }
        query += ` AND (${clauses.join(' OR ')})`
      }

      if (organization_id) {
        // If organization_id filter is requested, require explicit access.
        const orgIds = await getAccessibleOrganizationIds(req.db, user)
        if (organization_id && (!orgIds || !orgIds.has(String(organization_id)))) {
          return res.status(403).json({ error: 'Not authorized to access this organization' })
        }
      }
    } else {
      if (profile_id) {
        query += ` AND g.profile_id = ?`
        params.push(String(profile_id))
      }
    }
    
    if (organization_id) {
      query += ' AND g.organization_id = ?';
      params.push(organization_id);
    }
    
    if (status) {
      if (status.includes(',')) {
        const statuses = status.split(',');
        query += ` AND g.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      } else {
        query += ' AND g.status = ?';
        params.push(status);
      }
    }

    // Fundability filter: directories (locators), government BENEFIT entitlements
    // (SNAP/Medicaid/SSA — you enroll, you don't write a proposal), and
    // PAST_AWARD_INTEL are reference-only and must NOT pollute the proposal
    // pipeline or the AI Grant Scorer dropdown (which reads this endpoint). Exclude
    // by canonical opportunity_kind, NULL-safe so legacy grants without a linked
    // opportunity still appear. A resources view can opt back in with
    // ?include_directories=true.
    if (String(req.query.include_directories ?? '') !== 'true') {
      const { NON_PROPOSAL_KINDS } = await import('../../shared/opportunityFundability.js')
      query += ` AND (fo.opportunity_kind IS NULL OR UPPER(fo.opportunity_kind) NOT IN (${NON_PROPOSAL_KINDS.map(() => '?').join(',')}))`
      params.push(...NON_PROPOSAL_KINDS)
    }

    // Back-compat for older UI duplicate-checks: they pass `url=<opportunityUrl>`.
    // In our schema, the canonical URL lives in `application_url`.
    if (urlFilter) {
      query += ' AND g.application_url = ?'
      params.push(urlFilter)
    }
    
    // sortCol already comes from normalizeSortColumn() with a hardcoded
    // allowlist. Re-validate through assertSafeIdentifier so the auditor
    // can see an explicit validator at the call site, and so a future
    // refactor of normalizeSortColumn can't accidentally return an
    // unvetted column name. sortOrder is ASC|DESC only (normalized above).
    const safeSortCol = (() => {
      const col = String(sortCol).startsWith('g.') ? String(sortCol).slice(2) : String(sortCol)
      return `g.${assertSafeIdentifier(col, 'column')}`
    })()
    const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC'
    query += ` ORDER BY ${safeSortCol} ${safeSortOrder} LIMIT ? OFFSET ?`; // audit:allow dynamic-sql
    params.push(limit, offset);
    
    const grants = await req.db.prepare(query).all(...params);
    
    // Parse JSON fields safely and decorate with freshness
    const parsed = grants.map(grant => {
      const withReasons = { ...grant, match_reasons: safeParseJSON(grant.match_reasons, []) }
      const freshness = decorateOpportunityFreshness(withReasons)
      return {
        ...withReasons,
        freshness: freshness.freshness,
        days_since_verified: freshness.days_since_verified,
        freshness_warning: freshness.freshness_warning,
      }
    });

    // Collapse duplicate pipeline rows for the same opportunity so lists (and the
    // counts derived from them) never double-show a grant. Skipped when paging or
    // filtering by url (those callers want exact rows). Opt out with ?dedupe=0.
    let result = parsed;
    if (String(req.query.dedupe ?? '') !== '0' && !urlFilter) {
      const { dedupePipelineGrants } = await import('../../shared/dedupePipelineGrants.js');
      result = dedupePipelineGrants(parsed);
    }

    res.json(result);
  } catch (error) {
    console.error('Error listing grants:', error);
    res.status(500).json(formatError(error));
  }
});

// Get grants grouped by status (for pipeline view)
router.get('/pipeline', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const { organization_id } = req.query;
    const headerProfileId = typeof req.headers['x-profile-id'] === 'string' ? req.headers['x-profile-id'] : null
    const profile_id = (typeof req.query.profile_id === 'string' ? req.query.profile_id : null) || headerProfileId
    await ensureGrantAiColumns(req.db)
    
    let query = `
      SELECT g.*, o.name as organization_name 
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
    `;
    const params = [];

    // Canonical pipeline buckets — must include every status produced by the
    // pipeline_automation engine (backend/services/pipelineAutomation.js)
    // and the frontend KanbanBoard (src/components/pipeline/KanbanBoard.jsx).
    // Without this the endpoint silently drops grants advanced past
    // `submitted` (portal, pending_review, follow_up, report, declined,
    // declined_no_review, closed) and breaks the UI counts contract:
    // "If results are found but not displayed, treat this as a bug."
    const PIPELINE_BUCKETS = [
      'discovery',
      'discovered',
      'interested',
      'auto_applied',
      'drafting',
      'application_prep',
      'app_prep', // legacy alias kept for API back-compat
      'revision',
      'portal',
      'submitted',
      'pending_review',
      'follow_up',
      'awarded',
      'report',
      'declined',
      'declined_no_review',
      'closed',
      'rejected', // legacy alias kept for API back-compat
    ]
    const buildEmptyPipeline = () =>
      PIPELINE_BUCKETS.reduce((acc, key) => {
        acc[key] = []
        return acc
      }, {})

    // Legacy statuses that may still live in the DB → canonical bucket.
    // We keep the legacy bucket present in the response so older clients keep working.
    const LEGACY_STATUS_TO_BUCKET = {
      app_prep: 'application_prep',
      under_review: 'pending_review',
      rejected: 'declined',
      archived: 'closed',
    }

    if (req.ctx?.isAdmin !== true) {
      // If a profile is selected (query or X-Profile-Id), scope the pipeline strictly to it.
      if (profile_id) {
        if (!(await ensureProfileAccess(req, res, String(profile_id)))) return
        query += ` WHERE g.profile_id = ?`
        params.push(String(profile_id))
      } else {
        const orgIds = await getAccessibleOrganizationIds(req.db, user)
        if (!orgIds || orgIds.size === 0) {
          return res.json(buildEmptyPipeline())
        }
        if (organization_id && !orgIds.has(String(organization_id))) {
          return res.status(403).json({ error: 'Not authorized to access this organization' })
        }
        const placeholders = Array.from(orgIds).map(() => '?').join(',')
        query += ` WHERE g.organization_id IN (${placeholders})`
        params.push(...Array.from(orgIds))
      }
    } else if (profile_id) {
      query += ` WHERE g.profile_id = ?`
      params.push(String(profile_id))
    }
    
    if (organization_id) {
      query += query.includes('WHERE') ? ' AND g.organization_id = ?' : ' WHERE g.organization_id = ?';
      params.push(organization_id);
    }
    
    // SQLite doesn't support `NULLS LAST`. Make ordering deterministic across dialects.
    if (req.db?.dialect === 'sqlite') {
      query += ' ORDER BY (g.deadline IS NULL) ASC, g.deadline ASC, g.created_at DESC'
    } else {
      query += ' ORDER BY g.deadline ASC NULLS LAST, g.created_at DESC'
    }
    
    const grants = await req.db.prepare(query).all(...params);

    // Group by canonical bucket. Map legacy statuses into their canonical
    // bucket so nothing is silently dropped, and place a copy in the legacy
    // bucket too so older clients still see their familiar shape.
    const pipeline = buildEmptyPipeline();
    let droppedUnknown = 0
    grants.forEach(grant => {
      const withReasons = { ...grant, match_reasons: safeParseJSON(grant.match_reasons, []) }
      const freshness = decorateOpportunityFreshness(withReasons)
      const parsed = {
        ...withReasons,
        freshness: freshness.freshness,
        days_since_verified: freshness.days_since_verified,
        freshness_warning: freshness.freshness_warning,
      };

      const rawStatus = typeof grant.status === 'string' ? grant.status.trim().toLowerCase() : ''
      const canonicalBucket = LEGACY_STATUS_TO_BUCKET[rawStatus] ?? rawStatus

      if (pipeline.hasOwnProperty(canonicalBucket)) {
        pipeline[canonicalBucket].push(parsed)
      }
      // Keep legacy alias bucket populated too so back-compat clients still see them.
      if (rawStatus !== canonicalBucket && pipeline.hasOwnProperty(rawStatus)) {
        pipeline[rawStatus].push(parsed)
      }
      if (!pipeline.hasOwnProperty(canonicalBucket) && !pipeline.hasOwnProperty(rawStatus)) {
        droppedUnknown += 1
      }
    });

    if (droppedUnknown > 0) {
      console.warn('[grants/pipeline] dropped grants with unknown status', {
        dropped: droppedUnknown,
        profile_id: profile_id || null,
      })
    }

    res.json(pipeline);
  } catch (error) {
    console.error('Error getting pipeline:', error);
    res.status(500).json(formatError(error));
  }
});

router.get('/automation/summary', async (req, res) => {
  const auth = requireAuthenticatedUser(req, res)
  if (!auth) return

  const organizationId = req.query.organization_id
  if (!organizationId) {
    return res.status(400).json({ error: 'organization_id query parameter is required' })
  }

  if (req.ctx?.isAdmin !== true) {
    if (!(await ensureOrganizationAccess(req, res, String(organizationId)))) return
  }

  try {
    const rows = await req.db
      .prepare(
        `
          WITH latest AS (
            SELECT grant_id, MAX(created_at) AS created_at
            FROM grant_pipeline_events
            GROUP BY grant_id
          )
          SELECT
            g.id,
            g.title,
            g.status,
            g.deadline,
            g.priority,
            e.created_at AS automation_at,
            e.applied_status AS automation_status,
            e.handoff_required,
            e.handoff_reason,
            e.ai_summary,
            e.recommended_actions
          FROM grants g
          LEFT JOIN latest l ON l.grant_id = g.id
          LEFT JOIN grant_pipeline_events e
            ON e.grant_id = l.grant_id AND e.created_at = l.created_at
          WHERE g.organization_id = ?
          ORDER BY g.status ASC, g.updated_at DESC
        `,
      )
      .all(organizationId)

    res.json(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        deadline: row.deadline,
        priority: row.priority,
        automation: row.automation_at
          ? {
              processed_at: row.automation_at,
              status: row.automation_status,
              handoff_required: Boolean(row.handoff_required),
              handoff_reason: row.handoff_reason,
              summary: row.ai_summary,
              recommended_actions: safeParseJSON(row.recommended_actions, []),
            }
          : null,
      })),
    )
  } catch (error) {
    routeLogger.error('Error building automation summary:', error)
    res.status(500).json(formatError(error))
  }
});

router.get('/:id/automation/events', async (req, res) => {
  const grant = await ensureGrantAccessUtil(req, res, req.params.id)
  if (!grant) return

  try {
    const limit = Number.parseInt(req.query.limit ?? 25, 10)
    const events = await req.db
      .prepare(
        `
          SELECT *
          FROM grant_pipeline_events
          WHERE grant_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(grant.id, Number.isFinite(limit) ? limit : 25)

    res.json(events.map(mapAutomationEvent))
  } catch (error) {
    routeLogger.error('Error listing automation events:', error)
    res.status(500).json(formatError(error))
  }
});

router.get('/:id/automation/latest', async (req, res) => {
  const grant = await ensureGrantAccessUtil(req, res, req.params.id)
  if (!grant) return

  try {
    const row = await req.db
      .prepare(
        `
          SELECT *
          FROM grant_pipeline_events
          WHERE grant_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(grant.id)

    res.json(mapAutomationEvent(row))
  } catch (error) {
    routeLogger.error('Error fetching latest automation event:', error)
    res.status(500).json(formatError(error))
  }
});

// Get single grant
router.get('/:id', async (req, res) => {
  try {
    await ensureGrantAiColumns(req.db)
    const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
    if (!grantAccess) return

    const grant = await req.db.prepare(`
      SELECT g.*, o.name as organization_name 
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
      WHERE g.id = ?
        AND (g.profile_id = ? OR g.profile_id IS NULL)
    `).get(req.params.id, grantAccess.profile_id ?? null);
    
    if (!grant) {
      return res.status(404).json({ error: 'Grant not found' });
    }
    
    // Parse JSON fields and provide frontend-expected aliases
    const parsed = {
      ...grant,
      match_reasons: safeParseJSON(grant.match_reasons, []),
      funder_email: grant.contact_email || null,
      funder_phone: grant.contact_phone || null,
      url: grant.application_url || null,
      application_instructions: grant.application_steps || null,
    };
    
    // Get related data
    const milestones = await req.db.prepare('SELECT * FROM milestones WHERE grant_id = ? ORDER BY due_date ASC').all(req.params.id);
    const documents = await req.db.prepare('SELECT * FROM documents WHERE grant_id = ? ORDER BY created_at DESC').all(req.params.id);
    const expenses = await req.db.prepare('SELECT * FROM expenses WHERE grant_id = ? ORDER BY date DESC').all(req.params.id);
    const drafts = await req.db.prepare('SELECT * FROM application_drafts WHERE grant_id = ? ORDER BY section_order ASC').all(req.params.id);
    
    res.json({
      ...parsed,
      milestones,
      documents,
      expenses,
      application_drafts: drafts
    });
  } catch (error) {
    console.error('Error getting grant:', error);
    res.status(500).json(formatError(error));
  }
});

// AI helper: draft missing Program Description / Eligibility Summary / Selection Criteria
router.post('/:id/ai/draft-details', mutationRateLimiter, async (req, res) => {
  const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
  if (!grantAccess) return

  try {
    await ensureGrantAiColumns(req.db)

    const grant = await req.db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id)
    if (!grant) return res.status(404).json({ error: 'Grant not found' })

    const opp = grant.funding_opportunity_id
      ? await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(grant.funding_opportunity_id)
      : null

    const oppEligibilityBullets = safeParseJSON(opp?.eligibility_bullets, [])
    const eligibilityFromBullets =
      Array.isArray(oppEligibilityBullets) && oppEligibilityBullets.length > 0
        ? oppEligibilityBullets.map((b) => `- ${String(b).trim()}`).join('\n')
        : ''

    let program_description = String(grant.program_description || '').trim()
    let eligibility_summary = String(grant.eligibility_summary || '').trim()
    let selection_criteria = String(grant.selection_criteria || '').trim()

    // Deterministic backfill from the linked opportunity (preferred to AI hallucination)
    if (!program_description) {
      const fromOpp = String(opp?.description || '').trim()
      if (fromOpp) program_description = fromOpp
    }
    if (!eligibility_summary) {
      if (eligibilityFromBullets) eligibility_summary = eligibilityFromBullets
    }

    const needsAi = !program_description || !eligibility_summary || !selection_criteria
    if (needsAi) {
      const { openai } = createOpenAIClient({ allowMissing: true })
      if (!openai) {
        return res.status(503).json({
          error: 'ai_unavailable',
          message: 'OpenAI is not configured on the server (OPENAI_API_KEY missing).',
          draft: { program_description, eligibility_summary, selection_criteria },
        })
      }

      const evidence = {
        title: grant.title,
        funder: grant.funder ?? null,
        application_url: grant.application_url ?? opp?.application_url ?? opp?.source_url ?? null,
        opportunity_description: String(opp?.description || '').trim() || null,
        opportunity_eligibility_bullets: Array.isArray(oppEligibilityBullets) ? oppEligibilityBullets : [],
        existing_program_description: program_description || null,
        existing_eligibility_summary: eligibility_summary || null,
        existing_selection_criteria: selection_criteria || null,
      }

      const prompt = `You are helping fill missing grant listing fields so an AI coach can analyze the grant.

RULES:
- Use ONLY the provided evidence JSON.
- If evidence is insufficient, write a minimal neutral placeholder like: "Not provided in the listing. Review the application URL for details."
- Return STRICT JSON with keys: program_description, eligibility_summary, selection_criteria (strings).
- Keep it concise and readable. Prefer bullets for eligibility_summary and selection_criteria.

EVIDENCE JSON:
${JSON.stringify(evidence, null, 2)}
`

      try {
        const completion = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 800,
        })

        const raw = String(completion?.choices?.[0]?.message?.content || '').trim()
        const match = raw.match(/\{[\s\S]*\}/)
        const parsed = match ? JSON.parse(match[0]) : JSON.parse(raw)

        if (!program_description) program_description = String(parsed?.program_description || '').trim()
        if (!eligibility_summary) eligibility_summary = String(parsed?.eligibility_summary || '').trim()
        if (!selection_criteria) selection_criteria = String(parsed?.selection_criteria || '').trim()
      } catch (error) {
        const summary = summarizeOpenAIError(error)
        return res.status(502).json({
          error: 'ai_failed',
          message: summary?.message || 'AI drafting failed',
          draft: { program_description, eligibility_summary, selection_criteria },
        })
      }
    }

    const now = new Date().toISOString()
    await req.db
      .prepare(
        `
          UPDATE grants
          SET program_description = ?,
              eligibility_summary = ?,
              selection_criteria = ?,
              updated_at = CURRENT_TIMESTAMP,
              ai_updated_at = ?
          WHERE id = ?
        `,
      )
      .run(program_description || null, eligibility_summary || null, selection_criteria || null, now, req.params.id)

    const updated = await req.db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id)
    res.json({ ok: true, grant: updated })
  } catch (error) {
    routeLogger.error('[grants/ai/draft-details] Error:', error)
    res.status(500).json(formatError(error))
  }
})

// Create grant
router.post('/', mutationRateLimiter, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const data = req.body;
    
    // Validate required fields
    const validation = validateRequiredFields(data, ['title', 'organization_id']);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        missingFields: validation.missingFields 
      });
    }
    
    if (!(await ensureOrganizationAccess(req, res, String(data.organization_id)))) return

    const id = crypto.randomUUID();

    // Normalize frontend aliases → canonical column names, then sanitize
    const sanitizedData = sanitizeColumns(normalizeGrantFields(data), ALLOWED_GRANT_COLUMNS);

    // Stringify JSON fields
    if (sanitizedData.match_reasons && Array.isArray(sanitizedData.match_reasons)) {
      sanitizedData.match_reasons = JSON.stringify(sanitizedData.match_reasons);
    }
    if (sanitizedData.matched_needs && Array.isArray(sanitizedData.matched_needs)) {
      sanitizedData.matched_needs = JSON.stringify(sanitizedData.matched_needs);
    }
    if (sanitizedData.ineligibility_reasons && Array.isArray(sanitizedData.ineligibility_reasons)) {
      sanitizedData.ineligibility_reasons = JSON.stringify(sanitizedData.ineligibility_reasons);
    }

    // Populate canonical url + fingerprint + neutral match_decision if the
    // caller didn't supply them. The matchEngine path is the primary
    // producer of these fields, but the POST /grants endpoint is used for
    // manual grant creation + seed scripts and must leave the same invariant
    // intact (every grant row has a url+fingerprint+match_decision).
    if (!sanitizedData.url) {
      const picked = chooseGrantUrl({
        url: data.url,
        application_url: sanitizedData.application_url ?? data.applicationUrl,
        portal_url: sanitizedData.portal_url ?? data.portalUrl,
      })
      if (picked) sanitizedData.url = picked
    }
    if (!sanitizedData.fingerprint) {
      sanitizedData.fingerprint = grantFingerprintFromOpportunity({
        title: sanitizedData.title ?? data.title,
        sponsor: sanitizedData.funder ?? data.funder,
        deadline: sanitizedData.deadline ?? data.deadline,
        url: sanitizedData.url,
      })
      sanitizedData.fingerprint_version = sanitizedData.fingerprint_version ?? GRANT_FINGERPRINT_VERSION
    }
    if (!sanitizedData.match_decision) {
      sanitizedData.match_decision = 'review'
    }
    if (sanitizedData.matched_needs === undefined || sanitizedData.matched_needs === null) {
      sanitizedData.matched_needs = '[]'
    }

    // DISMISSED gate (sticky deletes). Mirrors saveToProfilePipeline's Gate 1.5
    // so this direct-create path can't resurrect a source the user deleted from
    // a profile pipeline. Manual re-add goes through /from-opportunity, which
    // clears the tombstone first; this raw create is not that path, so it stays
    // suppressed. Best-effort — a tombstone lookup error must not block creation
    // (recall over suppression).
    if (sanitizedData.profile_id) {
      try {
        // Pass an opportunity-shaped object (no `fingerprint` key) so findDismissal
        // builds the full match key itself (fingerprint + opportunity_id + title).
        const wasDismissed = await isDismissedFromPipeline(req.db, sanitizedData.profile_id, {
          id: sanitizedData.funding_opportunity_id ?? null,
          title: sanitizedData.title ?? data.title ?? null,
          sponsor: sanitizedData.funder ?? data.funder ?? null,
          deadline: sanitizedData.deadline ?? data.deadline ?? null,
          application_url: sanitizedData.application_url ?? null,
          url: sanitizedData.url ?? null,
        })
        if (wasDismissed) {
          routeLogger.info('[grants/create] blocked DISMISSED resurrection', {
            profile_id: sanitizedData.profile_id,
            title: sanitizedData.title ?? data.title,
          })
          return res.status(409).json({
            error: 'dismissed',
            message: 'This source was previously removed from the pipeline. Re-add it from the opportunity to bring it back.',
          })
        }
      } catch (dismissErr) {
        routeLogger.warn('[grants/create] dismissal check failed (non-fatal)', { error: dismissErr?.message })
      }

      // Duplicate guard (profile-scoped). The gated saver and /from-opportunity
      // both refuse to add an opportunity already in a profile's pipeline; this
      // raw manual-create path must not be a back door for duplicates either.
      // Match the same keys /from-opportunity uses: funding_opportunity_id, or
      // (NULL opportunity-id AND title), or application_url. We return the
      // existing row (200-style "already in pipeline") rather than inserting a
      // second copy. NOTE: we intentionally do NOT add a below-floor block here
      // — NULL / low match_score is valid for manually-created grants
      // (canonical_rules.md: NULL is never junk; user-created rows are
      // protected), and the boot relevance-floor sweep is the net for junk.
      try {
        const dupParams = [String(sanitizedData.profile_id)]
        const dupMatch = []
        if (sanitizedData.funding_opportunity_id) {
          dupMatch.push('funding_opportunity_id = ?')
          dupParams.push(String(sanitizedData.funding_opportunity_id))
        }
        const dupTitle = sanitizedData.title ?? data.title ?? null
        if (dupTitle) {
          dupMatch.push('(funding_opportunity_id IS NULL AND title = ?)')
          dupParams.push(String(dupTitle))
        }
        if (sanitizedData.application_url) {
          dupMatch.push('application_url = ?')
          dupParams.push(String(sanitizedData.application_url))
        }
        if (dupMatch.length > 0) {
          const existingGrant = await req.db
            .prepare(
              `SELECT * FROM grants WHERE profile_id = ? AND (${dupMatch.join(' OR ')}) LIMIT 1`,
            )
            .get(...dupParams)
          if (existingGrant) {
            routeLogger.info('[grants/create] duplicate suppressed — already in pipeline', {
              profile_id: sanitizedData.profile_id,
              grant_id: existingGrant.id,
            })
            return res.status(200).json({ ...existingGrant, already_exists: true, message: 'Grant already in pipeline' })
          }
        }
      } catch (dupErr) {
        routeLogger.warn('[grants/create] duplicate check failed (non-fatal)', { error: dupErr?.message })
      }
    }

    const columns = ['id', ...Object.keys(sanitizedData)]
    // sanitizeColumns() already filters to ALLOWED_GRANT_COLUMNS; belt-and-
    // suspenders validation via assertSafeIdentifier at the call site so a
    // future refactor of sanitizeColumns can't regress SQL safety.
    const safeColumns = columns.map((c) => assertSafeIdentifier(c, 'identifier'))
    const placeholders = safeColumns.map(() => '?').join(', ')
    const values = [id, ...Object.values(sanitizedData)]

    // audit:allow unscoped-profile-query -- direct grant creation may be organization-scoped; profile_id is included when supplied.
    await req.db.prepare(`
      INSERT INTO grants (${safeColumns.join(', ')})
      VALUES (${placeholders})
    `).run(...values) // audit:allow dynamic-sql
    
    const grant = await req.db.prepare('SELECT * FROM grants WHERE id = ?').get(id);
    res.status(201).json(grant);
  } catch (error) {
    if (isUniqueGrantConflict(error)) {
      try {
        const body = normalizeGrantFields(req.body || {})
        const existingGrant = await findExistingGrantByProfileOpportunity(
          req.db,
          body.profile_id,
          body.funding_opportunity_id,
        )
        if (existingGrant) {
          routeLogger.info('[grants/create] duplicate suppressed after unique conflict', {
            profile_id: existingGrant.profile_id || null,
            grant_id: existingGrant.id,
          })
          return res.status(200).json({
            ...existingGrant,
            already_exists: true,
            message: 'Grant already in pipeline',
          })
        }
      } catch (lookupErr) {
        routeLogger.warn('[grants/create] duplicate lookup failed', { error: lookupErr?.message || String(lookupErr) })
      }
    }
    console.error('Error creating grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Update grant
router.put('/:id', mutationRateLimiter, async (req, res) => {
  try {
    await ensureGrantAiColumns(req.db)
    const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
    if (!grantAccess) return

    const data = req.body;
    
    // Normalize frontend aliases → canonical column names, then sanitize
    const sanitizedData = sanitizeColumns(normalizeGrantFields(data), ALLOWED_GRANT_COLUMNS);
    
    if (Object.keys(sanitizedData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    // Stringify JSON fields
    if (sanitizedData.match_reasons && Array.isArray(sanitizedData.match_reasons)) {
      sanitizedData.match_reasons = JSON.stringify(sanitizedData.match_reasons);
    }
    
    const safeSetClause = Object.keys(sanitizedData)
      .map((key) => `${assertSafeIdentifier(key, 'identifier')} = ?`)
      .join(', ')
    const values = [...Object.values(sanitizedData), req.params.id, grantAccess.profile_id ?? null];

    await req.db.prepare(`
      UPDATE grants 
      SET ${safeSetClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
        AND (profile_id = ? OR profile_id IS NULL)
    `).run(...values);
    
    const grant = await req.db
      .prepare('SELECT * FROM grants WHERE id = ? AND (profile_id = ? OR profile_id IS NULL)')
      .get(req.params.id, grantAccess.profile_id ?? null);
    res.json(grant);
  } catch (error) {
    console.error('Error updating grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Update grant status (quick update for drag-and-drop)
router.patch('/:id/status', mutationRateLimiter, async (req, res) => {
  try {
    const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
    if (!grantAccess) return

    const { status } = req.body;

    if (!GRANT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await req.db.prepare(`
      UPDATE grants
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND (profile_id = ? OR profile_id IS NULL)
    `).run(status, req.params.id, grantAccess.profile_id ?? null);

    const grant = await req.db
      .prepare('SELECT * FROM grants WHERE id = ? AND (profile_id = ? OR profile_id IS NULL)')
      .get(req.params.id, grantAccess.profile_id ?? null);

    // Non-blocking: when a grant is marked as applied, extract opportunity signals.
    if (status === 'applied' && grant?.profile_id && grant?.funding_opportunity_id) {
      ;(async () => {
        try {
          const opp = await req.db
            .prepare('SELECT categories, keywords, need_types_supported FROM funding_opportunities WHERE id = ?')
            .get(grant.funding_opportunity_id)
          if (opp) {
            await mergeOpportunitySignals(req.db, grant.profile_id, opp, 'apply')
          }
        } catch {
          // Signal merge must not affect the status update response.
        }
      })()
    }

    // Non-blocking: when a grant becomes awarded/approved, best-effort parse its
    // free-text fields for restriction phrases ("$X must be spent on supplies",
    // "spend within N days") and pre-create DRAFT compliance rules the owner can
    // confirm/edit. NEVER invents numbers; creates nothing when nothing is
    // parseable. Fully isolated so it can never break the status update.
    if ((status === 'awarded' || status === 'approved') && grant?.profile_id) {
      ;(async () => {
        try {
          const { deriveDraftRulesForGrant } = await import(
            '../services/awardCompliance/awardComplianceStore.js'
          )
          await deriveDraftRulesForGrant(req.db, grant, { createdBy: 'grant-status-awarded' })
        } catch {
          // Compliance rule derivation must not affect the status update response.
        }
      })()
    }

    res.json(grant);
  } catch (error) {
    console.error('Error updating grant status:', error);
    res.status(500).json(formatError(error));
  }
});

// Delete grant
router.delete('/:id', mutationRateLimiter, async (req, res) => {
  try {
    const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
    if (!grantAccess) return

    // Capture the row BEFORE we delete so we can record a tombstone in
    // pipeline_dismissals — that's what makes deletes sticky across
    // matcher / Process All / re-crawl runs.
    let grantRow = null
    let opportunityRow = null
    try {
      grantRow = await req.db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(req.params.id)
      if (grantRow?.funding_opportunity_id) {
        try {
          opportunityRow = await req.db
            .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
            .get(grantRow.funding_opportunity_id)
        } catch (oppErr) {
          // Source opportunity may have been purged; tombstone still records by
          // fingerprint + title + url so the matcher won't re-add it.
          routeLogger.warn('[grants/delete] failed to load source opportunity for tombstone', {
            error: oppErr?.message || String(oppErr),
            opportunity_id: grantRow.funding_opportunity_id,
          })
        }
      }
    } catch (rowErr) {
      routeLogger.warn('[grants/delete] failed to load grant row for tombstone', {
        error: rowErr?.message || String(rowErr),
        grant_id: req.params.id,
      })
    }

    // Delete related records first
    await req.db.prepare('DELETE FROM milestones WHERE grant_id = ?').run(req.params.id);
    await req.db.prepare('DELETE FROM expenses WHERE grant_id = ?').run(req.params.id);
    await req.db.prepare('DELETE FROM application_drafts WHERE grant_id = ?').run(req.params.id);

    // Update documents to remove grant_id
    await req.db.prepare('UPDATE documents SET grant_id = NULL WHERE grant_id = ?').run(req.params.id);

    // Delete the grant
    await req.db.prepare('DELETE FROM grants WHERE id = ?').run(req.params.id);

    // Now write the tombstone. Best-effort — failure here must not turn
    // the delete into a 500. Only record when the deleted grant was
    // attached to a profile (organization-only legacy rows can't be
    // matched back to an auto-add path).
    if (grantRow?.profile_id) {
      try {
        const result = await recordPipelineDismissal(req.db, {
          profileId: grantRow.profile_id,
          grantRow,
          opportunity: opportunityRow,
          userId: req.user?.userId ?? req.user?.id ?? null,
          reason: 'user_deleted_from_pipeline',
        })
        routeLogger.info('[grants/delete] pipeline dismissal recorded', {
          grant_id: req.params.id,
          profile_id: grantRow.profile_id,
          already_existed: Boolean(result?.alreadyExisted),
          fingerprint_present: Boolean(result?.key?.fingerprint),
        })
      } catch (tombErr) {
        routeLogger.error('[grants/delete] failed to record tombstone (delete still succeeded)', {
          error: tombErr?.message || String(tombErr),
          grant_id: req.params.id,
          profile_id: grantRow.profile_id,
        })
      }
    }

    res.json({ success: true, message: 'Grant deleted' });
  } catch (error) {
    console.error('Error deleting grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Add grant from opportunity (supports both database opportunities and direct data)
router.post('/from-opportunity', async (req, res, next) => {
  const requestId = req.requestId || req.request_id || null
  
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    // Self-heal schema drift before we read/insert profile-scoped grants.
    await ensureGrantAiColumns(req.db)

    let {
      opportunity_id, 
      organization_id, 
      profile_id, 
      match_score, 
      match_reasons,
      // Direct opportunity data (for synthetic/discovered opportunities)
      opportunity_data
    } = req.body;

    // Enhanced input validation with detailed error messages
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Request body must be a valid JSON object.',
        requestId,
      })
    }

    const normalizedProfileId = profile_id ? String(profile_id) : null
    const normalizedOrgId = organization_id ? String(organization_id) : null

    if (!normalizedProfileId && !normalizedOrgId) {
      return res.status(400).json({
        error: 'missing_required_field',
        message: 'Provide profile_id (preferred) or organization_id to add a grant to the pipeline.',
        requestId,
      })
    }

    // Validate opportunity data if provided
    if (!opportunity_id && opportunity_data) {
      if (typeof opportunity_data !== 'object' || Array.isArray(opportunity_data)) {
        return res.status(400).json({
          error: 'invalid_opportunity_data',
          message: 'opportunity_data must be a valid object.',
          requestId,
        })
      }
      
      // Validate required fields in opportunity_data
      const title = opportunity_data.title ? String(opportunity_data.title).trim() : ''
      if (!title) {
        return res.status(400).json({
          error: 'missing_opportunity_title',
          message: 'opportunity_data.title is required when adding a grant from opportunity data.',
          requestId,
        })
      }
    }

    // Validate that at least one way to identify an opportunity exists
    if (!opportunity_id && !opportunity_data) {
      return res.status(400).json({
        error: 'missing_opportunity',
        message: 'Provide either opportunity_id or opportunity_data to add a grant to the pipeline.',
        requestId,
      })
    }

    // Authorization:
    // - If profile_id provided, profile access is the source of truth (org may be auto-created/linked).
    // - If only organization_id provided, require org access.
    try {
      if (normalizedProfileId) {
        if (!(await ensureProfileAccess(req, res, normalizedProfileId))) return
      } else if (normalizedOrgId) {
        if (!(await ensureOrganizationAccess(req, res, normalizedOrgId))) return
      }

      // If a caller provided organization_id explicitly (even alongside profile_id),
      // enforce org access using the real request context. This avoids passing synthetic
      // req objects that can crash (missing req.db/req.ctx) and cause 500s.
      if (normalizedOrgId) {
        if (!(await ensureOrganizationAccess(req, res, normalizedOrgId))) return
      }
    } catch (accessError) {
      console.error('[grants/from-opportunity] access control check failed', {
        requestId,
        profile_id: normalizedProfileId,
        organization_id: normalizedOrgId,
        error: accessError?.message || String(accessError),
        stack: accessError?.stack || null,
      })
      return res.status(500).json({
        error: 'access_control_error',
        message: 'Failed to verify access permissions. Please try again.',
        requestId,
      })
    }
    
    // Try to get opportunity from database first
    let opportunity = null;
    let resolvedOpportunityId = null;  // Track the actual opportunity ID to use
    if (opportunity_id) {
      routeLogger.info('[grants/from-opportunity] Attempting to fetch opportunity from DB', {
        requestId,
        opportunity_id,
        has_fallback_data: Boolean(opportunity_data),
      })
      try {
        opportunity = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunity_id);
        if (opportunity) {
          resolvedOpportunityId = opportunity_id;
          routeLogger.info('[grants/from-opportunity] Found opportunity in DB', {
            requestId,
            opportunity_id,
            title: opportunity.title,
          })
        } else if (!opportunity_data) {
          // opportunity_id provided but not found, and no fallback data
          console.warn('[grants/from-opportunity] opportunity_id not found and no fallback', {
            requestId,
            opportunity_id,
          })
          return res.status(404).json({
            error: 'opportunity_not_found',
            message: 'The specified opportunity_id was not found in the database.',
            requestId,
          })
        } else {
          routeLogger.info('[grants/from-opportunity] opportunity_id not found, using fallback data', {
            requestId,
            opportunity_id,
          })
        }
        // If opportunity not found but opportunity_data is provided, we'll use the fallback below
      } catch (dbError) {
        console.error('[grants/from-opportunity] failed to fetch opportunity', {
          requestId,
          opportunity_id,
          error: dbError?.message || String(dbError),
        })
        return res.status(500).json({
          error: 'database_error',
          message: 'Failed to fetch opportunity from database. Please try again.',
          requestId,
        })
      }
    }
    
    // If not found in DB, use provided opportunity_data
    if (!opportunity && opportunity_data) {
      try {
        const rawDeadline = opportunity_data.deadline || opportunity_data.deadlineAt || null
        const normalizedDeadline = normalizeDateForDb(rawDeadline)
        const amountMin = normalizeMoney(opportunity_data.awardMin ?? opportunity_data.amount_min ?? null)
        const amountMax = normalizeMoney(opportunity_data.awardMax ?? opportunity_data.amount_max ?? null)
        const applicationUrl = coerceString(opportunity_data.url || opportunity_data.application_url, { maxLen: 2000 })
        const title = coerceString(opportunity_data.title, { maxLen: 500 })
        if (!title) {
          return res.status(400).json({
            error: 'missing_opportunity_title',
            message: 'Opportunity title is required',
            requestId,
          })
        }

        opportunity = {
          title,
          sponsor: coerceString(opportunity_data.sponsor, { maxLen: 500 }),
          deadline_raw: rawDeadline,
          deadline: normalizedDeadline,
          deadline_type: coerceString(opportunity_data.deadline_type, { maxLen: 50 }) || null,
          application_url: applicationUrl,
          amount_min: amountMin,
          amount_max: amountMax,
          description: coerceString(opportunity_data.descriptionMd || opportunity_data.description, { maxLen: 50_000 }),
          eligibility_bullets: JSON.stringify(coerceArray(opportunity_data.eligibilityBullets)),
          source: coerceString(opportunity_data.source, { maxLen: 200 }) || 'discovery',
          // Preserve provenance so the pipeline source gate and any profile-scoped
          // persistence below see the real origin (e.g. 'web_search' leads).
          record_origin: coerceString(opportunity_data.record_origin, { maxLen: 100 }) || null,
          state: coerceString(opportunity_data.state, { maxLen: 100 }) || null,
          source_id: coerceString(opportunity_data.source_id || opportunity_data.url || opportunity_data.application_url, { maxLen: 2000 }) || null,
          opportunity_type: coerceString(opportunity_data.opportunity_type, { maxLen: 100 }) || null,
          contact_info: opportunity_data.contact_info || null,
          application_method: coerceString(opportunity_data.application_method, { maxLen: 100 }) || null,
          applicationNote: coerceString(opportunity_data.applicationNote, { maxLen: 2000 }) || null,
        };
        routeLogger.info('[grants/from-opportunity] Using direct opportunity data for:', opportunity.title);
      } catch (parseError) {
        console.error('[grants/from-opportunity] failed to parse opportunity_data', {
          requestId,
          error: parseError?.message || String(parseError),
          stack: parseError?.stack || null,
        })
        return res.status(400).json({
          error: 'invalid_opportunity_data',
          message: 'Failed to parse opportunity data. Please check the format and try again.',
          requestId,
        })
      }
    }
    
    if (!opportunity) {
      return res.status(404).json({ error: 'Opportunity not found and no opportunity_data provided' });
    }

    // Back-compat for existing scholarship web-discovery rows. The canonical
    // provenance for user-reviewed live web leads is web_search; web_llm was a
    // source label from the extraction implementation, not a separate trust tier.
    if (String(opportunity.source || '').toLowerCase() === 'web_llm' ||
        String(opportunity.record_origin || '').toLowerCase() === 'web_llm') {
      opportunity = {
        ...opportunity,
        source: 'web_search',
        record_origin: 'web_search',
      }
    }

    // Canonical trust gate: refuse to silently accept placeholder URLs, known
    // junk origins, or loans (unless explicitly opted in) into a user's
    // pipeline. This mirrors what discovery/matching already filter on the
    // display side, so the display/save contract is the same.
    const {
      allow_loans: allowLoansBody = false,
      allow_matching_funds: allowMatchingFundsBody = false,
      allow_expired: allowExpiredBody = false,
      auto_add: autoAddBody = false,
    } = req.body || {}
    const isAutomaticAdd = autoAddBody === true || String(autoAddBody).toLowerCase() === 'true'
    const pipelineGate = gateOpportunityForPipeline(opportunity, {
      allowLoans: Boolean(allowLoansBody),
      allowMatchingFunds: Boolean(allowMatchingFundsBody),
      allowExpired: Boolean(allowExpiredBody),
      allowDirectory: true,
    })
    if (!pipelineGate.allowed) {
      routeLogger.info('[grants/from-opportunity] blocked by trust gate', {
        requestId,
        profile_id: normalizedProfileId,
        organization_id: normalizedOrgId,
        opportunity_id: resolvedOpportunityId,
        reason: pipelineGate.reason,
        trust_flags: pipelineGate.trust?.flags,
        trust_reasons: pipelineGate.trust?.reasons,
      })
      return res.status(400).json({
        error: 'opportunity_not_trustworthy',
        message:
          pipelineGate.reason === 'no_real_url'
            ? 'This opportunity has no working URL and cannot be added to your pipeline.'
            : pipelineGate.reason === 'placeholder_content'
              ? 'This opportunity looks like placeholder/test data and cannot be saved.'
              : pipelineGate.reason === 'loan_like'
                ? 'This entry is a loan, which is not added to your grant pipeline by default. Retry with allow_loans=true to override.'
                : pipelineGate.reason === 'matching_funds_required'
                  ? 'This program requires matching funds. Retry with allow_matching_funds=true to save it anyway.'
                  : pipelineGate.reason && String(pipelineGate.reason).startsWith('untrusted_origin')
                    ? 'This opportunity comes from an origin that is not trusted for pipeline saves.'
                    : 'This opportunity cannot be added to your pipeline because it failed the trust check.',
        reason: pipelineGate.reason,
        trust_flags: pipelineGate.trust?.flags ?? null,
        requestId,
      })
    }
    // Remember so we can serialize a trust summary into match_reasons below.
    const pipelineTrustMeta = buildTrustMetadata(pipelineGate.trust)

    // Guardrail: block pipeline inserts from clearly-untrusted provenance
    // (denied source markers or untrusted record_origin).
    //
    // Per project rules, this is intentionally a denylist + provenance check
    // rather than a hard allowlist. Any opportunity coming from a trusted
    // crawler origin (live_crawl, curated_verified, geo_crawl, etc.) — or
    // whose source label looks like a real funding-domain identifier — is
    // permitted into pipelines, so directory-style and domain-crawler
    // resources surface to users instead of returning 400 (Goal 7).
    const opportunitySource = opportunity.source ? String(opportunity.source).trim() : null
    const opportunityRecordOrigin = opportunity.record_origin
      ? String(opportunity.record_origin).trim()
      : null
    const sourceGate = evaluatePipelineSource({
      source: opportunitySource,
      record_origin: opportunityRecordOrigin,
    })
    if (!sourceGate.allowed) {
      routeLogger.info('[grants/from-opportunity] blocked by source gate', {
        requestId,
        profile_id: normalizedProfileId,
        organization_id: normalizedOrgId,
        opportunity_id: resolvedOpportunityId,
        reason: sourceGate.reason,
        source: opportunitySource,
        record_origin: opportunityRecordOrigin,
      })
      const messageByReason = {
        denied_source:
          'This funding source is on the explicit pipeline denylist (synthetic / placeholder / spam).',
        untrusted_origin:
          'This opportunity comes from an origin that is not trusted for pipeline saves.',
        unknown_source:
          'This opportunity has an unrecognised source. Please report it so we can verify the crawler.',
        missing_source:
          'This opportunity has no source provenance and cannot be added to your pipeline.',
      }
      return res.status(400).json({
        error: 'source_not_allowed',
        message:
          messageByReason[sourceGate.reason] ||
          'This funding source is not approved for individual pipelines.',
        reason: sourceGate.reason,
        source: opportunitySource,
        record_origin: opportunityRecordOrigin,
        requestId,
      })
    }

    // Symmetry with /api/matching/profile/:id/opportunities: refuse pipeline
    // inserts whose explicit applicant-type eligibility hard-conflicts with
    // the target profile (e.g. trying to save NSF research-institution
    // grants into an individual profile's pipeline). Without this gate, the
    // matcher would drop them silently while POST /from-opportunity would
    // happily save them, creating a UX divergence between Discover and
    // Pipeline. We only look up applicant_type when we have a profile id —
    // organisation-only saves take a different code path below.
    if (normalizedProfileId) {
      try {
        const targetProfileRow = await req.db
          .prepare(
            'SELECT applicant_type, primary_type, primary_profile_type FROM profiles WHERE id = ?',
          )
          .get(normalizedProfileId)
        const profileApplicantType =
          targetProfileRow?.applicant_type ??
          targetProfileRow?.primary_type ??
          targetProfileRow?.primary_profile_type ??
          null
        // A profile can hold more than one identity (a person who also runs a
        // farm). Load the sections that structurally DECLARE a second one so
        // this 400 can never fire on an identity we simply never looked at —
        // the Anita class, 2026-08-01.
        const identitySections = {}
        try {
          const secRows = await req.db
            .prepare(
              `SELECT section_key, data FROM profile_sections
               WHERE profile_id = ? AND section_key IN ('occupation', 'small_business_details', 'organization_details', 'basic_information')`,
            )
            .all(normalizedProfileId)
          for (const sec of secRows || []) {
            if (!sec?.data) continue
            try {
              identitySections[sec.section_key] =
                typeof sec.data === 'string' ? JSON.parse(sec.data) : sec.data
            } catch { /* unparseable section — never guess */ }
          }
        } catch { /* profile_sections unavailable — fall back to the type alone */ }

        if (profileApplicantType || Object.keys(identitySections).length > 0) {
          const eligDecision = evaluateApplicantTypeEligibility(opportunity, profileApplicantType, {
            profile: targetProfileRow,
            sections: identitySections,
          })
          if (eligDecision.decision === 'mismatch') {
            routeLogger.info('[grants/from-opportunity] blocked by applicant-type gate', {
              requestId,
              profile_id: normalizedProfileId,
              opportunity_id: resolvedOpportunityId,
              applicant_type: profileApplicantType,
              reason: eligDecision.reason,
            })
            return res.status(400).json({
              error: 'ineligible_for_profile',
              message:
                'This opportunity is restricted to applicant types that do not match the selected profile (e.g. institutions of higher education, federal agencies, or 501(c)(3) organisations only).',
              reason: eligDecision.reason,
              applicant_type: profileApplicantType,
              opportunity_id: resolvedOpportunityId,
              requestId,
            })
          }
        }
      } catch (eligErr) {
        // Eligibility lookup failure is non-fatal — fall through and let the
        // existing trust / source / readiness gates make the call. Logged
        // for traceability per project rule on lightweight logging.
        routeLogger.warn('[grants/from-opportunity] applicant-type lookup failed', {
          requestId,
          profile_id: normalizedProfileId,
          error: eligErr?.message || String(eligErr),
        })
      }
    }

    // Profession-lock gate (first line of defense; the boot sweep
    // enforceProfileEligibility is the net). Refuse to promote an opportunity
    // LOCKED to a licensed profession the target profile does not practise —
    // e.g. an "Ohio Nurses Foundation" scholarship into a PARAMEDIC student's
    // pipeline. Conservative: only fires when BOTH the profile resolves to a
    // recognised profession AND the opportunity's IDENTITY (title + funder) is
    // locked to a DIFFERENT one. Non-fatal — any lookup failure falls through.
    if (normalizedProfileId) {
      try {
        const {
          professionSignalTextFromSections, resolveProfileProfessions,
          opportunityLockText, assessProfessionEligibility,
        } = await import('../services/eligibility/professionEligibility.js')
        const secs = await req.db
          .prepare("SELECT section_key, data FROM profile_sections WHERE profile_id = ? AND section_key IN ('basic_information','education','employment','career','professional')")
          .all(normalizedProfileId)
        const sectionsByKey = {}
        for (const s of secs || []) sectionsByKey[s.section_key] = s.data
        const professions = resolveProfileProfessions(professionSignalTextFromSections(sectionsByKey))
        const professionVerdict = assessProfessionEligibility({
          itemText: opportunityLockText(opportunity),
          professions,
        })
        if (professionVerdict.ineligible) {
          routeLogger.info('[grants/from-opportunity] blocked by profession-lock gate', {
            requestId,
            profile_id: normalizedProfileId,
            opportunity_id: resolvedOpportunityId,
            lock: professionVerdict.lock,
          })
          return res.status(400).json({
            error: 'ineligible_for_profile',
            message:
              'This opportunity is restricted to a professional field that does not match the selected profile (for example, a nursing-only scholarship for a paramedic student).',
            reason: professionVerdict.reason,
            profession_lock: professionVerdict.lock,
            opportunity_id: resolvedOpportunityId,
            requestId,
          })
        }
      } catch (profErr) {
        routeLogger.warn('[grants/from-opportunity] profession-lock gate lookup failed', {
          requestId,
          profile_id: normalizedProfileId,
          error: profErr?.message || String(profErr),
        })
      }
    }

    // Guardrail: don't allow expired opportunities into pipelines.
    // Directory-style resources are allowed; rolling/ongoing deadlines are allowed.
    const stripOrdinalSuffixes = (value) => {
      const text = typeof value === 'string' ? value : String(value ?? '')
      return text.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    }
    const parseLooseDate = (value) => {
      if (!value) return null
      const raw = typeof value === 'string' ? value.trim() : String(value).trim()
      if (!raw) return null
      const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
      if (iso) {
        const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`)
        return Number.isNaN(d.getTime()) ? null : d
      }
      const cleaned = stripOrdinalSuffixes(raw).replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
      const d = new Date(cleaned)
      return Number.isNaN(d.getTime()) ? null : d
    }
    const isDirectoryLike = (row) => {
      const type = String(row?.type || '').trim().toUpperCase()
      if (type === 'DIRECTORY') return true
      const origin = String(row?.record_origin || '').trim().toLowerCase()
      if (origin.includes('directory')) return true
      const oppType = String(row?.opportunity_type || '').trim().toLowerCase()
      return oppType.includes('directory')
    }
    const deadlineType = String(opportunity.deadline_type || '').trim().toLowerCase()
    const expired = (() => {
      if (isDirectoryLike(opportunity)) return false
      if (deadlineType === 'rolling' || deadlineType === 'ongoing') return false
      const deadlineValue = opportunity.deadline_raw ?? opportunity.deadline
      const d = parseLooseDate(deadlineValue)
      if (!d) return false
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      return d.getTime() < today.getTime()
    })()
    if (expired) {
      return res.status(400).json({
        error: 'opportunity_expired',
        message: 'This funding opportunity appears to be expired and cannot be added to the pipeline.',
        deadline: opportunity.deadline ?? null,
        deadline_type: opportunity.deadline_type ?? null,
      })
    }
    
    // Shared-catalog persistence of web-discovered LEADS. When a user saves a
    // web_search lead (it isn't in the catalog: resolvedOpportunityId is null),
    // promote it to a real funding_opportunities row in the shared catalog
    // (profile_id stays NULL). The profile's match/pipeline rows remain scoped
    // below, so a real web lead can teach the catalog without being treated as
    // accepted for unrelated profiles. upsertFundingOpportunity runs quality,
    // policy, validation, reviewer, and reality gates before any catalog write.
    const isWebLead =
      !resolvedOpportunityId &&
      normalizedProfileId &&
      (String(opportunity.record_origin || '').toLowerCase() === 'web_search' ||
        String(opportunity.source || '').toLowerCase() === 'web_search')
    if (isWebLead) {
      try {
        const persisted = await upsertFundingOpportunity(
          req.db,
          {
            ...opportunity,
            source: 'web_search',
            record_origin: 'web_search',
            source_id: opportunity.source_id || opportunity.application_url || null,
            opportunity_type: opportunity.opportunity_type || 'program',
            is_active: 1,
            profile_id: null,
          },
          { allowDirectories: true },
        )
        if (persisted?.id) {
          resolvedOpportunityId = persisted.id
          routeLogger.info('[grants/from-opportunity] persisted web lead in shared catalog', {
            requestId,
            profile_id: normalizedProfileId,
            opportunity_id: persisted.id,
          })
        } else {
          routeLogger.info('[grants/from-opportunity] web lead not persisted (gated); refusing pipeline save', {
            requestId,
            reason: persisted?.reason ?? 'unknown',
          })
          return res.status(422).json({
            error: 'web_lead_rejected',
            message: 'This web-discovered funding lead did not pass GrantFlow quality/reality gates, so it was not added to the profile pipeline.',
            reason: persisted?.reason ?? 'unknown',
          })
        }
      } catch (persistErr) {
        routeLogger.warn('[grants/from-opportunity] web lead persistence failed; refusing pipeline save', {
          requestId,
          error: persistErr?.message || String(persistErr),
        })
        return res.status(503).json({
          error: 'web_lead_persistence_failed',
          message: 'GrantFlow could not verify and catalog this web-discovered lead, so it was not added to the profile pipeline.',
        })
      }
    }

    // Profile-scoped adds must pass the same canonical profile gate as every
    // crawler auto-add. A real but weak/non-matching crawler return may stay in
    // funding_opportunities, but it must not become a grant pipeline row for
    // this profile unless saveToProfilePipeline accepts it.
    if (normalizedProfileId) {
      let profileContext = null
      try {
        profileContext = await loadProfileContext(req.db, normalizedProfileId)
      } catch (ctxErr) {
        routeLogger.warn('[grants/from-opportunity] profile context load failed; saver will use minimal context', {
          requestId,
          profile_id: normalizedProfileId,
          error: ctxErr?.message || String(ctxErr),
        })
        profileContext = { profile: { id: normalizedProfileId }, sections: null }
      }

      const pipelineOpportunity = {
        ...opportunity,
        id: resolvedOpportunityId || opportunity.id || opportunity_id || null,
        sponsor: opportunity.sponsor || opportunity.funder || null,
        application_url: opportunity.application_url || opportunity.apply_url || null,
        url: opportunity.url || opportunity.source_url || opportunity.application_url || opportunity.apply_url || null,
      }

      const isSourceOnlyDirect =
        !pipelineOpportunity.application_url &&
        !String(pipelineOpportunity.opportunity_kind || pipelineOpportunity.result_kind || pipelineOpportunity.type || '').toLowerCase().includes('directory')
      if (isSourceOnlyDirect) {
        return res.status(422).json({
          error: 'missing_application_url',
          message: 'This result has a source link but no application link yet. Visit the source to verify the application path before adding it to the pipeline.',
        })
      }

      let pipelineResult = await saveToProfilePipeline(
        req.db,
        pipelineOpportunity,
        normalizedProfileId,
        profileContext,
        null,
        undefined,
      )

      if (pipelineResult?.gate === 'DISMISSED') {
        const cleared = await clearPipelineDismissal(req.db, normalizedProfileId, pipelineOpportunity)
        if (cleared > 0) {
          routeLogger.info('[grants/from-opportunity] cleared dismissal before canonical retry', {
            requestId,
            profile_id: normalizedProfileId,
            opportunity_id: resolvedOpportunityId || null,
            cleared_count: cleared,
          })
          pipelineResult = await saveToProfilePipeline(
            req.db,
            pipelineOpportunity,
            normalizedProfileId,
            profileContext,
            null,
            undefined,
          )
        }
      }

      if (pipelineResult?.saved && pipelineResult.pipelineId) {
        await ensureGrantAiColumns(req.db)
        const grant = await loadGrantByIdForProfileAwareResponse(req.db, pipelineResult.pipelineId, normalizedProfileId)
        routeLogger.info('[grants/from-opportunity] canonical saver added pipeline row', {
          requestId,
          profile_id: normalizedProfileId,
          grant_id: pipelineResult.pipelineId,
          opportunity_id: resolvedOpportunityId || null,
          matchPercentage: pipelineResult.matchPercentage ?? null,
          decision: pipelineResult.decision ?? null,
        })
        if (normalizedProfileId && opportunity) {
          Promise.resolve(mergeOpportunitySignals(req.db, normalizedProfileId, opportunity, 'save')).catch(() => {})
          recordBehaviorEvent(req.db, {
            profileId: normalizedProfileId,
            action: 'saved',
            opportunity,
          }).catch(() => {})
        }
        Promise.resolve(scheduleGrantApplicationApproach({ db: req.db, grantId: pipelineResult.pipelineId }))
          .catch((advisorErr) => {
            routeLogger.warn('[grants/from-opportunity] approach advisor failed after canonical save', {
              requestId,
              grant_id: pipelineResult.pipelineId,
              error: advisorErr?.message || String(advisorErr),
            })
          })
        return res.status(201).json({
          ...(grant || {}),
          id: grant?.id || pipelineResult.pipelineId,
          organization_id: grant?.organization_id ?? null,
          profile_id: normalizedProfileId,
          status: grant?.status ?? 'discovered',
          pipeline_update_status: 'added',
          match_score: grant?.match_score ?? pipelineResult.matchPercentage ?? null,
          match_decision: grant?.match_decision ?? pipelineResult.decision ?? null,
        })
      }

      if (pipelineResult?.gate === 'DUPLICATE' && pipelineResult.pipelineId) {
        await ensureGrantAiColumns(req.db)
        const existingGrant = await loadGrantByIdForProfileAwareResponse(req.db, pipelineResult.pipelineId, normalizedProfileId)
        return res.status(200).json({
          ...(existingGrant || {}),
          id: existingGrant?.id || pipelineResult.pipelineId,
          already_exists: true,
          status: existingGrant?.status ?? 'discovered',
          pipeline_update_status: 'already',
          message: 'Grant already in pipeline',
        })
      }

      if (isAutomaticAdd) {
        routeLogger.info('[grants/from-opportunity] cataloged but not auto-added to profile pipeline', {
          requestId,
          profile_id: normalizedProfileId,
          opportunity_id: resolvedOpportunityId || null,
          gate: pipelineResult?.gate || null,
          reason: pipelineResult?.reason || null,
          matchPercentage: pipelineResult?.matchPercentage ?? null,
        })
        return res.status(200).json({
          status: 'skipped',
          not_added_to_pipeline: true,
          catalog_opportunity_id: resolvedOpportunityId || null,
          gate: pipelineResult?.gate || null,
          reason: pipelineResult?.reason || 'Not a strong match for this profile',
          match_score: pipelineResult?.matchPercentage ?? null,
          threshold: pipelineResult?.threshold ?? null,
          message:
            'This source was kept in the funding catalog, but it was not added to this profile pipeline because it did not pass the profile match gates.',
          requestId,
        })
      }

      const nonDismissalGateDecline = Boolean(pipelineResult?.gate && pipelineResult?.gate !== 'DISMISSED')
      const statusCode = (nonDismissalGateDecline || pipelineResult?.gate === 'DISMISSED') ? 422 : 500
      routeLogger.info('[grants/from-opportunity] canonical saver declined manual add; not adding to profile pipeline', {
        requestId,
        profile_id: normalizedProfileId,
        opportunity_id: resolvedOpportunityId || null,
        gate: pipelineResult?.gate || null,
        reason: pipelineResult?.reason || null,
        matchPercentage: pipelineResult?.matchPercentage ?? null,
      })
      return res.status(statusCode).json({
        error: 'pipeline_gate_failed',
        status: 'not_added',
        not_added_to_pipeline: true,
        catalog_opportunity_id: resolvedOpportunityId || null,
        gate: pipelineResult?.gate || null,
        reason: pipelineResult?.reason || 'This opportunity did not pass the profile pipeline gates.',
        match_score: pipelineResult?.matchPercentage ?? null,
        threshold: pipelineResult?.threshold ?? null,
        message:
          'This source was kept in the funding catalog when possible, but it was not added to this profile pipeline because it did not pass the profile match gates.',
        requestId,
      })
    }

    // TRANSACTION: Wrap multi-step grant pipeline creation
    const result = await req.db.withTransaction(async (tx) => {
      await ensureGrantAiColumns(tx)
      const hasProfileId = await grantsHasProfileIdColumn(tx, { refresh: true })

      async function ensureOrganizationRow({ organizationId, profileRow, reason }) {
        const orgId = organizationId ? String(organizationId) : null
        if (!orgId) return { ok: false, created: false, id: null }

        // If the org already exists, do nothing.
        const existing = await tx.prepare('SELECT id, name FROM organizations WHERE id = ? LIMIT 1').get(orgId)
        if (existing?.id) return { ok: true, created: false, id: orgId }

        // Self-heal: create a minimal org row so FK inserts to grants don't hard-fail.
        // This is reversible (delete the org if it was created accidentally) and logged.
        const displayName = String(profileRow?.display_name || '').trim()
        const orgName = displayName || 'My Organization'
        const applicantType = deriveOrganizationApplicantTypeFromProfile(profileRow)

        // Some deployments have schema drift around organizations.applicant_type (enum/check constraints).
        // We try the richer insert first, then fall back to omitting applicant_type (DB default / nullable),
        // instead of hard-failing the whole pipeline insert with a 500.
        try {
          if (applicantType) {
            await tx
              .prepare(
                `
                  INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
                  VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `,
              )
              .run(orgId, orgName, applicantType)
          } else {
            await tx
              .prepare(
                `
                  INSERT INTO organizations (id, name, created_at, updated_at)
                  VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `,
              )
              .run(orgId, orgName)
          }
        } catch (insertErr) {
          console.warn('[grants] org self-heal insert failed; retrying without applicant_type', {
            requestId: req.requestId || null,
            organization_id: orgId,
            profile_id: profileRow?.id ? String(profileRow.id) : null,
            applicant_type: applicantType,
            code: insertErr?.code || null,
            message: insertErr?.message || String(insertErr),
          })
          await tx
            .prepare(
              `
                INSERT INTO organizations (id, name, created_at, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              `,
            )
            .run(orgId, orgName)
        }

        console.warn('[grants] self-healed missing organization row', {
          requestId: req.requestId || null,
          organization_id: orgId,
          profile_id: profileRow?.id ? String(profileRow.id) : null,
          reason: reason || 'unknown',
        })

        return { ok: true, created: true, id: orgId }
      }

      // Resolve organization and validate profile
      let finalOrgId = normalizedOrgId
      let finalProfileId = normalizedProfileId
      let profileRow = null

      // CRITICAL: Always validate profile exists when profile_id is provided.
      // This prevents FK violations in Postgres when the profile doesn't exist.
      // Previously, this validation was only done when organization_id was NOT provided,
      // causing 500 errors when both were provided with an invalid profile_id.
      if (finalProfileId) {
        profileRow = await tx.prepare('SELECT * FROM profiles WHERE id = ?').get(finalProfileId);
        if (!profileRow) {
          throw new Error(`Profile '${finalProfileId}' not found. Please verify the profile_id and try again.`);
        }
      }

      // If no organization_id provided, derive it from profile or create new
      if (!finalOrgId && finalProfileId) {
        if (profileRow.organization_id) {
          // Profile already has an organization
          finalOrgId = profileRow.organization_id;
        } else {
          // Create organization for this profile
          const orgId = crypto.randomUUID();
          const applicantType = deriveOrganizationApplicantTypeFromProfile(profileRow)
          // Same schema-drift tolerance as ensureOrganizationRow: prefer applicant_type, but fall back safely.
          try {
            if (applicantType) {
              await tx
                .prepare(
                  `
                    INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                  `,
                )
                .run(orgId, profileRow.display_name || 'My Organization', applicantType)
            } else {
              await tx
                .prepare(
                  `
                    INSERT INTO organizations (id, name, created_at, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                  `,
                )
                .run(orgId, profileRow.display_name || 'My Organization')
            }
          } catch (insertErr) {
            console.warn('[grants] auto-create org failed; retrying without applicant_type', {
              requestId,
              organization_id: orgId,
              profile_id: finalProfileId ? String(finalProfileId) : null,
              applicant_type: applicantType,
              code: insertErr?.code || null,
              message: insertErr?.message || String(insertErr),
            })
            await tx
              .prepare(
                `
                  INSERT INTO organizations (id, name, created_at, updated_at)
                  VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `,
              )
              .run(orgId, profileRow.display_name || 'My Organization')
          }

          // Link profile to organization
          await tx.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, finalProfileId);

          finalOrgId = orgId;
          routeLogger.info(`[grants] Auto-created organization ${orgId} for profile ${finalProfileId}`, {
            applicant_type: applicantType,
          });
        }

        // Safety: if we inherited a profile.organization_id from legacy data, ensure the org row exists
        // so `grants.organization_id` FK inserts cannot hard-fail.
        if (finalOrgId) {
          await ensureOrganizationRow({ organizationId: finalOrgId, profileRow, reason: 'profile.organization_id' })
        }
      }

      // If the caller explicitly provided an org id, ensure the row exists before we insert into grants.
      // This prevents 500s from FK violations when legacy data is missing the organizations row.
      if (finalOrgId) {
        await ensureOrganizationRow({
          organizationId: finalOrgId,
          profileRow,
          reason: normalizedOrgId ? 'request.organization_id' : 'derived',
        })
      }
      
      if (!finalOrgId) {
        throw new Error('Organization ID or Profile ID is required');
      }
      
      // Check for duplicate grants for this profile/org.
      // Avoid duplicates even when the opportunity exists multiple times in the catalog (different IDs).
      const oppUrl = opportunity?.application_url ? String(opportunity.application_url) : null
      // NOTE (Postgres):
      // Avoid `? IS NOT NULL` checks. Postgres cannot infer the type of a parameter used only in `IS NOT NULL`,
      // and will throw 42P18 ("could not determine data type of parameter $N") when the value is null.
      // Build the duplicate lookup dynamically instead.
      const dupParams = []
      const dupWhere = []

      if (hasProfileId && finalProfileId) {
        dupWhere.push('profile_id = ?')
        dupParams.push(String(finalProfileId))
      } else {
        dupWhere.push('organization_id = ?')
        dupParams.push(String(finalOrgId))
      }

      const dupMatch = []
      if (resolvedOpportunityId) {
        dupMatch.push('funding_opportunity_id = ?')
        dupParams.push(String(resolvedOpportunityId))
      }
      // Always match on title for synthetic/direct opportunities (funding_opportunity_id NULL).
      dupMatch.push('(funding_opportunity_id IS NULL AND title = ?)')
      dupParams.push(opportunity.title)
      if (oppUrl) {
        dupMatch.push('(application_url = ?)')
        dupParams.push(oppUrl)
      }

      const loadExistingGrant = () =>
        tx
          .prepare(
            `
              SELECT id, title
              FROM grants
              WHERE ${dupWhere.join(' AND ')}
                AND (${dupMatch.join(' OR ')})
              LIMIT 1
            `,
          )
          .get(...dupParams)
      const existingGrant = hasProfileId
        ? await loadExistingGrant()
        : await runLegacyProfilelessGrantQuery(loadExistingGrant)
      
      if (existingGrant) {
        return { 
          ...existingGrant, 
          organization_id: finalOrgId,
          already_exists: true,
          message: 'Grant already in pipeline'
        };
      }
      
      const id = crypto.randomUUID();

      const insertDeadline = normalizeDateForDb(opportunity.deadline ?? null)
      const insertMatchScore = normalizeMatchScore(match_score ?? null)
      // Fold canonical trust reasons into the persisted match_reasons so the
      // UI and Anya can explain why a saved grant is lower-trust / directory /
      // etc. without re-deriving from the raw opportunity row.
      const baseReasons = coerceArray(match_reasons)
      const trustReasonLines = []
      if (pipelineTrustMeta) {
        if (pipelineTrustMeta.trust_downgrade && pipelineTrustMeta.trust_downgrade_reason) {
          trustReasonLines.push(`trust:${pipelineTrustMeta.trust_downgrade_reason}`)
        }
        if (pipelineTrustMeta.trust_flags?.directory) {
          trustReasonLines.push('trust:directory_only')
        }
        if (pipelineTrustMeta.source_trust) {
          trustReasonLines.push(`source_trust:${pipelineTrustMeta.source_trust}`)
        }
      }
      const insertMatchReasons = JSON.stringify(
        [...baseReasons, ...trustReasonLines.filter((r) => !baseReasons.includes(r))],
      )
      const amountRequested = normalizeMoney(opportunity.amount_max ?? opportunity.amount_min ?? null)
      const notes = coerceString(opportunity.description, { maxLen: 500 })
      
      const contactInfo = parseOpportunityContact(opportunity)
      if (hasProfileId) {
        try {
          await tx.prepare(`
            INSERT INTO grants (
              id, organization_id, profile_id, funding_opportunity_id, title, funder,
              deadline, status, match_score, match_reasons, application_url,
              amount_requested, notes,
              contact_name, contact_email, contact_phone, funder_fax, funder_address, application_method
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id,
            finalOrgId,
            finalProfileId ? String(finalProfileId) : null,
            resolvedOpportunityId || null,
            opportunity.title,
            opportunity.sponsor || opportunity.funder || null,
            insertDeadline,
            insertMatchScore,
            insertMatchReasons,
            opportunity.application_url,
            amountRequested,
            notes,
            contactInfo.name, contactInfo.email, contactInfo.phone,
            contactInfo.fax, contactInfo.address, contactInfo.method
          );
        } catch (insertErr) {
          if (isUniqueGrantConflict(insertErr) && finalProfileId && resolvedOpportunityId) {
            const existingDuplicate = await findExistingGrantByProfileOpportunity(tx, finalProfileId, resolvedOpportunityId)
            if (existingDuplicate) {
              return {
                ...existingDuplicate,
                organization_id: finalOrgId,
                already_exists: true,
                message: 'Grant already in pipeline',
              }
            }
          }
          throw insertErr
        }
      } else {
        await tx.prepare(`
          INSERT INTO grants (
            id, organization_id, funding_opportunity_id, title, funder, 
            deadline, status, match_score, match_reasons, application_url,
            amount_requested, notes,
            contact_name, contact_email, contact_phone, funder_fax, funder_address, application_method
          )
          VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, 
          finalOrgId,
          resolvedOpportunityId || null,
          opportunity.title,
          opportunity.sponsor || opportunity.funder || null,
          insertDeadline,
          insertMatchScore,
          insertMatchReasons,
          opportunity.application_url,
          amountRequested,
          notes,
          contactInfo.name, contactInfo.email, contactInfo.phone,
          contactInfo.fax, contactInfo.address, contactInfo.method
        );
      }
      
      let grant = null
      if (hasProfileId && finalProfileId) {
        grant = await tx.prepare('SELECT * FROM grants WHERE id = ? AND profile_id = ?').get(id, String(finalProfileId))
      } else if (hasProfileId) {
        grant = await runLegacyProfilelessGrantQuery(() =>
          tx.prepare('SELECT * FROM grants WHERE id = ?').get(id),
        )
      } else {
        grant = await runLegacyProfilelessGrantQuery(() =>
          tx.prepare('SELECT * FROM grants WHERE id = ?').get(id),
        )
      }
      return { ...grant, organization_id: finalOrgId };
    });

    if (result && result._aborted) return
    
    // If grant already exists, return 200, otherwise 201
    const statusCode = result.already_exists ? 200 : 201;
    
    // Log successful grant creation with key details (no sensitive data)
    routeLogger.info('[grants/from-opportunity] success', {
      requestId,
      status: statusCode,
      grant_id: result.id,
      already_exists: Boolean(result.already_exists),
      profile_id: normalizedProfileId || null,
      organization_id: result.organization_id || null,
      opportunity_source: resolvedOpportunityId ? 'database' : 'direct_data',
      opportunity_title: result.title || null,
    })
    
    // Trigger non-blocking application approach advisor for newly created grants.
    if (!result.already_exists && result?.id) {
      Promise.resolve(scheduleGrantApplicationApproach({ db: req.db, grantId: result.id })).catch((advisorErr) => {
        routeLogger.warn('[grants/from-opportunity] approach advisor failed after save', {
          requestId,
          grant_id: result.id,
          error: advisorErr?.message || String(advisorErr),
        })
      })
    }

    // Non-blocking: extract opportunity signals into profile implicit_signals.
    // Only run for newly saved grants with a known profile.
    if (!result.already_exists && normalizedProfileId && opportunity) {
      Promise.resolve(mergeOpportunitySignals(req.db, normalizedProfileId, opportunity, 'save')).catch(() => {
        // Signal merge failures must never affect the pipeline save response.
      })

      // SOFT user-behavior learning (architecture #12): a save nudges future
      // matching toward this opportunity's categories/needs/source. Best-effort,
      // never throws, never alters the response.
      recordBehaviorEvent(req.db, {
        profileId: normalizedProfileId,
        action: 'saved',
        opportunity,
      }).catch(() => {})
    }

    // Manual re-add overrides any prior tombstone for this profile/opportunity.
    // The user explicitly chose to bring this source back, so the matcher
    // should be allowed to re-evaluate it on the next Process All / re-crawl.
    if (normalizedProfileId && opportunity) {
      try {
        const cleared = await clearPipelineDismissal(req.db, normalizedProfileId, opportunity)
        if (cleared > 0) {
          routeLogger.info('[grants/from-opportunity] cleared pipeline dismissal(s) on manual re-add', {
            requestId,
            profile_id: normalizedProfileId,
            cleared_count: cleared,
            opportunity_title: opportunity.title || null,
          })
        }
      } catch (clearErr) {
        routeLogger.warn('[grants/from-opportunity] failed to clear tombstone (non-fatal)', {
          requestId,
          profile_id: normalizedProfileId,
          error: clearErr?.message || String(clearErr),
        })
      }
    }

    res.status(statusCode).json(result);
  } catch (error) {
    // IMPORTANT:
    // Provide more user-friendly errors for common failure cases instead of always
    // returning a generic 500. Certain errors (like a missing organization or
    // profile) can be thrown inside the transaction and would normally be caught
    // by the global error handler. Detect and convert these into appropriate
    // 400/409-style responses so the UI can display a meaningful message.
    const msg = String(error?.message || '')

    // Profile not found error - provide clear feedback
    if (/Profile '.*' not found/i.test(msg)) {
      return res.status(404).json({
        error: 'profile_not_found',
        message: msg,
        requestId,
      })
    }

    // Missing org/profile error can be thrown within the transaction when no
    // organization_id could be derived. Treat it as a bad request.
    if (/Organization ID or Profile ID is required/i.test(msg)) {
      return res.status(400).json({
        error: 'missing_org_or_profile',
        message: 'You must specify either a profile_id or organization_id to add a grant to the pipeline.',
        requestId,
      })
    }

    // Catch unique/foreign key constraint errors. SQLite uses error.code
    // 'SQLITE_CONSTRAINT', Postgres uses '23505' for unique violations and
    // '23503' for foreign key violations. If we can locate an existing grant,
    // return a backwards-compatible "already_exists" response instead of a 500.
    const code = error?.code || null
    const constraintConflict = code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || 
                               code === '23505' || code === '23503'
    
    // Specific handling for FK constraint violations
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || code === '23503') {
      console.error('[grants/from-opportunity] Foreign key constraint violation', {
        requestId,
        profile_id: req.body?.profile_id ?? null,
        organization_id: req.body?.organization_id ?? null,
        opportunity_id: req.body?.opportunity_id ?? null,
        error: error?.message || String(error),
        code,
        // This helps identify which FK failed (opportunity, organization, or profile)
        hint: 'Check that all referenced IDs (opportunity_id, organization_id, profile_id) exist in their respective tables',
      })
      return res.status(400).json({
        error: 'invalid_reference',
        message: 'One or more referenced IDs (opportunity, organization, or profile) do not exist. Please verify and try again.',
        requestId,
      })
    }

    // Handle data validation errors from Postgres
    // 22007: invalid_datetime_format, 22008: datetime_field_overflow
    // 23502: not_null_violation, 23514: check_violation
    // 22001: string_data_right_truncation (value too long)
    // 22003: numeric_value_out_of_range
    const dataValidationCodes = ['22007', '22008', '23502', '23514', '22001', '22003', '22P02']
    if (dataValidationCodes.includes(code)) {
      console.error('[grants/from-opportunity] Data validation error', {
        requestId,
        profile_id: req.body?.profile_id ?? null,
        organization_id: req.body?.organization_id ?? null,
        opportunity_title: req.body?.opportunity_data?.title ?? null,
        opportunity_deadline: req.body?.opportunity_data?.deadline ?? null,
        error: error?.message || String(error),
        code,
        column: error?.column || null,
        constraint: error?.constraint || null,
      })

      // Provide user-friendly messages based on error code
      let userMessage = 'The provided data contains invalid values. Please check and try again.'
      if (code === '22007' || code === '22008') {
        userMessage = 'The deadline date format is invalid. Please provide a valid date.'
      } else if (code === '22001') {
        userMessage = 'One of the text fields is too long. Please shorten the values and try again.'
      } else if (code === '22003' || code === '22P02') {
        userMessage = 'One of the numeric fields contains an invalid value.'
      } else if (code === '23502') {
        userMessage = 'A required field is missing. Please ensure all required fields are filled.'
      }

      return res.status(400).json({
        error: 'invalid_data',
        message: userMessage,
        requestId,
        ...(process.env.NODE_ENV !== 'production' ? { code, details: error?.message } : {}),
      })
    }
    
    if (constraintConflict) {
      try {
        const body = req.body || {}
        const profileId = body.profile_id ? String(body.profile_id) : null
        const organizationId = body.organization_id ? String(body.organization_id) : null
        const opportunityId = body.opportunity_id ? String(body.opportunity_id) : null
        const oppTitle =
          body?.opportunity_data?.title !== undefined && body?.opportunity_data?.title !== null
            ? String(body.opportunity_data.title)
            : null
        const oppUrlRaw =
          body?.opportunity_data?.url ||
          body?.opportunity_data?.application_url ||
          body?.opportunity_data?.source_url ||
          null
        const oppUrl = oppUrlRaw ? String(oppUrlRaw) : null

        const hasProfileId = await grantsHasProfileIdColumn(req.db).catch(() => true)

        const clauses = []
        const params = []

        if (hasProfileId && profileId) {
          clauses.push('profile_id = ?')
          params.push(profileId)
        } else if (organizationId) {
          clauses.push('organization_id = ?')
          params.push(organizationId)
        } else {
          // Nothing to scope lookup; bail out to normal error handling.
          throw new Error('no_lookup_scope')
        }

        const matchClauses = []
        if (opportunityId) {
          matchClauses.push('(funding_opportunity_id = ?)')
          params.push(opportunityId)
        }
        if (oppUrl) {
          matchClauses.push('(application_url = ?)')
          params.push(oppUrl)
        }
        if (oppTitle) {
          matchClauses.push('(title = ?)')
          params.push(oppTitle)
        }

        if (matchClauses.length === 0) {
          throw new Error('no_lookup_keys')
        }

        const loadDuplicateGrant = () =>
          req.db
            .prepare(
              `
                SELECT id, title, organization_id${hasProfileId ? ', profile_id' : ''}
                FROM grants
                WHERE ${clauses.join(' AND ')}
                  AND (${matchClauses.join(' OR ')})
                LIMIT 1
              `,
            )
            .get(...params)
        const row = hasProfileId
          ? await loadDuplicateGrant()
          : await runLegacyProfilelessGrantQuery(loadDuplicateGrant)

        if (row) {
          return res.status(200).json({
            ...row,
            already_exists: true,
            message: 'Grant already in pipeline',
          })
        }
      } catch (lookupErr) {
        // Fall through to generic error if lookup fails
        console.warn('[grants/from-opportunity] duplicate lookup failed', lookupErr?.message || lookupErr)
      }
    }

    // Enhanced error logging with stack trace and detailed context
    const userId = req.user?.id || req.ctx?.userId || null
    console.error('[grants/from-opportunity] failed', {
      requestId,
      profile_id: req.body?.profile_id ?? null,
      organization_id: req.body?.organization_id ?? null,
      opportunity_id: req.body?.opportunity_id ?? null,
      opportunity_title: req.body?.opportunity_data?.title ?? null,
      code: error?.code || null,
      message: error?.message || String(error),
      stack: error?.stack || null,
      // Include additional context to help diagnose the issue
      errorName: error?.name || null,
      sqlState: error?.sqlState || null,
      constraint: error?.constraint || null,
      userId,
    })
    
    // Return a more informative error response
    if (process.env.NODE_ENV !== 'production') {
      return res.status(500).json({
        error: 'internal_server_error',
        message: 'Failed to add grant to pipeline. Please try again or contact support.',
        code: error?.code || null,
        details: error?.message || String(error),
        requestId,
      })
    }
    
    // Production: return user-friendly error without exposing internals
    return res.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected error occurred while adding the grant to your pipeline. Please try again. If the problem persists, contact support.',
      requestId,
    })
  }
});

export default router;
