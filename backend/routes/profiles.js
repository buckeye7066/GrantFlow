import express from 'express'
import crypto from 'crypto'
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js'
import multer from 'multer'
import fs from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import rateLimit from 'express-rate-limit'
import { buildProfileSectionPrompt, supportedSectionKeys } from '../prompts/profileSections.js'
import { PROFILE_SCHEMA, getDefaultSectionData, getFlatFieldToSectionMap } from '../config/profileSchema.js'
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js'
import { ensureBillingAccount, mapAccountRow } from '../services/billingAccounts.js'
import { extractCompletionText } from '../utils/openai.js'
import { withLLMTimeout, isLLMTimeout, LLM_TIMEOUT_MS } from '../utils/llmTimeout.js'
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { validatePagination } from '../utils/validation.js'
import { formatError } from '../middleware/errorHandler.js'
import { isMissingSchoolBridgeTable } from '../utils/schoolBridgeErrors.js'
import { createLogger } from '../utils/logger.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { applicationStatusToStage } from '../../shared/pipelineStages.js'
import {
  listProfileEmails,
  addProfileEmails,
  removeProfileEmail,
  isAdminUserWithDb,
  getAuthUserId,
  getAccessibleProfileIds,
} from '../utils/accessControl.js'
import { isDesignatedProfileId } from '../utils/ensureDesignatedProfiles.js'
import { resolveUploadsDir } from '../utils/uploadsDir.js'
import { ADMIN_EMAILS } from '../config/constants.js'
import { countSeats, describeSeatTier, evaluateSeatChange, billableSeatEmails } from '../services/billing/seatTier.js'
import { normalizeSchedule } from '../services/hamilton/portalAccessSchedule.js'
import { normalizeAutomationToggles, AUTOMATION_TOGGLES } from '../../shared/automationPreferences.js'
import { normalizeLanguageCode, isSupportedLanguage } from '../../shared/languages.js'
// Choke point for pipeline-$ semantics: canonical active-status list + the
// per-grant value fallback (amount_requested → amount_max → amount_min).
// Never re-inline a status list or a SUM(amount_requested) here.
import { PIPELINE_ACTIVE_STATUSES, pipelineValueSql, grantPipelineValue } from '../config/pipelineValue.js'
import { buildAwardSummary } from '../services/awardSummary.js'
import { resolveCommittedCollege } from '../services/college/committedCollege.js'
import { syncProfileFieldsFromSection, syncDisplayNameToBasicInformation } from '../utils/profileSectionSync.js'
import { deriveNamePartsIntoBasicInfo } from '../../shared/nameParsing.js'
import { guardProfileSectionPayload, SECTION_METADATA } from '../utils/profileSuggestionGuards.js'
import { normalizeProfileSectionData } from '../services/profileHelpers.js'
import { normalizeProfile } from '../services/profileNormalizer.js'
import { buildProfileGapPlan } from '../services/profileGapInterview.js'
import { resolveProfileType } from '../services/profileTypeRegistry.js'
import { normalizeHttpUrl } from '../services/avatarCrawler.js'
import { fetchOrgLogo } from '../services/orgLogoFetcher.js'
import { mergePortalAwardIntoApplications } from '../services/portalCheckService.js'
import {
  createSchoolPortalConnection,
  disconnectSchoolPortalConnection,
  getSchoolPortalWorkspace,
  mergeSchoolPortalAwards,
  removeMergedSchoolPortalAward,
} from '../services/schoolPortalImportService.js'
import { buildProjectReadinessPlan, renderProjectPlanDocument } from '../crawler-os/projectReadinessPlan.js'

/**
 * Mission goal #4/#5: every saved profile must carry a profile-type
 * value that the source-planning, strategy-dispatch, and Anya layers
 * can recognise. We never throw away a user-supplied value (some
 * legacy profiles use display labels), but if we *can* canonicalize
 * it through the registry we do so on the way in. Unknown values are
 * preserved verbatim so a later migration / Anya question can fix
 * them up.
 */
function canonicalizePrimaryTypeForSave(raw) {
  if (raw === undefined || raw === null) return raw
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (!trimmed) return null
  const id = resolveProfileType(trimmed)
  return id || trimmed
}

const router = express.Router()
const profileLogger = createLogger('route:profiles')

function evidenceHash(value) {
  const raw = String(value || '')
  if (!raw) return null
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

function logProfileSectionRejections(profileId, sectionKey, rejected = []) {
  for (const item of rejected) {
    profileLogger.warn('[profiles] profile section guard rejected field', {
      profile_id: profileId,
      section_key: sectionKey,
      key: item.key,
      reason: item.reason,
      evidence_hash: evidenceHash(item.evidence),
    })
  }
}

// Rate limit the profile listing endpoint (defense-in-depth).
// This is a read-heavy query that can touch multiple tables (and can be abused).
const listProfilesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300, // generous for interactive UI + admin usage
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many profile list requests, please try again later.',
})

// Profile creation touches several tables and schedules background jobs.
// Apply moderate rate limiting to prevent bulk-creation abuse.
const createProfileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30, // reasonable for normal usage; admins can create multiple profiles
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many profile create requests, please try again later.',
})

function isAuthenticatedFromCtx(ctx) {
  return Boolean(ctx && (ctx.userId || ctx.activeProfileId || ctx.email))
}

function denyAuth(req, res) {
  const authenticated = isAuthenticatedFromCtx(req.ctx)
  return res.status(authenticated ? 403 : 401).json({
    error: authenticated ? 'Not authorized' : 'Authentication required',
  })
}

function canAccessProfileIdFromCtx(ctx, profileId) {
  const id = String(profileId)
  if (ctx?.isAdmin === true) return true
  if (ctx?.accessibleProfileIds === null) return true // admin sentinel (all)
  if (ctx?.accessibleProfileIds instanceof Set && ctx.accessibleProfileIds.has(id)) return true
  if (ctx?.activeProfileId && String(ctx.activeProfileId) === id) return true
  return false
}

function canAccessProfileRowFromCtx(ctx, profileRow) {
  if (!profileRow) return false
  if (canAccessProfileIdFromCtx(ctx, profileRow.id)) return true
  if (ctx?.userId && profileRow.user_id && String(ctx.userId) === String(profileRow.user_id)) return true
  if (ctx?.userId && profileRow.created_by && String(ctx.userId) === String(profileRow.created_by)) return true
  return false
}

// Central enforcement: any route that includes a `:id` param in this router refers to a profile id.
// This prevents profile “bleed” from stale token claims; access is always re-validated.
router.param('id', async (req, res, next, id) => {
  try {
    // Fast path: prefer the canonical requestContext computation.
    // This avoids recomputing access sets (and avoids 403s when DB checks are transiently failing).
    if (canAccessProfileIdFromCtx(req.ctx, id)) return next()

    // If unauthenticated, this is a clean 401 (never 500).
    if (!isAuthenticatedFromCtx(req.ctx)) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    // As a last resort, verify ownership by userId (covers cases where access sets are empty/unavailable).
    if (req.ctx?.userId) {
      const row = await req.db
        .prepare('SELECT user_id, created_by, status FROM profiles WHERE id = ?')
        .get(String(id))
        // Soft-deleted profiles must appear as non-existent across all sub-routes.
              if (row?.status === 'deleted') {
                      return res.status(404).json({ error: 'Profile not found' })
                            }
      if (row?.user_id && String(row.user_id) === String(req.ctx.userId)) return next()
      if (row?.created_by && String(row.created_by) === String(req.ctx.userId)) return next()
    }

    return res.status(403).json({ error: 'Not authorized to access this profile' })
  } catch (error) {
    console.warn('[profiles] access precheck failed; denying access', {
      profileId: String(id),
      error: error?.message || String(error),
    })
    return denyAuth(req, res)
  }
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
function getUploadsDir(req) {
  const fromApp = req?.app?.locals?.uploads?.uploadsDir
  if (fromApp) return String(fromApp)
  if (req?.uploadsDir) return String(req.uploadsDir)
  const resolved = resolveUploadsDir({ baseDir: join(__dirname, '..') })
  return resolved.uploadsDir
}

function requireUploadsWritable(req, res, next) {
  const status = req?.storageStatus || req?.app?.locals?.uploads?.storageStatus || null
  if (status && status.writable === false) {
    return res.status(503).json({
      ok: false,
      error: 'Upload storage is unavailable',
      code: 'UPLOAD_STORAGE_UNAVAILABLE',
      uploads_dir: status.uploads_dir || null,
      status: status.status || 'degraded',
    })
  }
  return next()
}

// Avatars use IN-MEMORY storage, not disk. Railway's filesystem is ephemeral
// (wiped on every redeploy) and may even be non-writable, which previously made
// the upload 503 or silently lose the file so NO avatar ever persisted. With
// memory storage the bytes land in req.file.buffer and go straight into the
// profiles.avatar_data BYTEA column (the durable source of truth); writing the
// file to /uploads is now only a best-effort read cache.
const storage = multer.memoryStorage()

const imageFileFilter = (_req, file, cb) => {
  const mime = String(file?.mimetype || '')
  if (mime.startsWith('image/')) {
    return cb(null, true)
  }

  // Some clients may omit mimetype; fall back to extension check.
  const name = String(file?.originalname || '').toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop() : ''
  const allowedExt = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif'])
  if (allowedExt.has(ext)) {
    return cb(null, true)
  }

  return cb(new Error('Only image uploads are allowed'))
}

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  // Phone photos are often >5MB; keep this reasonable while still preventing abuse.
  limits: { fileSize: 15 * 1024 * 1024 },
})

function runUploadSingle(fieldName) {
  const middleware = upload.single(fieldName)
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next()
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Image is too large. Max size is 15MB.' })
        }
      }
      return res.status(400).json({ error: err?.message || 'Upload failed' })
    })
  }
}

const profileSelect = `
  SELECT 
    p.id,
    p.created_at,
    p.updated_at,
    p.created_by,
    p.organization_id,
    p.user_id,
    p.primary_type,
    COALESCE(NULLIF(TRIM(p.display_name), ''), o.name) AS display_name,
    p.status,
    p.tags,
    p.avatar_url,
    o.name AS organization_name
  FROM profiles p
  LEFT JOIN organizations o ON o.id = p.organization_id
`

/** DB `.all()` should return an array; normalize `{ rows }` shapes so `.map` never throws (empty sections). */
function coerceDbRows(result) {
  if (result === null) return []
  if (Array.isArray(result)) return result
  if (Array.isArray(result.rows)) return result.rows
  return []
}

async function optionalRows(db, label, sql, params = []) {
  try {
    return coerceDbRows(await db.prepare(sql).all(...params))
  } catch (error) {
    if (isOptionalSchemaLookupError(error)) {
      const message = error?.message || String(error)
      console.warn(`[profiles] Skipping optional ${label} application lookup: ${message}`)
      return []
    }
    throw error
  }
}

function isOptionalSchemaLookupError(error) {
  const message = String(error?.message || error)
  return (
    message.includes('no such table') ||
    message.includes('does not exist') ||
    message.includes('no such column') ||
    (message.includes('column') && message.includes('does not exist'))
  )
}

function projectPlanDocumentSelect({ includeStructured = true } = {}) {
  return `
    SELECT d.id, d.name, d.type, d.mime_type, d.extracted_text,
           ${includeStructured ? 'd.extracted_structured' : 'NULL AS extracted_structured'},
           d.ai_summary, d.notes, d.processing_status, d.created_at
      FROM documents d
  `
}

async function loadProjectPlanDocumentRows(db, label, safeFromWhereSql, params = [], { optionalSchema = false } = {}) {
  const safeOrderLimitSql = `
      ${safeFromWhereSql}
      ORDER BY d.created_at DESC
      LIMIT 100
  `
  try {
    return coerceDbRows(await db.prepare(`${projectPlanDocumentSelect()} ${safeOrderLimitSql}`).all(...params))
  } catch (error) {
    const message = String(error?.message || error).toLowerCase()
    if (message.includes('extracted_structured')) {
      try {
        return coerceDbRows(
          await db.prepare(`${projectPlanDocumentSelect({ includeStructured: false })} ${safeOrderLimitSql}`).all(...params),
        )
      } catch (fallbackError) {
        if (optionalSchema && isOptionalSchemaLookupError(fallbackError)) {
          console.warn(`[profiles] Skipping optional ${label} application lookup: ${fallbackError?.message || fallbackError}`)
          return []
        }
        throw fallbackError
      }
    }
    if (optionalSchema && isOptionalSchemaLookupError(error)) {
      console.warn(`[profiles] Skipping optional ${label} application lookup: ${error?.message || error}`)
      return []
    }
    throw error
  }
}

function mergeProjectPlanDocuments(rows) {
  const byId = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.id ? String(row.id) : null
    if (!id || byId.has(id)) continue
    byId.set(id, row)
  }
  return Array.from(byId.values())
    .sort((a, b) => {
      const aMs = Date.parse(String(a?.created_at || ''))
      const bMs = Date.parse(String(b?.created_at || ''))
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0)
    })
    .slice(0, 100)
}

function mapProfile(row) {
  if (!row) return null
  const rawAvatar = row.avatar_url ?? null
  const avatarVersion =
    rawAvatar && String(rawAvatar).includes('/uploads/')
      ? (() => {
          const s = String(rawAvatar)
          // Accept /uploads/<file> or https://host/.../uploads/<file>
          const parts = s.split('/uploads/')
          const tail = parts.length > 1 ? parts[parts.length - 1] : ''
          const file = tail.split('?')[0].split('#')[0].split('/').pop()
          return file ? String(file).trim() : null
        })()
      : null

  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    organization_id: row.organization_id,
    organization_name: row.organization_name ?? null,
    user_id: row.user_id ?? null,
    primary_type: row.primary_type,
    display_name: row.display_name,
    // Backwards-compatible aliases for older UI components that expect "organization-like" fields.
    name: row.display_name,
    applicant_type: row.primary_type,
    status: row.status,
    tags: safeParseJSON(row.tags, []),
    avatar_url: rawAvatar,
    // Prefer a stable, diagnostic endpoint for file-backed avatars (handles legacy dir + logs missing).
    avatar_download_url:
      rawAvatar && String(rawAvatar).includes('/uploads/')
        ? `/api/profiles/${String(row.id)}/avatar/download${avatarVersion ? `?v=${encodeURIComponent(avatarVersion)}` : ''}`
        : null,
    profile_image_url: rawAvatar ?? null,
  }
}

async function loadProfileForProjectPlan(req, id) {
  const row = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!row) return null
  const profile = mapProfile(row)
  const sectionRows = coerceDbRows(await req.db.prepare(
    `SELECT section_key, data, updated_at, updated_by
       FROM profile_sections
      WHERE profile_id = ?
      ORDER BY section_key`,
  ).all(id))
  profile.sections = sectionRows.map((section) => ({
    section_key: section.section_key,
    data: normalizeProfileSectionData(section.section_key, safeParseJSON(section.data, {})),
    updated_at: section.updated_at,
    updated_by: section.updated_by,
  }))
  const docs = mergeProjectPlanDocuments([
    ...(await loadProjectPlanDocumentRows(req.db, 'project-plan direct documents', 'WHERE d.profile_id = ?', [id])),
    ...(await loadProjectPlanDocumentRows(
      req.db,
      'project-plan linked documents',
      `JOIN profile_documents pd ON pd.document_id = d.id
       WHERE pd.profile_id = ?`,
      [id],
      { optionalSchema: true },
    )),
  ])
  profile.documents = docs.map((doc) => ({
    ...doc,
    extracted_structured: safeParseJSON(doc.extracted_structured, null),
  }))
  return profile
}

