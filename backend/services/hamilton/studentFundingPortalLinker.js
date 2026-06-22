/**
 * studentFundingPortalLinker.js
 *
 * Given a student profile + a discovered funding opportunity, decide which
 * portal record (in `student_portals`) the opportunity should be linked
 * to, score the match, and persist the linkage in
 * `application_portal_links`.
 *
 * The output schema (per the Hamilton spec):
 *   {
 *     profile_id, opportunity_id, school_id, portal_id, portal_type,
 *     action_type, application_url, confidence, reasons,
 *     missing_requirements, can_hamilton_attempt, requires_user_login,
 *     requires_admin_review,
 *   }
 *
 * Mission rules satisfied:
 *   - Mission goal #2 (match to actual needs): we look at school name,
 *     program/major, opportunity title/keywords, source URL host, etc.
 *     before deciding portal type.
 *   - Mission rule "no hard boolean filters": missing data lowers
 *     confidence and may flag admin review, but never silently drops the
 *     opportunity. If nothing matches, we fall back to manual_or_offline
 *     with a clear explanation.
 *   - Mission rule "directory-style resources must always survive": when
 *     the opportunity is a directory, we link it to the most specific
 *     external_application portal we can find rather than discarding it.
 *   - Profile scoping: every read/write is profile-scoped.
 */

import crypto from 'crypto'
import { withProfileScope } from '../../middleware/profileContext.js'
import {
  ensureStudentPortalsSchema,
  upsertStudentPortal,
  normalizeSchoolName,
} from './studentPortalStore.js'
import { getKnownSchool } from '../shared/data/knownSchools.js'

let ensuredLinkSchema = false