async function saveProjectPlanDocument(req, profileId, plan) {
  const documentId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')
  const content = renderProjectPlanDocument(plan)
  const now = new Date().toISOString()
  const contentHash = crypto.createHash('sha256').update(content).digest('hex')
  const notes = JSON.stringify({ generated_by: 'hamilton', plan_id: plan.plan_id })
  const fullInsertSql = `INSERT INTO documents (
        id, profile_id, name, type, mime_type, extracted_text, ai_summary,
        processing_status, status, notes, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'draft', ?, ?, ?, ?)`
  try {
    await req.db.prepare(fullInsertSql).run(
      documentId,
      profileId,
      `${plan.title}.md`,
      'project_action_plan',
      'text/markdown',
      content,
      plan.summary,
      notes,
      contentHash,
      now,
      now,
    )
  } catch (error) {
    const msg = String(error?.message || error).toLowerCase()
    if (!msg.includes('no such column')) throw error
    await req.db.prepare(
      `INSERT INTO documents (
          id, profile_id, name, type, mime_type, extracted_text, ai_summary,
          processing_status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
    ).run(
      documentId,
      profileId,
      `${plan.title}.md`,
      'project_action_plan',
      'text/markdown',
      content,
      plan.summary,
      notes,
    )
  }
  await req.db.prepare(
    `INSERT INTO profile_documents (profile_id, document_id)
     VALUES (?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(profileId, documentId)
  return {
    id: documentId,
    name: `${plan.title}.md`,
    type: 'project_action_plan',
    processing_status: 'completed',
  }
}

async function enrichProfileWithSummary(db, profile) {
  // Get billing account info
  const billingAccount = await ensureBillingAccount(db, profile.id)
  profile.billing = mapAccountRow(billingAccount)
  
  // Get section completion stats. Count ONLY canonical sections (intersect with
  // SECTION_METADATA) so the profile card agrees with the detail page's
  // "X of 13" — a raw COUNT(*) over profile_sections inflates the number with
  // legacy/duplicate/non-canonical keys (the QA finding: card said "21" while
  // the profile actually has 13 defined sections).
  const canonicalSectionKeys = Object.keys(SECTION_METADATA || {})
  if (canonicalSectionKeys.length) {
    const placeholders = canonicalSectionKeys.map(() => '?').join(',')
    const sections = await db
      .prepare(`SELECT COUNT(DISTINCT section_key) as total FROM profile_sections WHERE profile_id = ? AND section_key IN (${placeholders})`)
      .get(profile.id, ...canonicalSectionKeys)
    profile.sections_complete = sections?.total ?? 0
    profile.sections_total = canonicalSectionKeys.length
  } else {
    const sections = await db
      .prepare('SELECT COUNT(*) as total FROM profile_sections WHERE profile_id = ?')
      .get(profile.id)
    profile.sections_complete = sections?.total ?? 0
  }
  
  // Get pipeline funds total
  // Prefer profile-scoped totals when grants.profile_id exists; fall back to organization totals.
  // This keeps the ProfileCard "Pipeline $X" consistent with the Pipeline page when a user switches profiles.
  let pipelineTotal = 0
  const activeStatuses = PIPELINE_ACTIVE_STATUSES
  try {
    const placeholders = activeStatuses.map(() => '?').join(',')
    const row = await db
      .prepare(
        `
        SELECT COALESCE(SUM(${pipelineValueSql('g')}), 0) as total
        FROM grants g
        WHERE g.profile_id = ?
          AND g.status IN (${placeholders})
      `,
      )
      .get(profile.id, ...activeStatuses)
    pipelineTotal = row?.total ?? 0
  } catch (error) {
    // Older DBs may not have grants.profile_id yet; fall back.
    const msg = error?.message || String(error)
    if (!/profile_id/i.test(msg)) {
      console.warn('[profiles] pipeline summary query failed; falling back to org total:', msg)
    }
    try {
      const placeholders = activeStatuses.map(() => '?').join(',')
      const row = await db
        .prepare(
          `
          SELECT COALESCE(SUM(${pipelineValueSql('g')}), 0) as total
          FROM grants g
          WHERE g.organization_id = ?
            AND g.status IN (${placeholders})
        `,
        )
        .get(profile.organization_id, ...activeStatuses)
      pipelineTotal = row?.total ?? 0
    } catch (fallbackError) {
      console.warn(
        '[profiles] pipeline org summary query failed (returning 0):',
        fallbackError?.message || String(fallbackError),
      )
      pipelineTotal = 0
    }
  }
  profile.pipeline_funds_total = pipelineTotal
  
  // Get document count
  const docs = await db
    .prepare('SELECT COUNT(*) as total FROM profile_documents WHERE profile_id = ?')
    .get(profile.id)
  profile.document_count = docs?.total ?? 0
  
  return profile
}

function getOpenAI() {
  return createOpenAIClient().openai
}

function getOpenAIOptional() {
  return createOpenAIClient({ allowMissing: true }).openai
}

async function createAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 15_000),
      maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
    })
  } catch (error) {
    // Production hardening: if the Anthropic SDK isn't installed (or fails to load),
    // do not 500 the endpoint — fall back to the configured provider(s) or a clear 503.
    console.warn('[profiles/ai] Anthropic client unavailable:', error?.message || String(error))
    return null
  }
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part === 'string') return part
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

router.get('/', listProfilesLimiter, async (req, res) => {
  try {
    // Canonical truth is req.ctx, but harden against any transient ctx-building issues
    // by falling back to a DB-backed admin check (never token-only).
    const user = req.user ?? { role: 'guest' }
    let isAdmin = req.ctx?.isAdmin === true ? true : await isAdminUserWithDb(req.db, user)
    const includeSummary = req.query.summary === 'true'
    const includeDeleted = req.query.includeDeleted === 'true'
    // Hide Amy's synthetic crawler-training profiles (created_by 'agent:amy') from
    // the owner-facing profile list — they are not real applicants and reading
    // "Amy Synthetic — College Student #3" in the list makes prod look like
    // staging. Internal tooling can opt back in with ?include_synthetic=1.
    const includeSynthetic = req.query.include_synthetic === '1'
    const excludeSyntheticSql = includeSynthetic ? '' : " AND COALESCE(p.created_by, '') <> 'agent:amy'"
    const scopeMine = req.query.scope === 'mine' || req.query.mine === 'true'
    const userId = req.ctx?.userId ?? getAuthUserId(user) ?? null

    // Resolve accessible profile IDs once. `null` from getAccessibleProfileIds means admin (all profiles).
    // If ctx missed admin but the DB says admin, upgrade `isAdmin` before pagination so admins get limit=1000.
    let resolvedAccessibleIds = req.ctx?.accessibleProfileIds
    if (!isAdmin && !scopeMine) {
      if (resolvedAccessibleIds === null) {
        try {
          resolvedAccessibleIds = await getAccessibleProfileIds(req.db, user)
        } catch {
          resolvedAccessibleIds = new Set()
        }
      }
      if (resolvedAccessibleIds === null) {
        isAdmin = true
      }
    }

    // Validate pagination parameters.
    // For admins, default to the max page size unless a limit is explicitly provided.
    // This prevents "missing profiles" in the UI when admins expect to see everything.
    const paginationQuery = { ...req.query }
    const limitProvided = Object.prototype.hasOwnProperty.call(req.query ?? {}, 'limit')
    if (isAdmin && !scopeMine && !limitProvided) {
      paginationQuery.limit = 1000
      paginationQuery.offset = 0
    }
    const { limit, offset } = validatePagination(paginationQuery)

    // Alphabetical by person/organization name (case-insensitive), empty names
    // last, created_at as a stable tiebreaker. Shared across all list branches so
    // the profile list reads A→Z everywhere. Uses only LOWER/CASE (SQLite + PG).
    const orderByName =
      "ORDER BY (CASE WHEN p.display_name IS NULL OR p.display_name = '' THEN 1 ELSE 0 END), LOWER(p.display_name) ASC, p.created_at ASC"

    // "My Profiles" scope: return only profiles owned-by or shared-to this user,
    // even if the caller is an admin (admins otherwise see ALL profiles).
    if (scopeMine) {
      const emails = []
      const primary = normalizeEmail(user?.primary_email)
      const secondary = normalizeEmail(user?.email)
      if (primary) emails.push(primary)
      if (secondary && secondary !== primary) emails.push(secondary)

      if (!userId && emails.length === 0) return res.status(401).json({ error: 'Authentication required' })

      const ids = new Set()

      if (userId) {
        const owned = await req.db.prepare('SELECT id FROM profiles WHERE user_id = ?').all(String(userId))
        for (const row of owned || []) {
          if (row?.id) ids.add(String(row.id))
        }
        try {
          const created = await req.db.prepare('SELECT id FROM profiles WHERE created_by = ?').all(String(userId))
          for (const row of created || []) {
            if (row?.id) ids.add(String(row.id))
          }
        } catch {
          // ignore schema drift
        }
      }

      if (emails.length > 0) {
        // 1) Explicit allowlist table (profile_emails).
        try {
          const placeholders = emails.map(() => '?').join(', ')
          const rows = await req.db
            .prepare(
              `
                SELECT DISTINCT profile_id
                FROM profile_emails
                WHERE lower(email) IN (${placeholders})
              `,
            )
            .all(...emails)
          for (const row of rows || []) {
            if (row?.profile_id) ids.add(String(row.profile_id))
          }
        } catch {
          // ignore (schema may not exist yet)
        }

        // 2) Backfill: match profile basic_information.email against the user (like accessControl fallback).
        try {
          const placeholders = emails.map(() => '?').join(', ')
          if (req.db?.dialect === 'postgres') {
            const rows = await req.db
              .prepare(
                `
                  SELECT DISTINCT ps.profile_id
                  FROM profile_sections ps
                  WHERE ps.section_key = 'basic_information'
                    AND LOWER((ps.data::jsonb ->> 'email')) IN (${placeholders})
                `,
              )
              .all(...emails)
            for (const row of rows || []) {
              if (row?.profile_id) ids.add(String(row.profile_id))
            }
          } else {
            const rows = await req.db
              .prepare(
                `
                  SELECT DISTINCT ps.profile_id
                  FROM profile_sections ps
                  WHERE ps.section_key = 'basic_information'
                    AND LOWER(json_extract(ps.data, '$.email')) IN (${placeholders})
                `,
              )
              .all(...emails)
            for (const row of rows || []) {
              if (row?.profile_id) ids.add(String(row.profile_id))
            }
          }
        } catch {
          // ignore
        }
      }

      const idList = Array.from(ids)
      if (idList.length === 0) return res.json([])

      const placeholders = idList.map(() => '?').join(', ')
      const whereDeleted = includeDeleted ? '' : " AND (p.status IS NULL OR p.status <> 'deleted')"

      const rows = await req.db
        .prepare(
          `${profileSelect} WHERE p.id IN (${placeholders})${whereDeleted}${excludeSyntheticSql} ${orderByName} LIMIT ? OFFSET ?`,
        )
        .all(...idList, limit, offset)

      const profiles = rows.map(mapProfile)
      if (includeSummary) {
        for (const profile of profiles) {
          await enrichProfileWithSummary(req.db, profile)
        }
      }
      return res.json(profiles)
    }

    // Check if user is admin
    if (!isAdmin) {
      // Enduser: return all profiles the user can access.
      // This includes ownership (profiles.user_id) AND shared access via profile_emails.
      if (!userId) return res.status(401).json({ error: 'Authentication required' })

      const ids = resolvedAccessibleIds instanceof Set ? Array.from(resolvedAccessibleIds) : []

      if (ids.length === 0) {
        return res.json([])
      }

      const placeholders = ids.map(() => '?').join(', ')
      const whereDeleted = includeDeleted ? '' : " AND (p.status IS NULL OR p.status <> 'deleted')"

      // Get all accessible profiles (with pagination)
      const rows = await req.db
        .prepare(
          `${profileSelect} WHERE p.id IN (${placeholders})${whereDeleted}${excludeSyntheticSql} ${orderByName} LIMIT ? OFFSET ?`,
        )
        .all(...ids, limit, offset)

      const profiles = rows.map(mapProfile)
      if (includeSummary) {
        for (const profile of profiles) {
          await enrichProfileWithSummary(req.db, profile)
        }
      }
      return res.json(profiles)
    }

    // Admin: return ALL profiles with pagination.
    // `adminWhere` is one of two hardcoded SQL fragments selected by the
    // boolean `includeDeleted`; no user-supplied values flow into the
    // string, so the template-literal interpolation below is safe. The
    // `safeAdminWhere` name makes that visible to the auditor.
    let safeAdminWhere = includeDeleted ? '' : "WHERE (p.status IS NULL OR p.status <> 'deleted')"
    if (!includeSynthetic) {
      safeAdminWhere = safeAdminWhere
        ? `${safeAdminWhere} AND COALESCE(p.created_by, '') <> 'agent:amy'`
        : "WHERE COALESCE(p.created_by, '') <> 'agent:amy'"
    }
    const stmt = req.db.prepare(`${profileSelect} ${safeAdminWhere} ${orderByName} LIMIT ? OFFSET ?`) // audit:allow dynamic-sql
    const profiles = (await stmt.all(limit, offset)).map(mapProfile)

    if (includeSummary) {
      for (const profile of profiles) {
        await enrichProfileWithSummary(req.db, profile)
      }
    }

    return res.json(profiles)
  } catch (error) {
    const message = String(error?.message || error)
    const schemaMissing =
      message.toLowerCase().includes('no such table') ||
      (message.toLowerCase().includes('relation') && message.toLowerCase().includes('profiles'))

    console.error('[profiles] list failed', {
      requestId: req.requestId || null,
      schemaMissing,
      error: message,
    })

    if (schemaMissing) {
      // Avoid 502s from upstream proxies by returning a clean, explicit 503.
      return res.status(503).json({
        ok: false,
        error: 'Profiles are temporarily unavailable (database schema not ready)',
        code: 'DB_SCHEMA_MISSING',
      })
    }

    return res.status(500).json(formatError(error))
  }
})

// Canonical profile schema (data points + explanations)
// IMPORTANT: This must be defined before `/:id` routes to avoid being captured as a profile id.
router.get('/schema', async (_req, res) => {
  res.json({
    version: '1.0',
    generated_at: new Date().toISOString(),
    sections: PROFILE_SCHEMA,
    supported_section_keys: supportedSectionKeys,
  })
})

function normalizeEmail(email = '') {
  const v = String(email || '').trim().toLowerCase()
  return v || null
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())
}

// Profile login allowlist (board members, collaborators).
// ---------------------------------------------------------------------------
// GET /api/profiles/:id/school-link
//
// Returns whether this profile is bridged to a registered school partner
// and (if so) when it was last synced and what the school is called. Used
// by ProfileDetail.jsx to render the SchoolPortalLinkPanel and let the
// student revoke the bridge.
// ---------------------------------------------------------------------------
router.get('/:id/school-link', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    const profileId = String(req.params.id)
    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) return res.status(403).json({ error: 'Not authorized' })

    let link = null
    try {
      link = await req.db
        .prepare(`SELECT l.id, l.school_partner_id, l.external_student_id, l.email,
                         l.consent_status, l.consented_at, l.revoked_at,
                         l.last_synced_at, p.slug AS partner_slug, p.name AS partner_name
                    FROM school_student_links l
                    JOIN school_partners p ON p.id = l.school_partner_id
                    WHERE l.profile_id = ?
                    ORDER BY COALESCE(l.last_synced_at, l.created_at) DESC, l.created_at DESC
                    LIMIT 1`)
        .get(profileId)
    } catch (queryError) {
      if (isMissingSchoolBridgeTable(queryError)) {
        // Log once so the operator knows migration 079/0075 still needs to land
        // on this database, but answer the route as "no link" so the UI keeps
        // working for every user that isn't (yet) school-bridged.
        console.warn(
          '[profiles] /school-link: school-bridge tables not provisioned; returning link=null',
          { code: queryError?.code, message: queryError?.message },
        )
        return res.json({ ok: true, link: null })
      }
      throw queryError
    }
    if (!link) return res.json({ ok: true, link: null })
    return res.json({ ok: true, link })
  } catch (error) {
    console.error('[profiles] /school-link failed:', error)
    res.status(500).json(formatError(error))
  }
})

// POST /api/profiles/:id/school-link/revoke — student-side revoke
router.post('/:id/school-link/revoke', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    const profileId = String(req.params.id)
    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) return res.status(403).json({ error: 'Not authorized' })

    let result
    try {
      result = await req.db
        .prepare(`UPDATE school_student_links
                    SET consent_status = 'revoked',
                        revoked_at = ?,
                        updated_at = ?
                  WHERE profile_id = ? AND consent_status != 'revoked'`)
        .run(new Date().toISOString(), new Date().toISOString(), profileId)
    } catch (queryError) {
      if (isMissingSchoolBridgeTable(queryError)) {
        console.warn(
          '[profiles] /school-link/revoke: school-bridge tables not provisioned; nothing to revoke',
          { code: queryError?.code, message: queryError?.message },
        )
        return res.json({ ok: true, revoked: 0 })
      }
      throw queryError
    }
    return res.json({ ok: true, revoked: result?.changes ?? 0 })
  } catch (error) {
    console.error('[profiles] /school-link/revoke failed:', error)
    res.status(500).json(formatError(error))
  }
})

router.get('/:id/emails', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)

    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) {
      return res.status(403).json({ error: 'Not authorized to manage profile emails' })
    }

    // Render the SAME set we count toward billing: the platform operator/admin
    // email is linked to every profile for back-office visibility and is NOT a
    // paid seat, so it must not appear in the login list either. Listing it
    // while excluding it from the count is what produced the off-by-one
    // (e.g. "1 seat" shown next to 2 listed logins).
    const allEmails = await listProfileEmails(req.db, profileId)
    const emails = billableSeatEmails(allEmails, ADMIN_EMAILS)
    res.json({ emails, seat_tier: describeSeatTier(emails.length) })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/:id/emails', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)

    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) {
      return res.status(403).json({ error: 'Not authorized to manage profile emails' })
    }

    const raw = req.body?.emails ?? req.body?.email
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    const normalized = list.map((e) => normalizeEmail(e)).filter(Boolean)
    if (normalized.length === 0) {
      return res.status(400).json({ error: 'emails is required' })
    }
    if (normalized.length > 25) {
      return res.status(400).json({ error: 'Too many emails (max 25)' })
    }
    const invalid = normalized.filter((e) => !isValidEmail(e))
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid email(s): ${invalid.slice(0, 3).join(', ')}` })
    }

    // Billing-tier guard: count current seats (excluding platform-admin emails),
    // figure out how many of the submitted addresses are genuinely NEW, and if
    // adding them bumps the org into a higher billing tier (small→mid at 2,
    // mid→large at 6) require an explicit confirm so the org isn't silently
    // upgraded. Pass { confirm: true } to proceed.
    const existing = await listProfileEmails(req.db, profileId)
    const existingSet = new Set(existing.map((e) => String(e.email || '').toLowerCase()))
    const adminSet = new Set(ADMIN_EMAILS.map((e) => String(e).toLowerCase()))
    const netNew = normalized.filter((e) => !existingSet.has(e) && !adminSet.has(e))
    const currentSeats = countSeats(existing, ADMIN_EMAILS)
    const change = evaluateSeatChange(currentSeats, netNew.length)
    if (change.crosses_up && req.body?.confirm !== true) {
      return res.status(409).json({
        error: 'tier_change_requires_confirmation',
        requires_confirmation: true,
        warning: change.warning,
        tier_change: change,
        message: 'Adding these logins will move the organization to a higher billing tier. Resend with { confirm: true } to proceed.',
      })
    }

    const addedBy = req.ctx?.userId ?? req.ctx?.email ?? null
    await addProfileEmails(req.db, { profileId, emails: normalized, addedBy })
    // Same billable-set rule as the GET handler: list exactly what we count.
    const emails = billableSeatEmails(await listProfileEmails(req.db, profileId), ADMIN_EMAILS)
    res.status(201).json({
      emails,
      seat_tier: describeSeatTier(emails.length),
      tier_changed: change.crosses_up,
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.delete('/:id/emails/:emailId', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)

    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) {
      return res.status(403).json({ error: 'Not authorized to manage profile emails' })
    }

    const emailId = String(req.params.emailId)
    const result = await removeProfileEmail(req.db, { profileId, emailId })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ── Hamilton portal-access schedule ────────────────────────────────────────
// The time-of-day window(s) during which Hamilton may access portals
// unattended, so the owner is available for any sign-in / 2FA. Stored on the
// automation_preferences profile section under `portal_access`.
async function loadAutomationPreferences(db, profileId) {
  try {
    const row = await db
      .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'automation_preferences' LIMIT 1`)
      .get(String(profileId))
    if (!row?.data) return {}
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  } catch { return {} }
}