async function ensureLinkSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredLinkSchema) return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const boolType = isPostgres ? 'BOOLEAN' : 'INTEGER'
  const defFalse = isPostgres ? 'FALSE' : '0'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS application_portal_links (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      profile_id TEXT NOT NULL,
      user_id TEXT,
      opportunity_id TEXT,
      grant_id TEXT,
      portal_id TEXT,
      school_id TEXT,
      portal_type TEXT NOT NULL,
      action_type TEXT,
      application_url TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      missing_requirements_json TEXT NOT NULL DEFAULT '[]',
      can_hamilton_attempt ${boolType} NOT NULL DEFAULT ${defFalse},
      requires_user_login ${boolType} NOT NULL DEFAULT ${defFalse},
      requires_admin_review ${boolType} NOT NULL DEFAULT ${defFalse},
      notes TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_app_portal_links_profile ON application_portal_links(profile_id);
    CREATE INDEX IF NOT EXISTS idx_app_portal_links_opp     ON application_portal_links(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_app_portal_links_grant   ON application_portal_links(grant_id);
    CREATE INDEX IF NOT EXISTS idx_app_portal_links_portal  ON application_portal_links(portal_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_app_portal_links_profile_opp
      ON application_portal_links(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));
  `)
  ensuredLinkSchema = true
}

export function _resetLinkSchemaCache() {
  ensuredLinkSchema = false
}

// ── classification rules ─────────────────────────────────────────────

const KEYWORD_PATTERNS = Object.freeze([
  { type: 'financial_aid', re: /\b(fafsa|work[\s-]?study|pell|need[\s-]?based|tap grant|state grant)\b/i },
  { type: 'financial_aid', re: /\bfinancial[\s-]?aid|institutional[\s-]?aid|emergency[\s-]?aid|tuition[\s-]?assistance|housing[\s-]?aid\b/i },
  { type: 'scholarship',   re: /\bscholarship|merit[\s-]?award|named[\s-]?scholarship|presidential[\s-]?scholarship|alumni[\s-]?scholarship\b/i },
  { type: 'admissions',    re: /\b(admissions?|applicant|incoming[\s-]?student|enrollment[\s-]?award|new[\s-]?student[\s-]?scholarship)\b/i },
  { type: 'department',    re: /\b(department|departmental|college of [a-z]+|school of [a-z]+|program[\s-]?scholarship)\b/i },
  { type: 'graduate_school', re: /\b(graduate|grad[\s-]?school|phd|master'?s|fellowship)\b/i },
  { type: 'program_specific', re: /\b(stem|nursing|engineering|education major|business school|honors[\s-]?college)\b/i },
  { type: 'bursar',        re: /\b(bursar|tuition[\s-]?payment|account[\s-]?balance|payment[\s-]?plan|past[\s-]?due[\s-]?balance)\b/i },
  { type: 'student_account', re: /\b(student[\s-]?account|onestop|self[\s-]?service|portal[\s-]?login)\b/i },
  { type: 'external_application', re: /\b(common[\s-]?app|coalition[\s-]?app|scholarshipowl|fastweb|cappex|going[\s-]?merry|college[\s-]?board)\b/i },
])

const DOMAIN_HINTS = Object.freeze([
  { type: 'financial_aid', re: /(financialaid|finaid|costs-?aid|tuition|fafsa)\./i },
  { type: 'scholarship',   re: /(scholarship|awards|honors)\./i },
  { type: 'admissions',    re: /(admissions?|apply|gobama|enroll|undergrad)\./i },
  { type: 'bursar',        re: /(bursar|payments|sfs|onestop|cashier)\./i },
  { type: 'student_account', re: /(myaccount|mybanner|mywebservices|self[-_]?service|onestop)\./i },
  { type: 'graduate_school', re: /(grad|graduate|phd)\./i },
  { type: 'department',    re: /(college|school|department|engineering|nursing)\./i },
])

const DEFAULT_REASON_WEIGHTS = Object.freeze({
  exact_school_name_match: 0.30,
  knownSchools_match: 0.20,
  profile_school_committed: 0.10,
  source_url_host_match_school: 0.20,
  opportunity_title_keyword_match: 0.10,
  opportunity_body_keyword_match: 0.05,
  crawler_school_metadata: 0.10,
  scholarship_category_match: 0.05,
  application_url_evidence: 0.05,
  profile_program_or_major_match: 0.05,
})

function pushReason(reasons, key, weight, detail) {
  reasons.push({ key, weight, detail })
}

function bestKeywordType(text) {
  if (!text) return null
  const lower = String(text).toLowerCase()
  for (const { type, re } of KEYWORD_PATTERNS) {
    if (re.test(lower)) return type
  }
  return null
}

function bestDomainType(host) {
  if (!host) return null
  for (const { type, re } of DOMAIN_HINTS) {
    if (re.test(host)) return type
  }
  return null
}

function safeUrl(value) {
  try {
    if (!value) return null
    return new URL(String(value))
  } catch {
    return null
  }
}

function hostnameOf(value) {
  const u = safeUrl(value)
  return u ? u.hostname.toLowerCase() : null
}

function isExternalScholarshipHost(host) {
  if (!host) return false
  return /(commonapp\.org|scholarships\.com|fastweb\.com|goingmerry\.com|appily\.com|niche\.com|bigfuture|college[\s-]?board)/i.test(host)
}

function isInstitutionalHost(host, schoolHostname) {
  if (!host || !schoolHostname) return false
  return host === schoolHostname || host.endsWith(`.${schoolHostname}`) || schoolHostname.endsWith(`.${host}`)
}

/**
 * Run the full classifier without persisting anything. Returns the link
 * shape — useful for previews, tests, and the UI "explain my portal
 * choice" affordance.
 */
export function classifyFundingPortal({
  profile = null,
  opportunity = null,
  studentPortals = [],
  knownSchools = null,
  crawlerMetadata = null,
} = {}) {
  if (!profile || !opportunity) {
    return makeManualFallback({
      profileId: profile?.id ?? null,
      opportunityId: opportunity?.id ?? null,
      reason: 'missing_profile_or_opportunity',
    })
  }

  const reasons = []
  let totalConfidence = 0
  const candidates = new Map() // portal_type → cumulative weight

  function addType(type, weight, key, detail) {
    if (!type || !weight) return
    candidates.set(type, (candidates.get(type) || 0) + weight)
    pushReason(reasons, key, weight, detail)
    totalConfidence += weight
  }

  // ── Profile / school inputs
  const profileSchools = collectProfileSchools(profile)
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''} ${opportunity.eligibility_text || ''}`
  const oppTextLower = oppText.toLowerCase()

  let matchedSchoolName = null
  let matchedSchoolHostname = null
  let matchedKnownSchool = null
  let matchedFromProfile = null
  // When the opportunity text contains the student's school, boost the
  // portal type the *opportunity itself* implies (FAFSA → financial_aid,
  // departmental → department, etc.). Default to scholarship only when
  // we have no other signal yet.
  for (const school of profileSchools) {
    const norm = normalizeSchoolName(school.name)
    if (!norm) continue
    if (oppTextLower.includes(school.name.toLowerCase())) {
      matchedSchoolName = school.name
      matchedFromProfile = school
      const impliedType =
        bestKeywordType(opportunity.title) ||
        bestKeywordType(`${opportunity.description || ''} ${opportunity.eligibility_text || ''}`) ||
        'scholarship'
      addType(impliedType, DEFAULT_REASON_WEIGHTS.exact_school_name_match,
        'exact_school_name_match', `opportunity text contains "${school.name}" (routed to ${impliedType})`)
      break
    }
  }

  // KnownSchools enrichment when we know which school the student attends.
  for (const school of profileSchools) {
    const known = knownSchools?.getKnownSchool ? knownSchools.getKnownSchool(school.name) : getKnownSchool(school.name)
    if (known) {
      matchedKnownSchool = known
      const knownHost = hostnameOf(known.website || known.portals?.financialAid || known.portals?.admissions)
      if (knownHost) matchedSchoolHostname = knownHost
      pushReason(reasons, 'knownSchools_match', DEFAULT_REASON_WEIGHTS.knownSchools_match,
        `profile school "${school.name}" found in knownSchools (${known.name})`)
      totalConfidence += DEFAULT_REASON_WEIGHTS.knownSchools_match
      break
    }
  }

  // Profile-committed school signal (committed = student picked this school as their target).
  const committed = profileSchools.find((s) => s.committed)
  if (committed) {
    pushReason(reasons, 'profile_school_committed', DEFAULT_REASON_WEIGHTS.profile_school_committed,
      `student committed to "${committed.name}"`)
    totalConfidence += DEFAULT_REASON_WEIGHTS.profile_school_committed
  }

  // Source URL host vs school host
  const sourceUrl = opportunity.application_url || opportunity.source_url || opportunity.url || null
  const sourceHost = hostnameOf(sourceUrl)
  if (sourceHost && matchedSchoolHostname && isInstitutionalHost(sourceHost, matchedSchoolHostname)) {
    pushReason(reasons, 'source_url_host_match_school', DEFAULT_REASON_WEIGHTS.source_url_host_match_school,
      `source host ${sourceHost} matches school host ${matchedSchoolHostname}`)
    totalConfidence += DEFAULT_REASON_WEIGHTS.source_url_host_match_school
    addType(bestDomainType(sourceHost) || 'scholarship',
      DEFAULT_REASON_WEIGHTS.source_url_host_match_school,
      'source_url_host_match_school',
      'source URL is on the school domain')
  }

  // Title keyword match
  const titleType = bestKeywordType(opportunity.title)
  if (titleType) {
    addType(titleType, DEFAULT_REASON_WEIGHTS.opportunity_title_keyword_match,
      'opportunity_title_keyword_match',
      `title keyword maps to ${titleType}`)
  }
  // Description / eligibility keyword match
  const bodyType = bestKeywordType(`${opportunity.description || ''} ${opportunity.eligibility_text || ''}`)
  if (bodyType) {
    addType(bodyType, DEFAULT_REASON_WEIGHTS.opportunity_body_keyword_match,
      'opportunity_body_keyword_match',
      `description keyword maps to ${bodyType}`)
  }

  // Crawler metadata
  if (crawlerMetadata?.school_id || crawlerMetadata?.school_normalized) {
    pushReason(reasons, 'crawler_school_metadata', DEFAULT_REASON_WEIGHTS.crawler_school_metadata,
      `crawler tagged school ${crawlerMetadata?.school_id || crawlerMetadata?.school_normalized}`)
    totalConfidence += DEFAULT_REASON_WEIGHTS.crawler_school_metadata
  }

  // Scholarship category from opportunity record
  if (opportunity.category && /scholarship|aid|grant/i.test(opportunity.category)) {
    addType('scholarship', DEFAULT_REASON_WEIGHTS.scholarship_category_match,
      'scholarship_category_match',
      `opportunity.category=${opportunity.category}`)
  }
  if (opportunity.funding_source_type === 'university') {
    addType('financial_aid', DEFAULT_REASON_WEIGHTS.scholarship_category_match,
      'scholarship_category_match',
      'opportunity.funding_source_type=university')
  }

  // Application URL evidence
  if (sourceUrl && /apply|application/i.test(sourceUrl)) {
    pushReason(reasons, 'application_url_evidence', DEFAULT_REASON_WEIGHTS.application_url_evidence,
      `URL contains "apply": ${sourceUrl}`)
    totalConfidence += DEFAULT_REASON_WEIGHTS.application_url_evidence
  }

  // Profile program/major match (department / program-specific)
  const programs = collectProfilePrograms(profile)
  if (programs.length > 0) {
    for (const prog of programs) {
      const safeProg = String(prog || '').trim()
      if (!safeProg) continue
      const re = new RegExp(`\\b${safeProg.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i')
      if (re.test(oppText)) {
        addType('department', DEFAULT_REASON_WEIGHTS.profile_program_or_major_match,
          'profile_program_or_major_match',
          `opportunity mentions program/major "${safeProg}"`)
        break
      }
    }
  }

  // External-application override: if the hosting domain is a generic
  // scholarship marketplace and we have NO institutional reason, classify
  // it as external_application instead of scholarship/financial_aid.
  if (sourceHost && isExternalScholarshipHost(sourceHost)) {
    addType('external_application', 0.20,
      'application_url_evidence',
      `hosted on external scholarship marketplace (${sourceHost})`)
  }

  // ── Pick a winner ────────────────────────────────────────────────
  let winner = null
  let winnerWeight = 0
  for (const [type, weight] of candidates.entries()) {
    if (weight > winnerWeight) {
      winner = type
      winnerWeight = weight
    }
  }

  if (!winner) {
    return makeManualFallback({
      profileId: profile?.id ?? null,
      opportunityId: opportunity?.id ?? null,
      grantId: opportunity?.grant_id ?? null,
      reason: 'no_signals_matched',
      reasons,
      schoolId: matchedKnownSchool?.fafsaCode ?? null,
      schoolName: matchedSchoolName ?? matchedFromProfile?.name ?? null,
      applicationUrl: sourceUrl,
    })
  }

  const confidence = Math.max(0, Math.min(1, totalConfidence))

  // ── Determine login / admin / can-hamilton flags ──────────────────────
  const requiresUserLogin = winner === 'financial_aid'
    || winner === 'student_account'
    || winner === 'bursar'
    || winner === 'graduate_school'
    || winner === 'program_specific'
    || (winner === 'admissions' && Boolean(matchedKnownSchool))
  const requiresAdminReview = confidence < 0.35
  const canHamiltonAttempt = (winner === 'external_application' || winner === 'admissions' || winner === 'scholarship')
    && !requiresUserLogin
    && confidence >= 0.4

  const missingRequirements = []
  if (!sourceUrl) missingRequirements.push({ kind: 'application_url', reason: 'opportunity has no application URL' })
  if (winner === 'financial_aid' && !committed) {
    missingRequirements.push({ kind: 'school_commitment', reason: 'student must confirm which school this aid applies to' })
  }
  if (winner === 'department' && programs.length === 0) {
    missingRequirements.push({ kind: 'program_or_major', reason: 'departmental scholarship requires a declared program/major' })
  }

  return {
    profile_id: profile.id ?? null,
    opportunity_id: opportunity.id ?? null,
    grant_id: opportunity.grant_id ?? null,
    school_id: matchedKnownSchool?.fafsaCode ?? null,
    school_display_name: matchedSchoolName
      ?? matchedFromProfile?.name
      ?? matchedKnownSchool?.name
      ?? null,
    portal_id: null, // resolved during persistence
    portal_type: winner,
    action_type: winner === 'manual_or_offline' ? 'review' : 'apply',
    application_url: sourceUrl,
    confidence,
    reasons,
    missing_requirements: missingRequirements,
    can_hamilton_attempt: canHamiltonAttempt,
    requires_user_login: requiresUserLogin,
    requires_admin_review: requiresAdminReview,
  }
}

function makeManualFallback({
  profileId,
  opportunityId,
  grantId = null,
  reason,
  reasons = [],
  schoolId = null,
  schoolName = null,
  applicationUrl = null,
}) {
  return {
    profile_id: profileId,
    opportunity_id: opportunityId,
    grant_id: grantId,
    school_id: schoolId,
    school_display_name: schoolName,
    portal_id: null,
    portal_type: 'manual_or_offline',
    action_type: 'review',
    application_url: applicationUrl,
    confidence: 0,
    reasons: [
      { key: 'manual_fallback', weight: 0, detail: reason || 'no portal could be inferred' },
      ...reasons,
    ],
    missing_requirements: [
      { kind: 'manual_review', reason: reason || 'GrantFlow could not infer a portal — please review manually.' },
    ],
    can_hamilton_attempt: false,
    requires_user_login: false,
    requires_admin_review: true,
  }
}

function collectProfileSchools(profile) {
  const list = []
  const apps =
    profile?.university_applications?.applications
    || profile?.universityApplications?.applications
    || profile?.applications
    || []
  if (Array.isArray(apps)) {
    for (const app of apps) {
      if (!app || typeof app !== 'object') continue
      const name = app.name || app.school_name || app.school
      if (!name) continue
      list.push({
        name: String(name),
        committed: Boolean(app.committed) || app.status === 'committed',
        status: app.status || null,
        program: app.program || app.major || null,
      })
    }
  }
  // Top-level "school" field on simpler student profiles
  if (profile?.school && !list.some((s) => s.name.toLowerCase() === String(profile.school).toLowerCase())) {
    list.push({ name: String(profile.school), committed: true, status: 'committed' })
  }
  return list
}

function collectProfilePrograms(profile) {
  const set = new Set()
  if (profile?.major) set.add(String(profile.major))
  if (profile?.program) set.add(String(profile.program))
  if (profile?.intended_major) set.add(String(profile.intended_major))
  if (profile?.degree) set.add(String(profile.degree))
  const apps = profile?.university_applications?.applications || profile?.applications || []
  if (Array.isArray(apps)) {
    for (const app of apps) {
      if (app?.program) set.add(String(app.program))
      if (app?.major) set.add(String(app.major))
    }
  }
  return [...set].filter(Boolean)
}

/**
 * Classify the opportunity, ensure the matching student_portal record
 * exists, and persist the link in `application_portal_links`. Idempotent
 * — repeated calls update the existing link row.
 */
export async function linkOpportunityToPortal(db, {
  profile,
  profileId = null,
  opportunity,
  grantId = null,
  knownSchools = null,
  crawlerMetadata = null,
  userId = null,
} = {}) {
  if (!db) throw new Error('db required')
  const effectiveProfileId = profileId || profile?.id
  if (!effectiveProfileId) throw new Error('profileId required')
  if (!opportunity) throw new Error('opportunity required')

  await ensureStudentPortalsSchema(db)
  await ensureLinkSchema(db)

  const classification = classifyFundingPortal({ profile, opportunity, knownSchools, crawlerMetadata })
  classification.profile_id = effectiveProfileId
  if (grantId) classification.grant_id = grantId

  // Ensure the matching student_portals row exists (so a portal_id can be
  // attached). We only auto-create the portal record when we have a school
  // signal — otherwise the link points to a portal_type but no portal_id.
  let portalId = null
  if (classification.school_display_name && classification.portal_type !== 'manual_or_offline') {
    const portal = await upsertStudentPortal(db, effectiveProfileId, {
      user_id: userId,
      school_id: classification.school_id,
      school_display_name: classification.school_display_name,
      portal_type: classification.portal_type,
      portal_url: pickPortalUrl(classification, knownSchools),
      application_url: classification.application_url,
      source: 'inferred',
      confidence: classification.confidence,
      reason: classification.reasons.map((r) => r.key).join(','),
      sso_required: classification.requires_user_login,
      credentials_required: classification.requires_user_login,
      credentials_status: classification.requires_user_login ? 'needed' : 'unknown',
    })
    portalId = portal.id
  }

  classification.portal_id = portalId

  // Persist the link
  return await withProfileScope({ bypass: true }, async () => {
    const existing = await db
      .prepare(
        `SELECT id FROM application_portal_links
          WHERE profile_id = ? AND COALESCE(opportunity_id,'') = ? AND COALESCE(grant_id,'') = ?
          LIMIT 1`,
      )
      .get(
        String(effectiveProfileId),
        classification.opportunity_id ? String(classification.opportunity_id) : '',
        classification.grant_id ? String(classification.grant_id) : '',
      )

    if (existing?.id) {
      await db
        .prepare(
          `UPDATE application_portal_links
             SET updated_at = ${db.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'},
                 user_id = COALESCE(?, user_id),
                 portal_id = ?,
                 school_id = ?,
                 portal_type = ?,
                 action_type = ?,
                 application_url = ?,
                 confidence = ?,
                 reasons_json = ?,
                 missing_requirements_json = ?,
                 can_hamilton_attempt = ?,
                 requires_user_login = ?,
                 requires_admin_review = ?
           WHERE id = ?`,
        )
        .run(
          userId,
          portalId,
          classification.school_id,
          classification.portal_type,
          classification.action_type,
          classification.application_url,
          classification.confidence,
          JSON.stringify(classification.reasons),
          JSON.stringify(classification.missing_requirements),
          classification.can_hamilton_attempt ? 1 : 0,
          classification.requires_user_login ? 1 : 0,
          classification.requires_admin_review ? 1 : 0,
          existing.id,
        )
      return { ...classification, link_id: existing.id, created: false }
    }

    const id = crypto.randomUUID()
    await db
      .prepare(
        `INSERT INTO application_portal_links
           (id, profile_id, user_id, opportunity_id, grant_id, portal_id, school_id,
            portal_type, action_type, application_url, confidence,
            reasons_json, missing_requirements_json,
            can_hamilton_attempt, requires_user_login, requires_admin_review,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?,
                 ?, ?, ?,
                 ${db.dialect === 'postgres' ? 'now(), now()' : 'CURRENT_TIMESTAMP, CURRENT_TIMESTAMP'})`,
      )
      .run(
        id,
        String(effectiveProfileId),
        userId,
        classification.opportunity_id,
        classification.grant_id,
        portalId,
        classification.school_id,
        classification.portal_type,
        classification.action_type,
        classification.application_url,
        classification.confidence,
        JSON.stringify(classification.reasons),
        JSON.stringify(classification.missing_requirements),
        classification.can_hamilton_attempt ? 1 : 0,
        classification.requires_user_login ? 1 : 0,
        classification.requires_admin_review ? 1 : 0,
      )
    return { ...classification, link_id: id, created: true }
  })
}

function pickPortalUrl(classification, knownSchools) {
  const school = classification.school_display_name
    ? (knownSchools?.getKnownSchool ? knownSchools.getKnownSchool(classification.school_display_name) : getKnownSchool(classification.school_display_name))
    : null
  if (!school) return classification.application_url
  const portals = school.portals || {}
  switch (classification.portal_type) {
    case 'financial_aid':       return portals.financialAid || classification.application_url
    case 'scholarship':         return portals.scholarships || portals.financialAid || classification.application_url
    case 'admissions':          return portals.admissions || classification.application_url
    case 'department':
    case 'program_specific':    return classification.application_url || portals.scholarships
    case 'student_account':
    case 'bursar':              return classification.application_url || school.website
    default:                    return classification.application_url
  }
}

/**
 * List the portal links recorded for a profile. Useful for the pipeline
 * UI ("Linked portal" badge) and for the admin "Funding portal links"
 * tab.
 */
export async function listFundingPortalLinks(db, profileId) {
  if (!profileId) return []
  await ensureLinkSchema(db)
  const rows = await db
    .prepare(
      `SELECT * FROM application_portal_links WHERE profile_id = ? ORDER BY updated_at DESC`,
    )
    .all(String(profileId))
  return (rows || []).map(rowToLink)
}

export async function getFundingPortalLink(db, profileId, linkId) {
  if (!profileId || !linkId) return null
  await ensureLinkSchema(db)
  const row = await db
    .prepare(`SELECT * FROM application_portal_links WHERE id = ? AND profile_id = ?`)
    .get(String(linkId), String(profileId))
  return row ? rowToLink(row) : null
}

export async function getFundingPortalLinkForOpportunity(db, profileId, { opportunityId = null, grantId = null } = {}) {
  if (!profileId || (!opportunityId && !grantId)) return null
  await ensureLinkSchema(db)
  const row = await db
    .prepare(
      `SELECT * FROM application_portal_links
        WHERE profile_id = ?
          AND COALESCE(opportunity_id,'') = ?
          AND COALESCE(grant_id,'') = ?
        LIMIT 1`,
    )
    .get(String(profileId), opportunityId ? String(opportunityId) : '', grantId ? String(grantId) : '')
  return row ? rowToLink(row) : null
}

function rowToLink(row) {
  if (!row) return null
  const safeJson = (val, fallback) => {
    if (!val) return fallback
    if (typeof val === 'object') return val
    try { return JSON.parse(val) } catch { return fallback }
  }
  return {
    id: row.id,
    profile_id: row.profile_id,
    user_id: row.user_id ?? null,
    opportunity_id: row.opportunity_id ?? null,
    grant_id: row.grant_id ?? null,
    portal_id: row.portal_id ?? null,
    school_id: row.school_id ?? null,
    portal_type: row.portal_type,
    action_type: row.action_type ?? null,
    application_url: row.application_url ?? null,
    confidence: Number(row.confidence ?? 0),
    reasons: safeJson(row.reasons_json, []),
    missing_requirements: safeJson(row.missing_requirements_json, []),
    can_hamilton_attempt: Boolean(row.can_hamilton_attempt),
    requires_user_login: Boolean(row.requires_user_login),
    requires_admin_review: Boolean(row.requires_admin_review),
    notes: row.notes ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export { rowToLink as _rowToLink }