async function saveAutomationPreferences(db, profileId, prefs, updatedBy) {
  const data = JSON.stringify(prefs)
  const existing = await db
    .prepare(`SELECT 1 AS x FROM profile_sections WHERE profile_id = ? AND section_key = 'automation_preferences'`)
    .get(String(profileId))
  if (existing) {
    await db
      .prepare(`UPDATE profile_sections SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND section_key = 'automation_preferences'`)
      .run(data, updatedBy, String(profileId))
  } else {
    await db
      .prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?, 'automation_preferences', ?, ?)`)
      .run(String(profileId), data, updatedBy)
  }
}

router.get('/:id/portal-access-schedule', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)
    // Profile-scoped schedule: reuse the central profile access decision so
    // email-shared owners can use the same tools as account owners.
    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) return res.status(403).json({ error: 'Not authorized to view this profile' })
    const prefs = await loadAutomationPreferences(req.db, profileId)
    res.json({ schedule: normalizeSchedule(prefs) })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.put('/:id/portal-access-schedule', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)
    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) return res.status(403).json({ error: 'Not authorized to manage this profile' })

    // Validate by normalizing — bad windows are dropped; an empty/disabled
    // schedule means "any time" (the prior always-on behavior).
    const incoming = {
      enabled: req.body?.enabled === true,
      timezone: req.body?.timezone,
      windows: Array.isArray(req.body?.windows) ? req.body.windows : [],
    }
    const normalized = normalizeSchedule({ portal_access: incoming })
    if (incoming.enabled && normalized.windows.length === 0) {
      return res.status(400).json({ error: 'At least one valid time window (start/end as HH:MM) is required when enabled.' })
    }

    const prefs = await loadAutomationPreferences(req.db, profileId)
    prefs.portal_access = {
      enabled: normalized.enabled,
      timezone: normalized.timezone,
      windows: normalized.windows.map((w) => ({ start: w.start, end: w.end })),
    }
    await saveAutomationPreferences(req.db, profileId, prefs, req.ctx?.userId ?? null)
    res.json({ schedule: normalizeSchedule(prefs) })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ── Per-profile automation toggles ─────────────────────────────────────────
// Which automations are allowed to run for THIS profile. Stored on the
// automation_preferences profile section under `automations`. Defaults are all
// ON so a profile with no saved preference behaves exactly as before. The
// canonical toggle list + normalization live in shared/automationPreferences.js
// and the same keys are enforced at each automation's run gate.
router.get('/:id/automation-preferences', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)
    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) return res.status(403).json({ error: 'Not authorized to view this profile' })
    const prefs = await loadAutomationPreferences(req.db, profileId)
    res.json({
      automations: normalizeAutomationToggles(prefs?.automations),
      definitions: AUTOMATION_TOGGLES,
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.put('/:id/automation-preferences', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)
    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) return res.status(403).json({ error: 'Not authorized to manage this profile' })

    // Accept either { automations: {...} } or a bare {...} of toggle keys.
    // normalizeAutomationToggles drops unknown keys and coerces to booleans, so
    // an absent key keeps its behaviour-preserving default.
    const incoming = req.body?.automations && typeof req.body.automations === 'object'
      ? req.body.automations
      : (req.body || {})
    const prefs = await loadAutomationPreferences(req.db, profileId)
    prefs.automations = normalizeAutomationToggles(incoming)
    await saveAutomationPreferences(req.db, profileId, prefs, req.ctx?.userId ?? null)
    res.json({
      automations: prefs.automations,
      definitions: AUTOMATION_TOGGLES,
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ── Per-profile discovery preferences ───────────────────────────────────────
// The "Minimum match score" slider (Automated Discovery settings) persists
// here — same automation_preferences section, `discovery` sub-key — and
// run-smart reads it as the default min_match_score when a request does not
// specify one. Previously the slider saved into a dead legacy Base44 entity
// nothing read. The DISPLAY floor DEFAULT_MIN_SCORE is not affected.
router.get('/:id/discovery-preferences', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)
    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) return res.status(403).json({ error: 'Not authorized to view this profile' })
    const { getDiscoveryPreferences } = await import('../services/discoveryPreferences.js')
    res.json({ discovery: await getDiscoveryPreferences(req.db, profileId) })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.put('/:id/discovery-preferences', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)
    if (!canAccessProfileIdFromCtx(req.ctx, profileId)) return res.status(403).json({ error: 'Not authorized to manage this profile' })

    const { normalizeMinMatchScore, saveDiscoveryMinMatchScore, getDiscoveryPreferences } = await import('../services/discoveryPreferences.js')
    const raw = req.body?.min_match_score
    if (raw !== undefined && raw !== null && normalizeMinMatchScore(raw) === null) {
      return res.status(400).json({ error: 'min_match_score must be a number between 0 and 100 (or null to clear).' })
    }
    await saveDiscoveryMinMatchScore(req.db, profileId, raw ?? null, req.ctx?.userId ?? null)
    res.json({ discovery: await getDiscoveryPreferences(req.db, profileId) })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Aggregated "award amounts and from where" for the printable/PDF document.
// Pulls scholarships from the committed-college aid pipeline + the grants
// pipeline (with the opportunity sponsor/source). Read-only; profile-scoped.
router.get('/:id/award-summary', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)
    const profileRow = await req.db.prepare('SELECT id, display_name, user_id FROM profiles WHERE id = ?').get(profileId)
    if (!profileRow) return res.status(404).json({ error: 'Profile not found' })
    if (!canAccessProfileRowFromCtx(req.ctx, profileRow)) return res.status(403).json({ error: 'Not authorized to view this profile' })

    // Committed-college scholarships (financial_aid_pipeline on the committed app).
    let aidEntries = []
    let collegeName = null
    try {
      const uniRow = await req.db
        .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'university_applications' LIMIT 1`)
        .get(profileId)
      if (uniRow?.data) {
        const uni = typeof uniRow.data === 'string' ? JSON.parse(uniRow.data) : uniRow.data
        const committed = resolveCommittedCollege(uni)
        if (committed) {
          collegeName = committed.name || null
          aidEntries = Array.isArray(committed.financial_aid_pipeline) ? committed.financial_aid_pipeline : []
        }
      }
    } catch { /* no committed college / unparseable section */ }

    // Grants pipeline + opportunity sponsor/source.
    let grantRows = []
    try {
      grantRows = await req.db
        .prepare(
          `SELECT g.title, g.amount_awarded, g.amount_requested, g.amount_min, g.amount_max,
                  g.status, g.funder, g.url,
                  fo.sponsor, fo.source, fo.source_url
             FROM grants g
             LEFT JOIN funding_opportunities fo ON g.funding_opportunity_id = fo.id
            WHERE g.profile_id = ?`,
        )
        .all(profileId)
    } catch { grantRows = [] }

    const summary = buildAwardSummary({ aidEntries, collegeName, grantRows })
    res.json({
      profile: { id: profileRow.id, name: profileRow.display_name || 'Profile' },
      committed_college: collegeName,
      generated_at: new Date().toISOString(),
      summary,
    })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/', createProfileLimiter, async (req, res) => {
  const isAdmin = req.ctx?.isAdmin === true
  const userId = req.ctx?.userId ?? null
  const { display_name, primary_type: rawPrimaryType, organization_id, user_id, created_by, status = 'active', tags = [] } = req.body ?? {}
  const primary_type = canonicalizePrimaryTypeForSave(rawPrimaryType)

  if (!display_name || typeof display_name !== 'string') {
    return res.status(400).json({ error: 'display_name is required' })
  }

  // Check permissions
  if (!isAdmin) {
    // Enduser can only create profiles for themselves
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    
    if (user_id && user_id !== userId) {
      return res.status(403).json({ 
        error: 'Endusers can only create profiles for themselves' 
      })
    }
  } else {
    // Admin can create for anyone
    if (user_id && !(await req.db.prepare('SELECT id FROM users WHERE id = ?').get(user_id))) {
      return res.status(400).json({ error: 'Invalid user_id: user does not exist' })
    }
  }

  // Validate organization_id if provided
  if (organization_id) {
    const org = await req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(organization_id)
    if (!org) {
      return res.status(400).json({ error: 'Invalid organization_id: organization does not exist' })
    }
  }

  // Determine user_id for the new profile
  //
  // IMPORTANT:
  // profiles.user_id is UNIQUE (one "owned" profile per user). Admin-created profiles should NOT
  // default to being owned by the admin user/token, or subsequent creates will 500 and can surface as 502
  // behind a reverse proxy. Admins may explicitly set user_id to create an owned profile for a user.
  const profileUserId = isAdmin ? (user_id || null) : userId

  const profileId = crypto.randomUUID()
  // Ensure every newly created profile starts with all canonical sections + canonical keys.
  // This prevents downstream crawlers/scoring from encountering missing sections.
  await req.db.withTransaction(async (tx) => {
    const insert = tx.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, organization_id, user_id, created_by, status, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    await insert.run(
      profileId,
      display_name,
      primary_type ?? null,
      organization_id ?? null,
      profileUserId ?? null,
      created_by ?? req.ctx?.userId ?? req.ctx?.email ?? null,
      status,
      JSON.stringify(tags),
    )

    const upsertSection = tx.prepare(
      `
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, section_key) DO NOTHING
      `,
    )

    for (const sectionKey of supportedSectionKeys) {
      const defaults = getDefaultSectionData(sectionKey)
      await upsertSection.run(profileId, sectionKey, JSON.stringify(defaults ?? {}), 'system-create')
    }
  })

  await linkProfileToAdmin(req.db, profileId)

  // New-user free trial: every newly-created profile gets its OWN free period
  // starting now (self-expiring via billing_accounts.free_until, timer from
  // signup). The always-on signup trial (signupTrialGrant) is ON by default; a
  // concurrently-active Free Week promo can grant a LONGER period. We grant the
  // longer of the two ONCE — grantFreePeriod extends from any existing window,
  // so two calls would stack. Best-effort — never fail profile creation.
  try {
    const { freeWeekSignupGrant, signupTrialGrant } = await import('../../shared/freeWeek.js')
    const trial = signupTrialGrant(process.env)
    const promo = freeWeekSignupGrant(process.env)
    const candidates = [
      trial && { period: trial.period, days: trial.days, reason: 'signup_trial', grantedBy: 'signup_trial' },
      promo && { period: promo.period, days: promo.days, reason: 'free_week_signup', grantedBy: 'free_week_promo' },
    ].filter(Boolean)
    if (candidates.length) {
      const best = candidates.sort((a, b) => b.days - a.days)[0]
      const { grantFreePeriod } = await import('../services/billing/invoiceService.js')
      await grantFreePeriod(req.db, {
        profileId,
        kind: best.period,
        reason: best.reason,
        grantedBy: best.grantedBy,
        announce: false,
      })
    }
  } catch (err) {
    console.warn('[profiles] signup free-period grant failed', { profile_id: profileId, error: err?.message })
  }

  // Surface every real new signup in the admin "Applications" tab. A profile IS
  // an applicant, but self-serve signups previously created a profile WITHOUT
  // any service_applications row — so the Applications tab (which only saw the
  // public contact/intake form) stayed empty even as users joined, and the owner
  // had no single place to see new clients. We record a 'signup' application
  // linked to the profile. Synthetic/agent-trained and designated/demo profiles
  // are skipped so the list stays the owner's real client intake. Best-effort —
  // never fail profile creation if this write fails.
  try {
    const createdBy = String(created_by ?? req.ctx?.email ?? '').toLowerCase()
    const isSynthetic = createdBy.startsWith('agent:') || isDesignatedProfileId(profileId)
    if (!isSynthetic) {
      let applicantEmail = req.ctx?.email ?? null
      if (!applicantEmail && profileUserId) {
        try {
          const u = await req.db.prepare('SELECT primary_email FROM users WHERE id = ?').get(profileUserId)
          applicantEmail = u?.primary_email ?? null
        } catch { /* email is best-effort */ }
      }
      await req.db
        .prepare(
          `INSERT INTO service_applications (id, type, full_name, email, status, profile_id)
           VALUES (?, 'signup', ?, ?, 'new', ?)`,
        )
        .run(crypto.randomUUID(), display_name, applicantEmail, profileId)
    }
  } catch (err) {
    console.warn('[profiles] signup application record failed', { profile_id: profileId, error: err?.message })
  }

  const refreshed = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(profileId)

  // Schedule initial crawl jobs for the new profile (best-effort, non-blocking).
  // Idempotency keys prevent duplicate jobs on quick double-submits.
  try {
    const { createCrawlerJob } = await import('../services/crawlerJobCreation.js')
    // Local crawl: discover funding near the profile's location
    await createCrawlerJob(req.db, {
      type: 'local',
      profileId,
      parameters: { triggered_by: 'profile_create' },
      requestedBy: req.ctx?.userId ?? 'system',
    })
    // National crawl: broad eligibility check
    await createCrawlerJob(req.db, {
      type: 'national',
      profileId,
      parameters: { triggered_by: 'profile_create' },
      requestedBy: req.ctx?.userId ?? 'system',
    })
    // Dispatch the local job immediately (fire-and-forget)
    // dispatchCrawlerJob is already imported at the top of this module â no re-import needed.
    const localJob = await req.db
      .prepare(
        `SELECT id FROM crawler_jobs WHERE profile_id = ? AND type = 'local' AND status = 'queued' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(profileId)
    if (localJob?.id) {
      dispatchCrawlerJob({ db: req.db, jobId: localJob.id, uploadDir: getUploadsDir(req), getOpenAI }).catch((err) => {
        console.warn('[profiles] Failed to dispatch initial local crawl:', err?.message || String(err))
      })
    }
  } catch (scheduleError) {
    // Never fail profile creation because of a scheduling error.
    console.warn('[profiles] Failed to schedule initial crawl for new profile:', scheduleError?.message || String(scheduleError))
  }

  // "All incoming profiles, do the same" — enqueue the SMS consent ask for any
  // phone this profile already has in `none` state (sends now if Twilio is
  // configured + the number isn't suppressed; otherwise the next consent
  // campaign tick asks). Best-effort, fire-and-forget; never blocks creation.
  try {
    const { requestConsentForProfile } = await import('../services/comms/smsConsentService.js')
    requestConsentForProfile(req.db, { profileId }).catch((err) => {
      console.warn('[profiles] consent enqueue failed for new profile:', err?.message || String(err))
    })
  } catch (consentError) {
    console.warn('[profiles] consent enqueue unavailable for new profile:', consentError?.message || String(consentError))
  }

  res.status(201).json(mapProfile(refreshed))
})

// Back-compat for older deployed clients:
// GET /api/profiles/:id/applications/all
// Returns every application workflow row linked to this profile without failing
// when a newer/older deployment does not have one of the optional tables yet.
router.get('/:id/applications/all', async (req, res) => {
  const { id } = req.params

  try {
    const profile = await req.db
      .prepare('SELECT id, organization_id, status FROM profiles WHERE id = ?')
      .get(String(id))

    if (!profile || profile.status === 'deleted') {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const grantApplications = await optionalRows(
      req.db,
      'grant_applications',
      `
        SELECT
          id,
          profile_id,
          opportunity_id,
          pipeline_grant_id,
          user_id,
          status,
          title,
          grant_name,
          funder_name,
          amount_requested,
          amount_awarded,
          deadline_date,
          submitted_at,
          response_expected_date,
          response_received_at,
          notes,
          contact_name,
          contact_email,
          created_at,
          updated_at,
          'grant_applications' AS source_table
        FROM grant_applications
        WHERE profile_id = ?
        ORDER BY updated_at DESC
        LIMIT 500
      `,
      [String(id)],
    )

    const vnextApplications = await optionalRows(
      req.db,
      'vnext_applications',
      `
        SELECT
          id,
          profile_id,
          opportunity_id,
          NULL AS pipeline_grant_id,
          NULL AS user_id,
          state AS status,
          NULL AS title,
          NULL AS grant_name,
          NULL AS funder_name,
          NULL AS amount_requested,
          NULL AS amount_awarded,
          NULL AS deadline_date,
          NULL AS submitted_at,
          NULL AS response_expected_date,
          NULL AS response_received_at,
          NULL AS notes,
          NULL AS contact_name,
          NULL AS contact_email,
          created_at,
          updated_at,
          'vnext_applications' AS source_table
        FROM vnext_applications
        WHERE profile_id = ?
        ORDER BY updated_at DESC
        LIMIT 500
      `,
      [String(id)],
    )

    const applyEngineApplications = profile.organization_id
      ? await optionalRows(
          req.db,
          'applications',
          `
            SELECT
              a.id,
              ? AS profile_id,
              g.funding_opportunity_id AS opportunity_id,
              a.grant_id AS pipeline_grant_id,
              NULL AS user_id,
              a.status,
              g.title,
              g.title AS grant_name,
              g.funder AS funder_name,
              NULL AS amount_requested,
              NULL AS amount_awarded,
              g.deadline AS deadline_date,
              a.submitted_at,
              NULL AS response_expected_date,
              NULL AS response_received_at,
              NULL AS notes,
              NULL AS contact_name,
              NULL AS contact_email,
              a.created_at,
              a.updated_at,
              'applications' AS source_table
            FROM applications a
            LEFT JOIN grants g ON g.id = a.grant_id
            WHERE a.organization_id = ?
            ORDER BY a.updated_at DESC
            LIMIT 500
          `,
          [String(id), String(profile.organization_id)],
        )
      : []

    const applications = [
      ...grantApplications,
      ...vnextApplications,
      ...applyEngineApplications,
    ].map((row) => ({
      // Reconcile every tracked item (regardless of source feature) onto ONE
      // canonical pipeline stage so discovery→action reads as a single lifecycle
      // (mission goal #10). Read-only annotation; underlying status is unchanged.
      ...row,
      canonical_stage: applicationStatusToStage(row.status),
    }))

    profileLogger.info('[profiles] applications/all response', {
      profileId: String(id),
      grant_applications: grantApplications.length,
      vnext_applications: vnextApplications.length,
      applications: applyEngineApplications.length,
      total: applications.length,
    })

    return res.json({
      success: true,
      profile_id: String(id),
      applications,
      items: applications,
      grant_applications: grantApplications,
      vnext_applications: vnextApplications,
      apply_engine_applications: applyEngineApplications,
      count: applications.length,
      total: applications.length,
    })
  } catch (error) {
    console.error('[profiles] applications/all failed:', {
      profileId: String(id),
      error: error?.message || String(error),
    })
    return res.status(500).json(formatError(error))
  }
})

// -----------------------------------------------------------------------------
// GET /api/profiles/:id/report-packet
// -----------------------------------------------------------------------------
// One backend call that returns everything the printable "Profile Packet"
// needs, in one stable shape:
//
//   {
//     profile,                  // mapProfile() row + sections
//     pipeline_grants: [...],   // every grant for this profile + latest_automation
//     handoffs: [...],          // subset of pipeline_grants flagged for human review
//     potential_funds: [...],   // reserved — currently always [] (the funding-
//                               // results store is client-only today). Kept as a
//                               // field so the print component can render the
//                               // section header without conditionals.
//     stage_summary: [...],     // [{ status, label, count }] across pipeline_grants
//     generated_at: ISO string
//   }
//
// MUST be declared BEFORE `GET /:id` or Express will route /report-packet
// into the generic profile-by-id handler.
// -----------------------------------------------------------------------------
router.get('/:id/report-packet', async (req, res) => {
  const { id } = req.params
  const isAdmin = req.ctx?.isAdmin === true
  const userId = req.ctx?.userId ?? null

  // 1. Load profile row + access check.
  let row = null
  try {
    row = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(String(id))
  } catch (error) {
    profileLogger.error('[profiles] report-packet: failed to load profile row', { id, err: error?.message })
    return res.status(500).json(formatError(error))
  }
  if (!row || row.status === 'deleted') {
    return res.status(404).json({ error: 'Profile not found' })
  }
  if (!isAdmin) {
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    if (!canAccessProfileRowFromCtx(req.ctx, row)) {
      return res.status(403).json({ error: 'Access denied' })
    }
  }

  // 2. Profile sections (same shape as GET /:id).
  let sections = []
  try {
    const rawRows = await req.db
      .prepare(
        `SELECT section_key, data, updated_at, updated_by
         FROM profile_sections
         WHERE profile_id = ?
         ORDER BY section_key`,
      )
      .all(String(id))
    sections = coerceDbRows(rawRows).map((s) => ({
      section_key: s.section_key,
      data: normalizeProfileSectionData(s.section_key, safeParseJSON(s.data, {})),
      updated_at: s.updated_at,
      updated_by: s.updated_by,
    }))
  } catch (error) {
    profileLogger.warn('[profiles] report-packet: sections load failed', { id, err: error?.message })
    sections = []
  }

  // 3. Pipeline grants for this profile + the latest automation event per grant.
  //
  // We do this in two queries instead of a window-function join because
  // production Postgres + the SQLite fallback used in tests don't share
  // identical row_number() syntax — two passes keep the code portable.
  let grants = []
  try {
    grants = await req.db
      .prepare(
        `SELECT g.*, o.name AS organization_name
         FROM grants g
         LEFT JOIN organizations o ON g.organization_id = o.id
         WHERE g.profile_id = ?
         ORDER BY
           CASE
             WHEN g.status IN ('portal','follow_up','report') THEN 0
             WHEN g.status IN ('drafting','application_prep','app_prep','revision') THEN 1
             WHEN g.status IN ('submitted','pending_review','under_review') THEN 2
             WHEN g.status IN ('discovery','discovered','interested') THEN 3
             ELSE 4
           END,
           g.deadline ASC NULLS LAST,
           g.created_date DESC`,
      )
      .all(String(id))
  } catch (error) {
    // Some legacy DBs don't have NULLS LAST or created_date. Fall back to
    // a plain query that just sorts by id — never let this 500.
    profileLogger.warn('[profiles] report-packet: rich grants query failed, using fallback', {
      id,
      err: error?.message,
    })
    try {
      grants = await req.db
        .prepare(
          `SELECT g.*, o.name AS organization_name
           FROM grants g
           LEFT JOIN organizations o ON g.organization_id = o.id
           WHERE g.profile_id = ?
           ORDER BY g.id DESC`,
        )
        .all(String(id))
    } catch (fallbackError) {
      profileLogger.warn('[profiles] report-packet: fallback grants query failed', {
        id,
        err: fallbackError?.message,
      })
      grants = []
    }
  }

  const grantIds = (grants || []).map((g) => g?.id).filter(Boolean)

  // Latest pipeline_automation event per grant — single query, then group.
  // We rely on grant_pipeline_events.created_at being monotonic (same pattern
  // GET /:id/automation/latest uses).
  let latestEventsByGrant = new Map()
  if (grantIds.length > 0) {
    try {
      const placeholders = grantIds.map(() => '?').join(',')
      const events = await req.db
        .prepare(
          `SELECT *
           FROM grant_pipeline_events
           WHERE grant_id IN (${placeholders})
           ORDER BY created_at DESC`,
        )
        .all(...grantIds)
      for (const ev of events || []) {
        if (!ev?.grant_id) continue
        // First row wins (DESC order), so only set once per grant.
        if (!latestEventsByGrant.has(ev.grant_id)) {
          latestEventsByGrant.set(ev.grant_id, ev)
        }
      }
    } catch (error) {
      profileLogger.warn('[profiles] report-packet: events load failed', {
        id,
        err: error?.message,
      })
      latestEventsByGrant = new Map()
    }
  }

  // 4. Re-use the same shaping helper grants.js exports for /automation/latest
  //    so this endpoint's `latest_automation` field is byte-identical to the
  //    one the per-grant detail screen renders. We import lazily to dodge a
  //    potential circular import.
  let mapAutomationEvent = (r) => r
  try {
    const grantsModule = await import('./grants.js')
    if (typeof grantsModule.mapAutomationEvent === 'function') {
      mapAutomationEvent = grantsModule.mapAutomationEvent
    }
  } catch {
    // Soft-fall: leave raw rows in place. UI tolerates both shapes.
  }

  const HUMAN_STAGES = new Set(['portal', 'follow_up', 'report'])
  const pipelineGrants = (grants || []).map((g) => {
    const evRow = latestEventsByGrant.get(g.id) || null
    const latest_automation = evRow ? mapAutomationEvent(evRow) : null
    const matchReasons = safeParseJSON(g.match_reasons, [])
    return {
      id: g.id,
      title: g.title,
      funder: g.funder,
      status: g.status,
      deadline: g.deadline,
      amount_min: g.amount_min,
      amount_max: g.amount_max,
      amount_requested: g.amount_requested,
      match_score: g.match_score ?? g.match ?? null,
      match_reasons: Array.isArray(matchReasons) ? matchReasons : [],
      application_url: g.application_url || g.url || g.source_url || null,
      organization_id: g.organization_id || null,
      organization_name: g.organization_name || null,
      notes: g.notes || null,
      latest_automation,
      needs_human_review:
        (latest_automation?.handoff_required === true) ||
        HUMAN_STAGES.has(String(g.status || '').toLowerCase()),
    }
  })

  const handoffs = pipelineGrants.filter((g) => g.needs_human_review)

  // Stage summary: [{ status, count }] over the visible grants. The packet
  // print groups by status, so giving the UI a pre-computed counter
  // avoids it having to re-walk the full list to render section headers.
  const stageCounts = new Map()
  for (const g of pipelineGrants) {
    const key = String(g.status || 'unknown').toLowerCase()
    stageCounts.set(key, (stageCounts.get(key) || 0) + 1)
  }
  const stage_summary = Array.from(stageCounts.entries()).map(([status, count]) => ({
    status,
    count,
  }))

  return res.json({
    profile: { ...mapProfile(row), sections },
    pipeline_grants: pipelineGrants,
    handoffs,
    // Reserved for a future server-side cache of high-match opportunities
    // not yet in the pipeline. The UI renders the section header either
    // way so always emit the (possibly empty) field.
    potential_funds: [],
    stage_summary,
    generated_at: new Date().toISOString(),
  })
})

// PIPELINE_ACTIVE_STATUSES / pipelineValueSql are imported from
// backend/config/pipelineValue.js (the single choke point) so the headline
// `pipeline_funds_total`, the per-source breakdown below, and the dashboard
// stats can never drift apart again.

router.get('/:id', async (req, res) => {
  const { id } = req.params
  const isAdmin = req.ctx?.isAdmin === true
  const userId = req.ctx?.userId ?? null

  let row = null
  try {
    row = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  } catch (error) {
    console.error('[profiles] Failed to load profile row:', error)
    return res.status(500).json(formatError(error))
  }

  if (!row) {
    return res.status(404).json({ error: 'Profile not found' })
  }

    // Treat soft-deleted profiles as if they don't exist.
    if (row.status === 'deleted') {
          return res.status(404).json({ error: 'Profile not found' })
            }

  // Check access permissions
  if (!isAdmin) {
    // Enduser: can only access profiles where user_id matches
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    if (!canAccessProfileRowFromCtx(req.ctx, row)) {
      return res.status(403).json({ error: 'Access denied' })
    }
  }

  let sections = []
  try {
    const rawRows = await req.db
      .prepare(
        `
        SELECT section_key, data, updated_at, updated_by
        FROM profile_sections
        WHERE profile_id = ?
        ORDER BY section_key
      `,
      )
      .all(id)
    sections = coerceDbRows(rawRows).map((section) => ({
      section_key: section.section_key,
      // Read-time normalizer: idempotent, no destructive writes — just guarantees
      // known list fields (housing.geographic_designation, programs_services.*) reach
      // the client as string[] so fieldDisplay never sees a legacy string/object shape.
      data: normalizeProfileSectionData(section.section_key, safeParseJSON(section.data, {})),
      updated_at: section.updated_at,
      updated_by: section.updated_by,
    }))
  } catch (error) {
    // Never 500 just because sections are missing/migrating â return empty array.
    console.warn('[profiles] Unable to load profile sections:', id, error?.message)
    sections = []
  }

  let billing = null
  try {
    billing = mapAccountRow(await ensureBillingAccount(req.db, id))
  } catch (error) {
    console.warn('[profiles] Unable to load billing account for profile', id, error?.message || error)
    billing = null
  }

  // Compute pipeline_funds_total for the detail view (same logic as enrichProfileWithSummary).
  // Uses the shared PIPELINE_ACTIVE_STATUSES so the /:id/pipeline-potential
  // breakdown below always reconciles to this number.
  let pipelineTotal = 0
  const activeStatuses = PIPELINE_ACTIVE_STATUSES
  const pipelinePlaceholders = activeStatuses.map(() => '?').join(',')
  try {
    const pipelineRow = await req.db
      .prepare(
        `SELECT COALESCE(SUM(${pipelineValueSql('g')}), 0) as total FROM grants g WHERE g.profile_id = ? AND g.status IN (${pipelinePlaceholders})`,
      )
      .get(row.id, ...activeStatuses)
    pipelineTotal = pipelineRow?.total ?? 0
  } catch (error) {
    // Fall back to organization-level total if profile_id column doesn't exist
    const msg = error?.message || String(error)
    if (!/profile_id/i.test(msg)) {
      console.warn('[profiles] pipeline detail query failed; falling back to org total:', msg)
    }
    try {
      const pipelineRow = await req.db
        .prepare(
          `SELECT COALESCE(SUM(${pipelineValueSql('g')}), 0) as total FROM grants g WHERE g.organization_id = ? AND g.status IN (${pipelinePlaceholders})`,
        )
        .get(row.organization_id, ...activeStatuses)
      pipelineTotal = pipelineRow?.total ?? 0
    } catch (fallbackError) {
      console.warn('[profiles] pipeline org detail query failed:', fallbackError?.message)
      pipelineTotal = 0
    }
  }

  return res.json({
    ...mapProfile(row),
    sections,
    billing,
    pipeline_funds_total: pipelineTotal,
  })
})

// GET /api/profiles/:id/pipeline-potential
//
// The per-source breakdown behind a profile's "Pipeline Potential" figure:
// which funding sources make it up, a short description of each, the dollar
// amount or range, the deadline to apply, and the current pipeline stage
// (so the operator can see whether each has been applied / is under review /
// etc.). This powers the click-through on the Pipeline Potential card.
//
// Scoped exactly like the profile detail route — only someone who can already
// see the profile can see its private pipeline numbers.
router.get('/:id/pipeline-potential', async (req, res) => {
  const { id } = req.params
  const isAdmin = req.ctx?.isAdmin === true
  const userId = req.ctx?.userId ?? null

  let row = null
  try {
    row = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  } catch (error) {
    console.error('[profiles] Failed to load profile row for pipeline-potential:', error)
    return res.status(500).json(formatError(error))
  }
  if (!row || row.status === 'deleted') {
    return res.status(404).json({ error: 'Profile not found' })
  }
  if (!isAdmin) {
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    if (!canAccessProfileRowFromCtx(req.ctx, row)) {
      return res.status(403).json({ error: 'Access denied' })
    }
  }

  const placeholders = PIPELINE_ACTIVE_STATUSES.map(() => '?').join(',')
  let items = []
  try {
    const rows = await req.db
      .prepare(
        `SELECT g.id, g.title, g.funder, g.status, g.deadline,
                g.amount_requested, g.amount_min, g.amount_max,
                COALESCE(g.amount_text, fo.amount_text) AS amount_text,
                COALESCE(g.amount_status, fo.amount_status) AS amount_status,
                g.notes, fo.description AS opportunity_description,
                g.contact_name, g.contact_email, g.contact_phone,
                g.funder_fax, g.funder_address,
                g.application_url, g.application_method,
                fo.application_url AS opportunity_application_url
           FROM grants g
           LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
          WHERE g.profile_id = ? AND g.status IN (${placeholders})
          ORDER BY COALESCE(g.amount_requested, g.amount_max, g.amount_min, 0) DESC, g.title ASC`,
      )
      .all(id, ...PIPELINE_ACTIVE_STATUSES)
    items = (rows || []).map((g) => {
      const desc = (g.notes && String(g.notes).trim()) || g.opportunity_description || null
      const norm = (v) => {
        const s = (v === null || v === undefined) ? '' : String(v).trim()
        return s.length ? s : null
      }
      return {
        id: g.id,
        title: g.title,
        funder: g.funder || null,
        status: g.status,
        deadline: g.deadline || null,
        amount_requested: g.amount_requested ?? null,
        amount_min: g.amount_min ?? null,
        amount_max: g.amount_max ?? null,
        // A fuller description for the printable packet (still capped).
        description: desc ? String(desc).slice(0, 600) : null,
        // Contact + how-to-apply, so the printout stands on its own.
        contact_name: norm(g.contact_name),
        contact_email: norm(g.contact_email),
        contact_phone: norm(g.contact_phone),
        contact_fax: norm(g.funder_fax),
        contact_address: norm(g.funder_address),
        application_url: norm(g.application_url) || norm(g.opportunity_application_url),
        application_method: norm(g.application_method),
      }
    })
  } catch (error) {
    // Legacy DBs without grants.profile_id: degrade to an empty breakdown
    // rather than 500 (the headline total already has the same fallback).
    if (!/profile_id/i.test(error?.message || '')) {
      console.warn('[profiles] pipeline-potential query failed:', error?.message)
    }
    items = []
  }

  // Same value fallback as the headline total and the frontend's
  // estimatedValue(), so the breakdown reconciles with the card.
  const total = items.reduce((sum, g) => sum + grantPipelineValue(g), 0)
  return res.json({ profile_id: id, total, count: items.length, items })
})

const TOP_LEVEL_PROFILE_KEYS = new Set(['display_name', 'primary_type', 'organization_id', 'status', 'tags'])

// GET /api/profiles/:id/readiness — profile completeness gate
// Returns whether the profile has enough data for meaningful matching.
router.get('/:id/readiness', async (req, res) => {
  const { id } = req.params
  try {
    const { checkProfileReadiness } = await import('../services/profileReadinessService.js')
    const result = await checkProfileReadiness(req.db, id)
    return res.status(200).json({
      profile_id: id,
      ...result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

// GET /api/profiles/:id/readiness/detailed — 10-category breakdown with
// per-category guidance, used by the ProfileReadinessScore component and
// by Robert when deciding match quality.
router.get('/:id/readiness/detailed', async (req, res) => {
  const { id } = req.params
  try {
    const { computeDetailedReadiness } = await import('../services/profileReadinessService.js')
    const result = await computeDetailedReadiness(req.db, id)
    return res.status(200).json(result)
  } catch (error) {
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.put('/:id', async (req, res) => {
  const { id } = req.params
  const body = req.body ?? {}
  const { display_name, primary_type, organization_id, status, tags } = body
  const isAdmin = req.ctx?.isAdmin === true
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  const existing = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    return res.status(404).json({ error: 'Profile not found' })
  }

    // Reject mutations on soft-deleted profiles so they stay invisible.
    if (existing.status === 'deleted') {
          return res.status(404).json({ error: 'Profile not found' })
            }

  // Allow: admins (including admin-email allowlist), profile-scoped tokens for the profile, or session owners (userId match)
  const userIsAdmin = Boolean(isAdmin)
  const matchesProfileId = authProfileId === String(id)
  const matchesUserId = authUserId && existing.user_id && authUserId === existing.user_id
  if (!userIsAdmin && !matchesProfileId && !matchesUserId) {
    return denyAuth(req, res)
  }

  const updates = []
  const values = []

  if (display_name !== undefined) {
    if (typeof display_name !== 'string' || display_name.trim() === '') {
      return res.status(400).json({ error: 'display_name must be a non-empty string' })
    }
    updates.push('display_name = ?')
    values.push(display_name)
  }

  if (primary_type !== undefined) {
    updates.push('primary_type = ?')
    values.push(canonicalizePrimaryTypeForSave(primary_type) || null)
  }

  if (organization_id !== undefined) {
    // Validate organization_id if provided and not null
    if (organization_id) {
      const org = await req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(organization_id)
      if (!org) {
        return res.status(400).json({ error: 'Invalid organization_id: organization does not exist' })
      }
    }
    updates.push('organization_id = ?')
    values.push(organization_id || null)
  }

  if (status !== undefined) {
    updates.push('status = ?')
    values.push(status)
  }

  if (tags !== undefined) {
    updates.push('tags = ?')
    values.push(JSON.stringify(tags ?? []))
  }

  if (updates.length > 0) {
    const stmt = req.db.prepare(`UPDATE profiles SET ${updates.join(', ')} WHERE id = ?`)
    await stmt.run(...values, id)
  }

  if (display_name !== undefined) {
    try {
      await syncDisplayNameToBasicInformation(req.db, id, display_name)
    } catch (syncErr) {
      console.warn(`[profiles] display_name → basic_information sync failed for ${id}:`, syncErr?.message)
    }
  }

  // Persist flat application fields into profile_sections so application settings save and completeness updates.
  const flatFieldMap = getFlatFieldToSectionMap()
  const sectionUpdatesByKey = new Map()
  for (const [key, value] of Object.entries(body)) {
    if (TOP_LEVEL_PROFILE_KEYS.has(key)) continue
    const mapping = flatFieldMap.get(key)
    if (!mapping) continue
    const { sectionKey, storageKey } = mapping
    if (!sectionUpdatesByKey.has(sectionKey)) sectionUpdatesByKey.set(sectionKey, {})
    sectionUpdatesByKey.get(sectionKey)[storageKey] = value
  }

  if (sectionUpdatesByKey.size > 0) {
    const selectSection = req.db.prepare(
      'SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?'
    )
    const upsertSection = req.db.prepare(
      `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, section_key) DO UPDATE SET
         data = excluded.data,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`
    )
    const updatedBy = req.ctx?.userId ?? req.ctx?.email ?? 'profile-put'
    const sectionRows = await req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(id)
    const existingSections = Object.fromEntries(
      sectionRows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
    )
    for (const [sectionKey, patch] of sectionUpdatesByKey) {
      // PostgresTx prepared-statement methods return Promises — must be awaited.
      // Previously these were fire-and-forget on Postgres, which meant section
      // patches submitted via PUT /api/profiles/:id silently dropped on the
      // floor instead of persisting.
      const row = await selectSection.get(id, sectionKey)
      const existingData = row?.data ? safeParseJSON(row.data, {}) : {}
      const merged = { ...existingData, ...patch }
      const guarded = guardProfileSectionPayload(merged, {
        profile: existing,
        sections: { ...existingSections, [sectionKey]: merged },
        sectionKey,
        existing: existingData,
      })
      logProfileSectionRejections(id, sectionKey, guarded.rejected)
      await upsertSection.run(id, sectionKey, JSON.stringify(guarded.data), updatedBy)
    }
  }

  const updated = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  res.json(mapProfile(updated))
})

// Durable tombstone so boot seeders (ensureDesignatedProfiles, seedBaselineFromRepo)
// never resurrect a deleted designated profile — even if its profiles row is gone.
// Mirrors the canonical pattern in routes/admin.js.
async function writeProfileTombstone(db, profileId, deletedBy, reason) {
  const isPostgres = db?.dialect === 'postgres'
  await db.prepare(
    isPostgres
      ? `CREATE TABLE IF NOT EXISTS profile_tombstones (
           profile_id TEXT PRIMARY KEY,
           deleted_at TIMESTAMPTZ DEFAULT now(),
           deleted_by TEXT,
           reason TEXT
         )`
      : `CREATE TABLE IF NOT EXISTS profile_tombstones (
           profile_id TEXT PRIMARY KEY,
           deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
           deleted_by TEXT,
           reason TEXT
         )`,
  ).run()
  await db.prepare(
    `INSERT INTO profile_tombstones (profile_id, deleted_at, deleted_by, reason)
     VALUES (?, CURRENT_TIMESTAMP, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       deleted_at = CURRENT_TIMESTAMP,
       deleted_by = excluded.deleted_by,
       reason = excluded.reason`,
  ).run(String(profileId), deletedBy || null, reason || null)
}

router.delete('/:id', async (req, res) => {
  const { id } = req.params
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  // Check authorization - user must be admin or the profile must belong to them
  const existing = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  const admin = req.ctx?.isAdmin === true
  if (!admin) {
    const matchesProfileId = authProfileId === String(id)
    const matchesUserId = authUserId && existing.user_id && String(authUserId) === String(existing.user_id)
    if (!matchesProfileId && !matchesUserId) {
      return denyAuth(req, res)
    }
  }

  // Designated/demo profiles are intentionally "ensured" by boot-time seeding.
  // If we hard-delete them, the seeder will re-create them on the next run.
  // So for these IDs, always use a durable tombstone (soft-delete) AND write a
  // profile_tombstones row. The status='deleted' flag alone is NOT enough: if
  // the row ever disappears (a prior hard delete, a drifted DB), the seeders'
  // `WHERE status <> 'deleted'` guard has no row to check and they re-INSERT a
  // fresh empty profile every boot. The tombstone row is what both
  // ensureDesignatedProfiles and seedBaselineFromRepo consult to stay away
  // permanently. (Root cause of the recurring "deleted profile reappears" flap.)
  if (isDesignatedProfileId(id)) {
    await req.db
      .prepare("UPDATE profiles SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(id)
    try {
      await writeProfileTombstone(req.db, id, authUserId, 'soft_deleted_designated_profile')
    } catch (tombErr) {
      console.warn('[profiles] failed to write profile tombstone (soft-delete still applied):', String(id), tombErr?.message || tombErr)
    }
    console.warn('[profiles] Soft-deleted designated profile (tombstoned):', String(id))
    return res.status(204).send()
  }

  // Delete the profile.
  //
  // IMPORTANT (Postgres):
  // Hard DELETE can fail due to FK RESTRICT constraints, and setting profile_id = NULL during cleanup
  // can also fail when those columns are NOT NULL. To avoid 500s, fall back to a reliable soft-delete.
  try {
    const stmt = req.db.prepare('DELETE FROM profiles WHERE id = ?')
    await stmt.run(id)
  } catch (error) {
    console.warn('[profiles] Hard DELETE failed; soft-deleting profile:', id, error?.message || error)

    // Best-effort cleanup of rows owned by the profile. Do NOT attempt `SET profile_id = NULL`.
    try {
      await req.db.withTransaction(async (tx) => {
        try {
          await tx.prepare('DELETE FROM profile_documents WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM profile_sections WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM crawler_jobs WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM crawler_schedules WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM anya_tool_usage WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM anya_tasks WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM anya_sessions WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM service_applications WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM funding_opportunities WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx
            .prepare(
              `
                DELETE FROM billing_account_events
                WHERE account_id IN (SELECT id FROM billing_accounts WHERE profile_id = ?)
              `,
            )
            .run(id)
          await tx.prepare('DELETE FROM billing_accounts WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }

        await tx
          .prepare("UPDATE profiles SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(id)
      })
    } catch (softDeleteError) {
      // If the transaction fails (schema drift, missing tables, etc.), still attempt a direct soft delete.
      console.warn('[profiles] Soft-delete transaction failed; attempting direct soft-delete:', id, softDeleteError?.message || softDeleteError)
      await req.db
        .prepare("UPDATE profiles SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(id)
    }
  }

  // Clean up avatar file if it exists
  if (existing.avatar_url && existing.avatar_url.startsWith('/uploads/')) {
    const filename = existing.avatar_url.replace('/uploads/', '')
    if (filename) {
      const avatarPath = join(getUploadsDir(req), filename)
      fs.unlink(avatarPath, (err) => {
        if (err) console.warn('Failed to delete avatar file:', err)
      })
    }
  }

  res.status(204).send()
})

/**
 * Persist avatar BYTES durably, mirroring the manual-upload path so every
 * avatar source (upload, website-logo, AI) stores identically:
 *   - profiles.avatar_data BYTEA + avatar_content_type = the durable source of
 *     truth (survives Railway's ephemeral filesystem resets — see the
 *     ephemeral-FS pattern), and
 *   - profiles.avatar_url = a /uploads/<file> marker, with a best-effort copy
 *     written to disk as a fast-path read cache.
 * Falls back to a path-only update if the avatar_data columns are not yet
 * present (migration pending) so the operation never 500s.
 *
 * @param {object} args
 * @param {object} args.req - express request (for db + uploads dir)
 * @param {string} args.id - profile id
 * @param {Buffer} args.buffer - image bytes
 * @param {string} args.contentType - image content type
 * @param {string} [args.ext] - file extension hint (default png)
 * @param {string|null} [args.previousAvatarUrl] - prior avatar_url to clean up
 */
async function persistAvatarBytes({ req, id, buffer, contentType, ext = 'png', previousAvatarUrl = null }) {
  const safeExt = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
  const filename = `avatar_${String(id)}_${Date.now()}.${safeExt}`
  const publicPath = `/uploads/${filename}`
  const avatarContentType = contentType || guessImageContentType(filename)

  // Best-effort: drop the file into /uploads as a fast-path read cache. If the
  // disk is read-only or wiped, the download endpoint falls back to the DB
  // BYTEA, so a failure here is non-fatal. AWAIT the write so the cache is
  // actually present when we respond — the previous fire-and-forget
  // (fs.writeFile(..., () => {})) returned before the bytes hit disk, which made
  // the read-cache racy (and the persistence test intermittently fail in CI).
  try {
    await fs.promises.writeFile(join(getUploadsDir(req), filename), buffer)
  } catch { /* ignore — DB copy is authoritative */ }

  try {
    await req.db
      .prepare('UPDATE profiles SET avatar_url = ?, avatar_data = ?, avatar_content_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(publicPath, buffer, avatarContentType, id)
  } catch (colErr) {
    if (/avatar_data|avatar_content_type|column/i.test(String(colErr?.message || colErr))) {
      await req.db
        .prepare('UPDATE profiles SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(publicPath, id)
    } else {
      throw colErr
    }
  }

  if (previousAvatarUrl && String(previousAvatarUrl).startsWith('/uploads/')) {
    const previousFilename = String(previousAvatarUrl).replace('/uploads/', '')
    if (previousFilename && previousFilename !== filename) {
      const previousPath = join(getUploadsDir(req), previousFilename)
      fs.unlink(previousPath, () => {})
    }
  }

  return { filename, publicPath }
}

router.post('/:id/avatar', runUploadSingle('avatar'), async (req, res, next) => {
  const { id } = req.params
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  const existing = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    // Memory storage: nothing on disk to clean up.
    return res.status(404).json({ error: 'Profile not found' })
  }

  const userIsAdmin = req.ctx?.isAdmin === true
  const matchesProfileId = authProfileId === String(id)
  const matchesUserId = authUserId && existing.user_id && authUserId === existing.user_id

  if (!userIsAdmin && !matchesProfileId && !matchesUserId) {
    return denyAuth(req, res)
  }

  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'Avatar file is required' })
  }

  try {
    // The bytes came straight from the upload into req.file.buffer (memory
    // storage), so they persist across Railway's ephemeral-filesystem resets.
    const ext = String(req.file.originalname || '').includes('.')
      ? req.file.originalname.split('.').pop()
      : 'png'
    await persistAvatarBytes({
      req,
      id,
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      ext,
      previousAvatarUrl: existing.avatar_url,
    })

    const updated = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    res.json(mapProfile(updated))
  } catch (error) {
    next(error)
  }
})

// POST /api/profiles/:id/avatar/from-website
// Derive the profile picture from the org's OWN public website (their real
// logo). Intended for ORGANIZATION profiles, where the homepage logo is the
// most authentic avatar; individual profiles should use upload / AI instead.
//
// Resolves the website from the request body (website / website_hint) or, if
// absent, the profile's basic_information section. Fetches the homepage,
// extracts a logo (og:image -> apple-touch-icon -> favicon -> prominent <img>),
// downloads the bytes and stores them through the SAME durable BYTEA path the
// upload uses. On any failure (no website, fetch blocked, no usable logo) it
// returns a structured reason so the UI can fall back to AI generation /
// initials. Manual upload always remains available.
router.post('/:id/avatar/from-website', async (req, res, next) => {
  const { id } = req.params
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  const existing = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Profile not found' })
  }

  const userIsAdmin = req.ctx?.isAdmin === true
  const matchesProfileId = authProfileId === String(id)
  const matchesUserId = authUserId && existing.user_id && authUserId === existing.user_id
  if (!userIsAdmin && !matchesProfileId && !matchesUserId) {
    return denyAuth(req, res)
  }

  try {
    // Resolve the website: explicit body value wins, else the profile's
    // basic_information section (the canonical home for the org website URL).
    let website = normalizeHttpUrl(req.body?.website ?? req.body?.website_hint)
    if (!website) {
      const sectionRow = await req.db
        .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
        .get(id, 'basic_information')
      const data = sectionRow?.data ? safeParseJSON(sectionRow.data, {}) : {}
      website = normalizeHttpUrl(data?.website)
    }

    if (!website) {
      return res.status(422).json({
        ok: false,
        code: 'NO_WEBSITE',
        reason: 'no_website',
        message: 'No website is on file for this profile. Add one or upload a photo.',
      })
    }

    const logo = await fetchOrgLogo(website)
    if (!logo.ok) {
      // Graceful failure: surface the reason so the UI can offer AI fallback.
      return res.status(422).json({
        ok: false,
        code: 'NO_LOGO',
        reason: logo.reason,
        website,
        message:
          'We could not find a usable logo on that website. Try AI generation or upload a photo.',
      })
    }

    const ext = extensionFromImageContentType(logo.contentType)
    await persistAvatarBytes({
      req,
      id,
      buffer: logo.buffer,
      contentType: logo.contentType,
      ext,
      previousAvatarUrl: existing.avatar_url,
    })

    const updated = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    res.json({
      ok: true,
      method: logo.method,
      website: logo.website,
      source_url: logo.sourceUrl,
      profile: mapProfile(updated),
    })
  } catch (error) {
    next(error)
  }
})

router.post('/:id/avatar/ai', async (req, res) => {
  const { id } = req.params
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  // Fail loudly if upload storage is unavailable; this job writes a file under /uploads.
  const uploadStorageStatus = req?.storageStatus || req?.app?.locals?.uploads?.storageStatus || null
  if (uploadStorageStatus && uploadStorageStatus.writable === false) {
    return res.status(503).json({
      ok: false,
      error: 'Upload storage is unavailable',
      code: 'UPLOAD_STORAGE_UNAVAILABLE',
      uploads_dir: uploadStorageStatus.uploads_dir || null,
      status: uploadStorageStatus.status || 'degraded',
    })
  }

  const profileRow = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profileRow) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  const userIsAdmin = req.ctx?.isAdmin === true
  const matchesProfileId = authProfileId === String(id)
  const matchesUserId = authUserId && profileRow.user_id && authUserId === profileRow.user_id
  if (!userIsAdmin && !matchesProfileId && !matchesUserId) {
    return denyAuth(req, res)
  }

  if (!(await requireTierCapability(req, res, id, TIER_CAPABILITIES.DOCUMENT_AI))) return

  const parameters = {
    display_name: profileRow.display_name,
    primary_type: profileRow.primary_type,
  }

  const websiteHint = normalizeHttpUrl(req.body?.website_hint ?? req.body?.website)
  if (websiteHint) {
    parameters.website_hint = websiteHint
    const sectionRow = await req.db
      .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
      .get(id, 'basic_information')
    const existingData = sectionRow?.data ? safeParseJSON(sectionRow.data, {}) : {}
    if (!normalizeHttpUrl(existingData.website)) {
      const merged = { ...existingData, website: websiteHint }
      await req.db.prepare(
        `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, section_key) DO UPDATE SET
           data = excluded.data,
           updated_by = excluded.updated_by,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(
        id,
        'basic_information',
        JSON.stringify(merged),
        req.ctx?.userId ?? req.ctx?.email ?? 'avatar-ai',
      )
    }
  }

  const jobId = crypto.randomUUID()
  const stmt = req.db.prepare(`
    INSERT INTO crawler_jobs (
      id,
      type,
      status,
      profile_id,
      organization_id,
      parameters,
      requested_by
    ) VALUES (?, 'avatar_lookup', 'queued', ?, ?, ?, ?)
  `)

  await stmt.run(
    jobId,
    profileRow.id,
    profileRow.organization_id ?? null,
    JSON.stringify(parameters),
    req.ctx?.isAdmin ? 'admin' : profileRow.id,
  )

  const job = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)

  Promise.resolve().then(() => dispatchCrawlerJob({
    db: req.db,
    jobId: job.id,
    uploadDir: getUploadsDir(req),
    getOpenAI,
  })).catch((err) => {
    console.warn('[profiles] avatar AI crawl dispatch failed:', err?.message || String(err))
  })

  res.status(202).json({
    id: job.id,
    status: job.status,
    type: job.type,
    created_at: job.created_at,
  })
})

function extensionFromImageContentType(contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('image/png')) return 'png'
  if (ct.includes('image/webp')) return 'webp'
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg'
  if (ct.includes('image/gif')) return 'gif'
  if (ct.includes('image/svg')) return 'svg'
  if (ct.includes('icon')) return 'ico'
  return 'png'
}

function guessImageContentType(filePath) {
  const lower = String(filePath || '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff'
  return 'application/octet-stream'
}

function extractUploadsFilename(rawUrl) {
  const raw = String(rawUrl || '').trim()
  if (!raw) return null
  let pathname = raw
  try {
    if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname
  } catch {
    pathname = raw
  }
  if (!pathname.includes('/uploads/')) return null
  const fileName = pathname.split('/uploads/').pop() || ''
  const baseName = fileName.split('/').pop()
  return baseName ? baseName.replace(/[^a-zA-Z0-9._-]/g, '') : null
}

// GET /api/profiles/:id/avatar/download
// Streams avatar file with clear diagnostics when missing.
router.get('/:id/avatar/download', async (req, res) => {
  const { id } = req.params
  const row = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!row) return res.status(404).json({ ok: false, error: 'Profile not found' })

  if (!canAccessProfileRowFromCtx(req.ctx, row)) return denyAuth(req, res)

  const avatarUrl = row.avatar_url ? String(row.avatar_url).trim() : ''
  const fileName = extractUploadsFilename(avatarUrl)

  const uploadsDir = getUploadsDir(req)
  const legacyDir = req?.legacyUploadsDir ? String(req.legacyUploadsDir) : null
  const tried = []
  const primary = fileName ? join(uploadsDir, fileName) : null

  // Fast path: serve the on-disk cache when it exists.
  if (fileName) {
    tried.push(primary)
    if (!fs.existsSync(primary) && legacyDir && legacyDir !== uploadsDir) {
      const legacy = join(legacyDir, fileName)
      tried.push(legacy)
      if (fs.existsSync(legacy)) {
        res.setHeader('Content-Type', guessImageContentType(legacy))
        return fs.createReadStream(legacy).pipe(res)
      }
    }
    if (fs.existsSync(primary)) {
      res.setHeader('Content-Type', guessImageContentType(primary))
      return fs.createReadStream(primary).pipe(res)
    }
  }

  // Durable fallback: serve the bytes stored in the DB. Works even when the
  // ephemeral file is gone or avatar_url was NULLed by an older self-heal.
  try {
    const blob = await req.db
      .prepare('SELECT avatar_data, avatar_content_type FROM profiles WHERE id = ?')
      .get(id)
    if (blob?.avatar_data) {
      const buf = Buffer.isBuffer(blob.avatar_data) ? blob.avatar_data : Buffer.from(blob.avatar_data)
      res.setHeader('Content-Type', blob.avatar_content_type || 'image/png')
      // Best-effort rehydrate of the on-disk cache for subsequent requests.
      if (primary) { try { fs.writeFile(primary, buf, () => {}) } catch { /* ignore */ } }
      return res.end(buf)
    }
  } catch {
    // avatar_data column may not exist yet (migration pending); fall through.
  }

  if (!fileName) {
    return res.status(404).json({
      ok: false,
      error: 'Avatar not set',
      code: 'AVATAR_NOT_SET',
      profile_id: String(id),
    })
  }

  console.warn('[profiles] avatar file missing', {
    requestId: req.requestId || null,
    profileId: String(id),
    avatar_url: avatarUrl || null,
    tried,
  })
  return res.status(404).json({
    ok: false,
    error: 'Avatar file not found',
    code: 'AVATAR_FILE_MISSING',
    profile_id: String(id),
  })
})

router.get('/:id/sections', async (req, res) => {
  const { id } = req.params

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const rawRows = await req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ?
      ORDER BY section_key
    `,
    )
    .all(id)
  const sections = coerceDbRows(rawRows).map((section) => ({
    section_key: section.section_key,
    data: normalizeProfileSectionData(section.section_key, safeParseJSON(section.data, {})),
    updated_at: section.updated_at,
    updated_by: section.updated_by,
  }))

  res.json(sections)
})

router.get('/:id/sections/:sectionKey', async (req, res) => {
  const { id, sectionKey } = req.params

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const section = await req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ? AND section_key = ?
    `,
    )
    .get(id, sectionKey)

  if (!section) {
    return res.status(404).json({ error: 'Section not found' })
  }

  res.json({
    section_key: section.section_key,
    data: normalizeProfileSectionData(section.section_key, safeParseJSON(section.data, {})),
    updated_at: section.updated_at,
    updated_by: section.updated_by,
  })
})

// ---------------------------------------------------------------------------
// Preferred language — the FIRST thing Anya asks during onboarding. Stored in
// the `language_preferences` profile section as { preferred_language: 'es' }.
// A dedicated tiny GET/PUT keeps the contract simple and avoids coupling the
// language choice to the section-payload guard. English is the default.
// ---------------------------------------------------------------------------
// Project readiness plan - Anya asks for missing facts; Hamilton saves the
// checklist/how-to packet. Parsed profile documents are evidence, not penalties.
router.get('/:id/project-readiness-plan', async (req, res, next) => {
  try {
    const { id } = req.params

    const profile = await loadProfileForProjectPlan(req, id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
      return denyAuth(req, res)
    }

    const plan = buildProjectReadinessPlan(profile)
    return res.json({ ok: true, plan })
  } catch (error) {
    return next(error)
  }
})

router.post('/:id/project-readiness-plan/prepare', async (req, res, next) => {
  try {
    const { id } = req.params

    const profile = await loadProfileForProjectPlan(req, id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
      return denyAuth(req, res)
    }

    const plan = buildProjectReadinessPlan(profile)
    const document = await saveProjectPlanDocument(req, id, plan)
    return res.json({ ok: true, outcome: 'project_plan_ready', plan, document })
  } catch (error) {
    return next(error)
  }
})

// Preferred language - the first thing Anya asks during onboarding.
router.get('/:id/preferred-language', async (req, res) => {
  const { id } = req.params

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }
  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const row = await req.db
    .prepare(
      `SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'language_preferences' LIMIT 1`,
    )
    .get(id)
  const stored = row ? safeParseJSON(row.data, {}) : {}
  res.json({ preferred_language: normalizeLanguageCode(stored?.preferred_language) })
})

router.put('/:id/preferred-language', async (req, res) => {
  const { id } = req.params
  const { preferred_language: requested, updated_by } = req.body ?? {}

  if (!isSupportedLanguage(requested)) {
    return res.status(400).json({
      error: 'unsupported_language',
      message: 'preferred_language must be one of the supported ISO codes.',
    })
  }

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }
  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const code = normalizeLanguageCode(requested)
  await req.db
    .prepare(
      `
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, 'language_preferences', ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `,
    )
    .run(id, JSON.stringify({ preferred_language: code }), updated_by ?? 'anya-onboarding')

  res.json({ preferred_language: code })
})

router.post('/:id/portal-awards/merge', async (req, res) => {
  const { id } = req.params
  const {
    application_id,
    portal_name,
    portal_url,
    award_name,
    award_amount,
    award_amount_raw,
    detected_at,
  } = req.body ?? {}

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const applicationId = String(application_id ?? '').trim()
  if (!applicationId) {
    return res.status(400).json({ error: 'application_id required' })
  }

  const existingSection = await req.db
    .prepare(
      `SELECT data FROM profile_sections
       WHERE profile_id = ? AND section_key = 'university_applications'
       LIMIT 1`,
    )
    .get(id)

  if (!existingSection?.data) {
    return res.status(404).json({ error: 'University applications section not found' })
  }

  const currentData = safeParseJSON(existingSection.data, {})
  const currentApplications = Array.isArray(currentData?.applications) ? currentData.applications : []

  let merged
  try {
    merged = mergePortalAwardIntoApplications(currentApplications, {
      applicationId,
      portalName: portal_name,
      portalUrl: portal_url,
      awardName: award_name,
      awardAmount: award_amount,
      awardAmountRaw: award_amount_raw,
      detectedAt: detected_at,
    })
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Unable to merge portal award' })
  }

  let guardedPayload
  try {
    guardedPayload = guardProfileSectionPayload(
      { applications: merged.applications },
      {
        profile,
        sections: { university_applications: currentData, },
        sectionKey: 'university_applications',
        existing: currentData,
      },
    )
  } catch (guardError) {
    profileLogger.warn('[profiles] portal award merge guard failed', {
      profile_id: id,
      error: guardError?.message || String(guardError),
    })
    return res.status(422).json({
      ok: false,
      error: 'profile_section_validation_failed',
      message: guardError?.message || 'Portal award merge could not be validated.',
      rejected: [],
    })
  }

  logProfileSectionRejections(id, 'university_applications', guardedPayload.rejected)
  // audit:allow unscoped-profile-query -- INSERT includes profile_id and the route validates access to id before writing.
  await req.db.prepare(
    `
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, 'university_applications', ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `,
  ).run(id, JSON.stringify(guardedPayload.data), 'portal_merge')

  return res.json({
    ok: true,
    application_id: applicationId,
    merged_award: merged.mergedAward,
  })
})

router.put('/:id/sections/:sectionKey', async (req, res) => {
  const { id, sectionKey } = req.params
  const { data, updated_by } = req.body ?? {}

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  if (typeof data !== 'object' || data === null) {
    return res.status(400).json({ error: 'data payload must be an object' })
  }

  const sectionRows = await req.db
    .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
    .all(id)
  const existingSections = Object.fromEntries(
    sectionRows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
  )
  let guardedPayload
  try {
    guardedPayload = guardProfileSectionPayload(data, {
      profile,
      sections: { ...existingSections, [sectionKey]: data },
      sectionKey,
    })
  } catch (guardError) {
    profileLogger.warn('[profiles] profile section guard failed', {
      profile_id: id,
      section_key: sectionKey,
      error: guardError?.message || String(guardError),
    })
    return res.status(422).json({
      ok: false,
      error: 'profile_section_validation_failed',
      message: guardError?.message || 'Profile section payload could not be validated.',
      rejected: [],
    })
  }
  let guardedData = guardedPayload.data
  logProfileSectionRejections(id, sectionKey, guardedPayload.rejected)

  // "Parse, baby, parse." When the basic_information section is saved with a
  // full_name but no first/last name, derive the parts so Hamilton's preflight
  // stops raising false "missing first/last name" blockers. Runs after the
  // guard so derived values are never stripped; never clobbers human input.
  if (sectionKey === 'basic_information') {
    guardedData = deriveNamePartsIntoBasicInfo(guardedData, profile?.display_name).data
  }

  // audit:allow unscoped-profile-query -- INSERT includes profile_id and the route validates access to id before writing.
  const upsert = req.db.prepare(
    `
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, section_key) DO UPDATE SET
      data = excluded.data,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `,
  )

  await upsert.run(id, sectionKey, JSON.stringify(guardedData), updated_by ?? null)

  // v4: Sync key section fields (state, zip, veteran, disability) to profiles table
  // so shallow reads in matching and Anya work correctly.
  try {
    syncProfileFieldsFromSection(req.db, id, sectionKey, guardedData)
  } catch (syncErr) {
    console.warn(`[profiles] Section sync failed for ${id}/${sectionKey}:`, syncErr?.message)
  }

  // Keep profile_emails in sync with the profile's own email (basic_information.email) and contacts.
  // Product requirement: the email on the profile implies access for that user.
  //
  // Safety:
  // - For non-admins, only auto-link when the email matches the caller's email (prevents accidental sharing).
  // - For admins, always link (admin actions are trusted and audited elsewhere).
  try {
    if (sectionKey === 'basic_information') {
      const isAdmin = req.ctx?.isAdmin === true
      const user = req.user ?? {}
      const primary = normalizeEmail(user?.primary_email)
      const secondary = normalizeEmail(user?.email)
      
      // Sync the main email field
      const email = normalizeEmail(guardedData?.email)
      if (email && isValidEmail(email)) {
        const canAutoLink = isAdmin || email === primary || email === secondary

        if (canAutoLink) {
          await addProfileEmails(req.db, {
            profileId: String(id),
            emails: [email],
            addedBy: req.ctx?.userId ?? req.ctx?.email ?? 'system-profile-email-sync',
          })
        }
      }
      
      // Sync contacts emails (admin-only for security)
      if (isAdmin && Array.isArray(guardedData?.contacts)) {
        const contactEmails = guardedData.contacts
          .map((contact) => normalizeEmail(contact?.email))
          .filter((contactEmail) => contactEmail && isValidEmail(contactEmail))
        
        if (contactEmails.length > 0) {
          await addProfileEmails(req.db, {
            profileId: String(id),
            emails: contactEmails,
            addedBy: req.ctx?.userId ?? req.ctx?.email ?? 'system-contacts-sync',
          })
        }
      }
    }
  } catch {
    // Best-effort only; profile section save must not fail if profile_emails schema isn't ready.
  }

  const section = await req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ? AND section_key = ?
    `,
    )
    .get(id, sectionKey)

  res.json({
    ok: true,
    section_key: section.section_key,
    data: safeParseJSON(section.data, {}),
    saved: safeParseJSON(section.data, {}),
    rejected: guardedPayload.rejected,
    updated_at: section.updated_at,
    updated_by: section.updated_by,
  })
})

router.delete('/:id/sections/:sectionKey', async (req, res) => {
  const { id, sectionKey } = req.params

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const stmt = req.db.prepare(`DELETE FROM profile_sections WHERE profile_id = ? AND section_key = ?`)
  const result = await stmt.run(id, sectionKey)
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Section not found' })
  }
  res.status(204).send()
})

router.get('/:id/school-portals', async (req, res) => {
  const { id } = req.params

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  try {
    const workspace = await getSchoolPortalWorkspace(req.db, id)
    return res.json({ ok: true, ...workspace })
  } catch (error) {
    profileLogger.error('[profiles/school-portals] failed to load workspace', {
      profile_id: id,
      error: error?.message || String(error),
    })
    return res.status(500).json(formatError(error))
  }
})

router.post('/:id/school-portals/connections', async (req, res) => {
  const { id } = req.params
  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const {
    provider_id,
    application_id,
    school_name,
    connection_label,
    portal_url,
    awards_payload,
    awards,
  } = req.body ?? {}

  let parsedAwards = awards
  if (!parsedAwards && typeof awards_payload === 'string') {
    parsedAwards = safeParseJSON(awards_payload, null)
    if (!parsedAwards) {
      return res.status(400).json({ error: 'awards_payload must be valid JSON.' })
    }
  }

  try {
    const result = await createSchoolPortalConnection(
      req.db,
      id,
      {
        provider_id,
        application_id,
        school_name,
        connection_label,
        portal_url,
        awards: parsedAwards,
      },
      req.ctx?.userId ?? req.ctx?.email ?? 'school-portal-import',
    )
    return res.status(201).json({ ok: true, connection: result.connection, ...result.workspace })
  } catch (error) {
    return res.status(400).json(formatError(error))
  }
})

router.post('/:id/school-portals/merge', async (req, res) => {
  const { id } = req.params
  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  try {
    const result = await mergeSchoolPortalAwards(
      req.db,
      id,
      req.body ?? {},
      req.ctx?.userId ?? req.ctx?.email ?? 'school-portal-merge',
    )
    return res.json({ ok: true, merged_count: result.merged_count, ...result.workspace })
  } catch (error) {
    return res.status(400).json(formatError(error))
  }
})

router.delete('/:id/school-portals/awards/:awardId', async (req, res) => {
  const { id, awardId } = req.params
  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  try {
    const result = await removeMergedSchoolPortalAward(
      req.db,
      id,
      { award_id: awardId },
      req.ctx?.userId ?? req.ctx?.email ?? 'school-portal-remove',
    )
    return res.json({ ok: true, ...result.workspace })
  } catch (error) {
    return res.status(400).json(formatError(error))
  }
})

router.delete('/:id/school-portals/connections/:connectionId', async (req, res) => {
  const { id, connectionId } = req.params
  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  try {
    const result = await disconnectSchoolPortalConnection(
      req.db,
      id,
      { connection_id: connectionId },
      req.ctx?.userId ?? req.ctx?.email ?? 'school-portal-disconnect',
    )
    return res.json({ ok: true, ...result.workspace })
  } catch (error) {
    return res.status(400).json(formatError(error))
  }
})

/**
 * Robustly extract a JSON object from an LLM completion: strips ```json fences,
 * scans for the first BRACE-BALANCED object (not a greedy regex), and repairs a
 * truncated object by closing open braces. Returns the parsed object or null.
 * This is what makes the section-AI endpoint resilient instead of 502-ing when a
 * model wraps JSON in prose or the output is cut off.
 */
function extractJsonObjectLoose(text) {
  if (!text || typeof text !== 'string') return null
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  let candidate = end !== -1 ? s.slice(start, end + 1) : s.slice(start)
  if (end === -1) {
    const opens = (candidate.match(/\{/g) || []).length
    const closes = (candidate.match(/\}/g) || []).length
    candidate += '}'.repeat(Math.max(0, opens - closes))
  }
  try { return JSON.parse(candidate) } catch { /* try safeParse */ }
  return safeParseJSON(candidate, null)
}

async function handleProfileSectionAi(req, res) {
  const { id, sectionKey } = req.params

  try {
    if (!supportedSectionKeys.includes(sectionKey)) {
      return res.status(400).json({ error: `Section "${sectionKey}" is not yet AI-enabled.` })
    }

    const profileRow = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (!canAccessProfileRowFromCtx(req.ctx, profileRow)) {
      return denyAuth(req, res)
    }

    if (!(await requireTierCapability(req, res, id, TIER_CAPABILITIES.DOCUMENT_AI))) return

    const sectionRows = await req.db
      .prepare(
        `
        SELECT section_key, data
        FROM profile_sections
        WHERE profile_id = ?
      `,
      )
      .all(id)

    const sections = Object.fromEntries(
      sectionRows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
    )

    // PostgresTx returns a Promise from `.all(...)` — must be awaited or the prompt
    // builder receives a Promise and `documents.slice(...)` throws "slice is not a
    // function", surfacing as a 500 on every section's Ask AI button. This was the
    // exact failure mode reported on /ProfileDetail. We also defensively coerce to
    // an array so a future shape mismatch never blocks the AI provider call.
    let docs = []
    try {
      const rawDocs = await req.db
        .prepare(
          `
          SELECT d.id, d.name, d.type, d.status, d.notes
          FROM documents d
          JOIN profile_documents pd ON pd.document_id = d.id
          WHERE pd.profile_id = ?
          ORDER BY d.created_at DESC
        `,
        )
        .all(id)
      docs = Array.isArray(rawDocs) ? rawDocs : (rawDocs?.rows ?? [])
    } catch (docsError) {
      // Documents are optional context for the AI prompt — never block the request.
      console.warn('[profiles/sections/ai] document load failed; continuing without docs:', docsError?.message || docsError)
      docs = []
    }

    const promptPayload = buildProfileSectionPrompt(sectionKey, {
      profile: mapProfile(profileRow),
      sections,
      documents: docs,
    })

    if (!promptPayload) {
      return res.status(400).json({ error: `No prompt mapping for section "${sectionKey}"` })
    }

    const openai = getOpenAIOptional()
    let sectionAiTimedOut = false
    // Shared gateway-safe deadline across both providers (see /fields/ai).
    const sectionAiDeadlineAt = Date.now() + LLM_TIMEOUT_MS
    const sectionAiRemainingMs = () => sectionAiDeadlineAt - Date.now()

    // Provider order: OpenAI -> Anthropic -> deterministic empty fallback (never hard-fail the UI).
    if (openai && sectionAiRemainingMs() > 500) {
      try {
        const completion = await withLLMTimeout(
          openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [{ role: 'user', content: promptPayload.prompt }],
            temperature: 0.2,
            max_tokens: 4000,
          }),
          { timeoutMs: sectionAiRemainingMs(), label: 'Section AI (OpenAI)' },
        )

        const raw = extractCompletionText(completion)
        const suggestion = extractJsonObjectLoose(raw)

        if (!suggestion || typeof suggestion !== 'object') {
          // Don't 502 — fall through to Anthropic, then to the graceful
          // empty-suggestion response so the UI never breaks.
          console.warn('[profiles/sections/ai] OpenAI output unparseable; trying Anthropic')
        } else {
        const guardedSuggestion = guardProfileSectionPayload(suggestion, {
          profile: profileRow,
          sections,
          sectionKey,
        })
        logProfileSectionRejections(id, sectionKey, guardedSuggestion.rejected)

        return res.json({
          section_key: sectionKey,
          suggestion: guardedSuggestion.data,
          rejected: guardedSuggestion.rejected,
          usage: completion.usage ?? null,
          raw_response: raw,
          ai_provider: 'openai',
        })
        }
      } catch (openaiError) {
        if (isLLMTimeout(openaiError)) sectionAiTimedOut = true
        const summary = summarizeOpenAIError(openaiError)
        console.warn('[profiles/sections/ai] OpenAI failed, will try Anthropic:', summary?.message || openaiError?.message || openaiError)
      }
    }

    const anthropic = sectionAiRemainingMs() > 500 ? await createAnthropicClient() : null
    if (anthropic) {
      try {
        const response = await withLLMTimeout(
          anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
            max_tokens: 4000,
            temperature: 0.2,
            messages: [{ role: 'user', content: promptPayload.prompt }],
          }),
          { timeoutMs: sectionAiRemainingMs(), label: 'Section AI (Anthropic)' },
        )

        const raw = extractAnthropicText(response)
        const suggestion = extractJsonObjectLoose(raw)

        if (suggestion && typeof suggestion === 'object') {
          const guardedSuggestion = guardProfileSectionPayload(suggestion, {
            profile: profileRow,
            sections,
            sectionKey,
          })
          logProfileSectionRejections(id, sectionKey, guardedSuggestion.rejected)

          return res.json({
            section_key: sectionKey,
            suggestion: guardedSuggestion.data,
            rejected: guardedSuggestion.rejected,
            usage: null,
            raw_response: raw,
            ai_provider: 'anthropic',
          })
        }
        console.warn('[profiles/sections/ai] Anthropic output unparseable; returning graceful fallback')
      } catch (anthropicError) {
        if (isLLMTimeout(anthropicError)) sectionAiTimedOut = true
        console.warn('[profiles/sections/ai] Anthropic failed:', anthropicError?.message || anthropicError)
      }
    }

    if (sectionAiTimedOut) {
      return res.status(503).json({
        error: 'ai_timeout',
        section_key: sectionKey,
        message: 'AI is taking longer than usual. Please try again in a moment.',
      })
    }

    return res.json({
      section_key: sectionKey,
      suggestion: {},
      rejected: [],
      usage: null,
      raw_response: '',
      ai_provider: 'fallback',
      warning: 'No AI provider configured (OPENAI_API_KEY/ANTHROPIC_API_KEY missing) or provider error.',
      message: 'AI suggestion is unavailable right now, but the section can still be edited and saved manually.',
    })
  } catch (error) {
    console.error('Error generating profile section suggestion:', error)
    res.status(500).json(formatError(error))
  }
}

// Back-compat for older clients:
// GET /api/profiles/:id/:sectionKey/ai (legacy) -> same as the canonical POST route.
router.get('/:id/:sectionKey/ai', handleProfileSectionAi)
router.post('/:id/sections/:sectionKey/ai', handleProfileSectionAi)

// Generate AI suggestion for individual profile field
router.post('/:id/fields/ai', async (req, res) => {
  const { id } = req.params
  const { fieldName, fieldLabel, currentValue, fieldDescription, sectionKey } = req.body

  try {
    // Get profile for context
    const profileRow = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (!canAccessProfileRowFromCtx(req.ctx, profileRow)) {
      return denyAuth(req, res)
    }

    if (!(await requireTierCapability(req, res, id, TIER_CAPABILITIES.DOCUMENT_AI))) return
    const profile = mapProfile(profileRow)

    // Pull real stored context from profile_sections so suggestions are actually grounded in this profile.
    const sectionRows = await req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(id)

    const sectionMap = new Map(
      sectionRows.map((row) => [String(row.section_key), safeParseJSON(row.data, {})]),
    )

    const preferredSectionOrder = [
      sectionKey,
      'basic_information',
      'organization_overview',
      'mission_statement',
      'programs',
      'services',
      'operations',
      'financials',
      'outcomes',
      'community_impact',
    ].filter(Boolean)

    const seen = new Set()
    const selectedSections = {}
    for (const key of preferredSectionOrder) {
      if (seen.has(key)) continue
      seen.add(key)
      const data = sectionMap.get(key)
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        selectedSections[key] = data
      }
    }

    const profileContextJson = JSON.stringify(
      {
        profile: {
          id: profile.id,
          name: profile.display_name,
          type: profile.primary_type,
          organization: profile.organization_name ?? null,
        },
        sections: selectedSections,
      },
      null,
      2,
    )
    const profileContext =
      profileContextJson.length > 2500 ? `${profileContextJson.slice(0, 2499)}…` : profileContextJson

    // Create focused prompt for the specific field
    const prompt = `You are assisting with filling out a grant application field.

Field Name: ${fieldLabel}
${fieldDescription ? `Field Description: ${fieldDescription}` : ''}
Current Value: ${currentValue || '(empty)'}
Section: ${sectionKey || 'general'}

PROFILE CONTEXT (from the saved profile; use this and do not invent facts):
${profileContext}

Please provide appropriate content for the "${fieldLabel}" field.
Requirements:
- Be specific and professional
- Use language suitable for grant applications
- For text fields: Provide 2-3 clear, concise sentences
- For numbers: Provide only the numeric value
- For descriptions: Be detailed but concise

Return ONLY the field value content, no JSON wrapper or explanations.`

    const openai = getOpenAIOptional()
    let suggestion
    let aiTimedOut = false
    // Shared gateway-safe deadline across BOTH providers so the sequential
    // OpenAI->Anthropic fallback can't sum past the proxy's ~30s cut (the cause
    // of the "Assist with AI" hang/504). On timeout we return a clean 503.
    const aiDeadlineAt = Date.now() + LLM_TIMEOUT_MS
    const aiRemainingMs = () => aiDeadlineAt - Date.now()

    if (openai && aiRemainingMs() > 500) {
      try {
        const completion = await withLLMTimeout(
          openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 400,
          }),
          { timeoutMs: aiRemainingMs(), label: 'Field AI (OpenAI)' },
        )
        suggestion = extractCompletionText(completion).trim()
        return res.json({
          field: fieldName,
          suggestion,
          usage: null,
          ai_provider: 'openai',
        })
      } catch (error) {
        if (isLLMTimeout(error)) aiTimedOut = true
        const summary = summarizeOpenAIError(error)
        console.warn('[Field AI] OpenAI request failed:', summary?.message || error?.message || error)
        // fall through to Anthropic / fallback (do not hard-fail the UI)
      }
    }

    const anthropic = aiRemainingMs() > 500 ? await createAnthropicClient() : null
    if (anthropic) {
      try {
        const response = await withLLMTimeout(
          anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
            max_tokens: 400,
            temperature: 0.3,
            messages: [{ role: 'user', content: prompt }],
          }),
          { timeoutMs: aiRemainingMs(), label: 'Field AI (Anthropic)' },
        )
        suggestion = extractAnthropicText(response).trim()
        return res.json({
          field: fieldName,
          suggestion,
          usage: null,
          ai_provider: 'anthropic',
        })
      } catch (anthropicError) {
        if (isLLMTimeout(anthropicError)) aiTimedOut = true
        console.warn('[Field AI] Anthropic request failed:', anthropicError?.message || anthropicError)
      }
    }

    if (aiTimedOut) {
      // Clean, fast 503 so the client shows "try again" instead of a 504.
      return res.status(503).json({
        error: 'ai_timeout',
        message: 'AI is taking longer than usual. Please try again in a moment.',
        field: fieldName,
        suggestion: typeof currentValue === 'string' ? currentValue : '',
      })
    }

    res.json({
      field: fieldName,
      suggestion: typeof currentValue === 'string' ? currentValue : '',
      usage: null,
      ai_provider: 'fallback',
      warning: 'No AI provider configured (OPENAI_API_KEY/ANTHROPIC_API_KEY missing) or provider error.',
    })
  } catch (error) {
    console.error('Field AI suggestion error:', error)
    res.status(500).json({ error: error.message || 'Failed to generate AI suggestion for field' })
  }
})

// Profile completeness check
// GET /api/profiles/:id/completeness
router.get('/:id/completeness', async (req, res) => {
  const { id } = req.params

  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)

  try {
    const profile = await req.db.prepare('SELECT id, display_name, primary_type FROM profiles WHERE id = ?').get(id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Get existing sections for this profile
    const existingSectionRows = await req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(id)
    const existingSectionMap = new Map(
      existingSectionRows.map(s => [s.section_key, safeParseJSON(s.data, {})])
    )

    // Check against canonical sections + canonical keys (data points)
    const missingSections = []
    const emptySections = []
    const completedSections = []
    const missingKeysBySection = {}
    const presentKeysBySection = {}
    let totalKeyCount = 0
    let filledKeyCount = 0

    supportedSectionKeys.forEach(sectionKey => {
      const sectionData = existingSectionMap.get(sectionKey)
      const schema = PROFILE_SCHEMA?.[sectionKey]
      const canonicalKeys = Object.keys(schema?.fields ?? {})
      
      if (!sectionData) {
        missingSections.push(sectionKey)
        missingKeysBySection[sectionKey] = canonicalKeys
        presentKeysBySection[sectionKey] = []
      } else {
        // Canonical keys: enforce presence even if missing in saved JSON.
        // For completion scoring, we only score canonical keys (not arbitrary extras).
        const keys = canonicalKeys.filter((k) => k !== 'notes')
        const presentKeys = keys.filter((k) => Object.prototype.hasOwnProperty.call(sectionData, k))
        const missingKeys = keys.filter((k) => !Object.prototype.hasOwnProperty.call(sectionData, k))

        presentKeysBySection[sectionKey] = presentKeys
        missingKeysBySection[sectionKey] = missingKeys

        const filledKeys = keys.filter((k) => {
          const value = sectionData[k]
          if (value === null || value === undefined || value === '') return false
          if (Array.isArray(value) && value.length === 0) return false
          if (typeof value === 'object' && value && Object.keys(value).length === 0) return false
          return true
        })

        totalKeyCount += keys.length
        filledKeyCount += filledKeys.length

        if (filledKeys.length === 0) {
          emptySections.push(sectionKey)
        } else {
          completedSections.push({
            section_key: sectionKey,
            filled_keys: filledKeys.length,
            total_keys: keys.length,
            missing_keys: missingKeys.length,
          })
        }
      }
    })

    const percentComplete = totalKeyCount > 0 
      ? Math.round((filledKeyCount / totalKeyCount) * 100) 
      : 0

    res.json({
      profile_id: id,
      display_name: profile.display_name,
      total_canonical_sections: supportedSectionKeys.length,
      missing_sections: missingSections,
      empty_sections: emptySections,
      completed_sections: completedSections,
      missing_keys_by_section: missingKeysBySection,
      present_keys_by_section: presentKeysBySection,
      percent_complete: percentComplete,
      summary: {
        missing: missingSections.length,
        empty: emptySections.length,
        with_data: completedSections.length,
        filled_keys: filledKeyCount,
        total_keys: totalKeyCount,
        missing_keys: Object.values(missingKeysBySection).reduce((acc, arr) => acc + (arr?.length ?? 0), 0),
      }
    })
  } catch (error) {
    console.error('Error checking profile completeness:', error)
    res.status(500).json(formatError(error))
  }
})

// GET /:id/gap-plan — the backend for Anya's opening interview + the login gap
// gate + the gap-explanation email. Returns whether the profile is complete
// enough to match well, the ordered (mostly yes/no) questions Anya should ask to
// fill the gaps, and — when incomplete — a ready-to-send gap-explanation email.
// The dichotomous questions write the exact fields the matcher reads to derive
// the profile's type, so the user never picks a type; their answers determine it.
router.get('/:id/gap-plan', async (req, res) => {
  const { id } = req.params
  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)
  try {
    // profiles has NO state/city/zip columns — location lives in the
    // basic_information section. Selecting them here made EVERY gap-plan call
    // 500 with "no such column: state" (the endpoint-sweep gate caught it).
    const profile = await req.db.prepare('SELECT id, display_name, primary_type FROM profiles WHERE id = ?').get(id)
    if (!profile) return res.status(404).json({ error: 'Profile not found' })

    const sectionRows = await req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(id)
    const sections = {}
    for (const s of sectionRows) sections[s.section_key] = safeParseJSON(s.data, {})

    const basic = sections.basic_information || {}
    const normalized = normalizeProfile({
      ...profile,
      state: basic.state ?? null,
      city: basic.city ?? null,
      zip: basic.zip ?? basic.zip_code ?? null,
    }, sections)
    const firstName = String(profile.display_name || '').trim().split(/\s+/)[0] || 'there'
    const plan = buildProfileGapPlan(normalized, sections, {
      displayName: firstName,
      minCoverage: Number.isFinite(Number(req.query.min_coverage)) ? Number(req.query.min_coverage) : 0.5,
    })
    return res.json({ ok: true, profile_id: id, ...plan })
  } catch (error) {
    return res.status(500).json(formatError(error))
  }
})

// Profile repair - create missing sections with empty JSON
// POST /api/profiles/:id/repair
router.post('/:id/repair', async (req, res) => {
  const { id } = req.params

  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)

  try {
    const profile = await req.db.prepare('SELECT id, display_name FROM profiles WHERE id = ?').get(id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Get existing sections
    const existingSections = await req.db
      .prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?')
      .all(id)
    
    const existingKeys = new Set(existingSections.map(s => s.section_key))

    // Create missing sections (as empty JSON)
    // audit:allow unscoped-profile-query -- INSERT includes profile_id and the route validates access to id before repairing.
    const upsert = req.db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, '{}', 'system-repair')
      ON CONFLICT(profile_id, section_key) DO NOTHING
    `)

    const createdSections = []
    for (const sectionKey of supportedSectionKeys) {
      if (!existingKeys.has(sectionKey)) {
        await upsert.run(id, sectionKey)
        createdSections.push(sectionKey)
      }
    }

    // Ensure every canonical key exists in every section (data-point completeness).
    // This is safe because profile_sections.data is JSON and adding keys is backward compatible.
    const existingSectionRows = await req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(id)
    const repairSections = Object.fromEntries(
      existingSectionRows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
    )

    const updateStmt = req.db.prepare(`
      UPDATE profile_sections
      SET data = ?, updated_by = 'system-repair', updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ? AND section_key = ?
    `)

    const repairedKeysBySection = {}
    for (const row of existingSectionRows) {
      const sectionKey = row.section_key
      if (!supportedSectionKeys.includes(sectionKey)) continue

      const current = safeParseJSON(row.data, {})
      const defaults = getDefaultSectionData(sectionKey)
      const repairedKeys = []

      for (const [key, defaultValue] of Object.entries(defaults)) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
          current[key] = defaultValue
          repairedKeys.push(key)
        }
      }

      if (repairedKeys.length > 0) {
        repairedKeysBySection[sectionKey] = repairedKeys
        const guarded = guardProfileSectionPayload(current, {
          profile,
          sections: { ...repairSections, [sectionKey]: current },
          sectionKey,
          existing: repairSections[sectionKey] ?? {},
        })
        logProfileSectionRejections(id, sectionKey, guarded.rejected)
        await updateStmt.run(JSON.stringify(guarded.data), id, sectionKey)
      }
    }

    res.json({
      success: true,
      profile_id: id,
      display_name: profile.display_name,
      sections_created: createdSections,
      keys_repaired_by_section: repairedKeysBySection,
      total_sections_after: supportedSectionKeys.length,
      message: createdSections.length > 0 
        ? `Created ${createdSections.length} missing section(s)` 
        : 'Profile already has all sections'
    })
  } catch (error) {
    console.error('Error repairing profile:', error)
    res.status(500).json(formatError(error))
  }
})

// Export profile as JSON
// GET /api/profiles/:id/export
router.get('/:id/export', async (req, res) => {
  const { id } = req.params

  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)

  try {
    const profileRow = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const profile = mapProfile(profileRow)

    // Get all sections
    const sections = (await req.db
      .prepare('SELECT section_key, data, updated_at FROM profile_sections WHERE profile_id = ?')
      .all(id))
      .reduce((acc, row) => {
        acc[row.section_key] = {
          data: safeParseJSON(row.data, {}),
          updated_at: row.updated_at
        }
        return acc
      }, {})

    const exportData = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      profile: {
        id: profile.id,
        display_name: profile.display_name,
        primary_type: profile.primary_type,
        status: profile.status,
        tags: profile.tags,
        avatar_url: profile.avatar_url,
        created_at: profile.created_at,
        updated_at: profile.updated_at
      },
      sections
    }

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="profile-${id}-export.json"`)
    res.json(exportData)
  } catch (error) {
    console.error('Error exporting profile:', error)
    res.status(500).json(formatError(error))
  }
})

// Import profile from JSON
// POST /api/profiles/:id/import
router.post('/:id/import', async (req, res) => {
  const { id } = req.params

  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)

  try {
    const { sections, merge = true } = req.body ?? {}

    if (!sections || typeof sections !== 'object') {
      return res.status(400).json({ error: 'sections object required in request body' })
    }

    const profile = await req.db.prepare('SELECT id, display_name, primary_type FROM profiles WHERE id = ?').get(id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const importedSections = []

    const rejected = []
    await req.db.withTransaction(async (tx) => {
      const upsert = tx.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, ?, ?, 'import')
        ON CONFLICT(profile_id, section_key) DO UPDATE SET
          data = excluded.data,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
      `)

      for (const [sectionKey, sectionValue] of Object.entries(sections)) {
        if (!supportedSectionKeys.includes(sectionKey)) {
          console.warn(`Skipping unknown section key: ${sectionKey}`)
          continue
        }

        const data = sectionValue?.data ?? sectionValue
        if (typeof data !== 'object' || data === null) {
          console.warn(`Skipping invalid section data for: ${sectionKey}`)
          continue
        }

        if (merge) {
          // Merge with existing data
          const existing = await tx
            .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
            .get(id, sectionKey)
          
          const existingData = existing ? safeParseJSON(existing.data, {}) : {}
          const mergedData = { ...existingData, ...data }
          const guarded = guardProfileSectionPayload(mergedData, {
            profile,
            sections: { [sectionKey]: mergedData },
            sectionKey,
            existing: existingData,
          })
          rejected.push(...guarded.rejected.map((item) => ({ section_key: sectionKey, ...item })))
          logProfileSectionRejections(id, sectionKey, guarded.rejected)
          await upsert.run(id, sectionKey, JSON.stringify(guarded.data))
        } else {
          // Replace existing data
          const guarded = guardProfileSectionPayload(data, {
            profile,
            sections: { [sectionKey]: data },
            sectionKey,
          })
          rejected.push(...guarded.rejected.map((item) => ({ section_key: sectionKey, ...item })))
          logProfileSectionRejections(id, sectionKey, guarded.rejected)
          await upsert.run(id, sectionKey, JSON.stringify(guarded.data))
        }

        importedSections.push(sectionKey)
      }
    })

    res.json({
      success: true,
      profile_id: id,
      display_name: profile.display_name,
      sections_imported: importedSections,
      rejected,
      merge_mode: merge,
      message: `Imported ${importedSections.length} section(s)`
    })
  } catch (error) {
    console.error('Error importing profile:', error)
    res.status(500).json(formatError(error))
  }
})

// Send application email (for draft applications or completed profiles).
// Auth-gated: previously this route accepted any unauthenticated caller and
// would send an email to a body-supplied address with body-supplied content,
// turning the API into a free email-relay surface (Goal #9 reliability and
// general security violation). Now requires an authenticated user.
router.post('/send-application-email', async (req, res, next) => {
  if (!req.user?.userId && !req.ctx?.userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  return next()
}, async (req, res) => {
  try {
    // Use environment variable with fallback, or require toEmail in request
    const defaultEmail = process.env.APPLICATION_EMAIL || null
    const { toEmail = defaultEmail, applicationData } = req.body

    if (!toEmail) {
      return res.status(400).json({ 
        error: 'Recipient email required',
        message: 'Please provide a toEmail in the request body or set APPLICATION_EMAIL environment variable'
      })
    }

    // Import email service
    const { sendApplicationEmail } = await import('../services/email.js')

    // Send the email
    const sent = await sendApplicationEmail(toEmail, applicationData)

    if (!sent) {
      return res.status(500).json({ 
        error: 'Email service not configured or failed to send',
        message: 'Please check email service configuration'
      })
    }

    res.json({ 
      success: true,
      message: `Application sent to ${toEmail}` 
    })
  } catch (error) {
    console.error('Error sending application email:', error)
    res.status(500).json(formatError(error))
  }
})

export default router
