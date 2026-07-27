import { randomUUID } from 'node:crypto'
import { assessOpportunityTrust } from '../opportunityTrust.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../../config/matchSurfacing.js'

const ALLOWED_MATCH_DECISIONS = new Set(['accept', 'review'])
const PROFILE_MATCH_REQUIRED_ORIGINS = new Set(['live_crawl', 'geo_crawl', 'discovered'])
const TERMINAL_TASK_STATUSES = new Set(['submitted', 'completed', 'cancelled'])
const TRUST_BLOCK_FLAGS = new Set([
  'loan',
  'matching_funds',
  'placeholder',
  'no_real_url',
  'expired',
  'untrusted',
])

function asLower(value) {
  return String(value || '').trim().toLowerCase()
}

function nowFn(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

function placeholders(values) {
  return values.map(() => '?').join(',')
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean).map(String)))
}

async function loadOpportunityForPolicy(db, profileId, opportunity, grant) {
  if (opportunity?.id) return opportunity

  const linkedOpportunityId = grant?.funding_opportunity_id || grant?.opportunity_id || null
  if (!linkedOpportunityId) return null

  try {
    return profileId
      ? db.prepare(
          'SELECT * FROM funding_opportunities WHERE id = ? AND (profile_id IS NULL OR profile_id = ?) LIMIT 1',
        ).get(String(linkedOpportunityId), String(profileId))
      : db.prepare(
          'SELECT * FROM funding_opportunities WHERE id = ? AND profile_id IS NULL LIMIT 1',
        ).get(String(linkedOpportunityId))
  } catch {
    return null
  }
}

async function loadProfileMatch(db, profileId, opportunityId) {
  if (!profileId || !opportunityId) return null

  try {
    return db.prepare(`
      SELECT match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at
      FROM profile_opportunity_matches
      WHERE profile_id = ?
        AND opportunity_id = ?
        AND matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
      ORDER BY
        CASE matcher_version
          WHEN 'crawler-os' THEN 0
          WHEN 'crawler-os-xmatch' THEN 1
          ELSE 3
        END,
        updated_at IS NULL,
        updated_at DESC,
        computed_at IS NULL,
        computed_at DESC
      LIMIT 1
    `).get(String(profileId), String(opportunityId))
  } catch {
    return null
  }
}

function trustBlockReasons(trust) {
  const flags = trust?.flags || {}
  const flagged = Object.entries(flags)
    .filter(([key, value]) => value && TRUST_BLOCK_FLAGS.has(key))
    .map(([key]) => key)

  if (!trust?.display && trust?.reasons?.length) {
    return unique([...flagged, ...trust.reasons])
  }

  return unique(flagged)
}

function buildPolicyMessage(reasons) {
  if (!reasons.length) return 'Funding source does not meet GrantFlow crawler/profile rules.'
  return `Funding source does not meet GrantFlow crawler/profile rules: ${reasons.join(', ')}.`
}

function requiresProfileMatch(subject) {
  const origin = asLower(subject?.record_origin)
  return PROFILE_MATCH_REQUIRED_ORIGINS.has(origin)
}

/**
 * LIVE canonical engine verdict for a (profile, subject) pair — the fallback
 * when no STORED match row exists (the TSAA class, 2026-07-27).
 *
 * The match store is a ROLLING SNAPSHOT: crawlerOsPersistence's reconcile
 * DELETEs a profile's crawler-os/xmatch rows on every discovery run and
 * re-inserts only what THAT run re-found (deliberate — "reconcile, don't
 * accumulate"). Tasks and grants are DURABLE. So any long-lived task
 * eventually points at a pair whose match row a reconcile wiped (crawls are
 * budget-bounded and never guaranteed to re-find everything), and requiring a
 * stored row here turned "the crawl didn't happen to re-surface it" into a
 * permanent missing_profile_crawler_match stop — prod carried 29 such stops,
 * including TSAA for a Tennessee student whose own store held 125 live rows.
 *
 * The requirement's PURPOSE is engine endorsement, and matchEngine is the
 * sole decision authority — a LIVE computeMatchDecision is fresher evidence
 * than any snapshot row (the funding-sources route recomputes live on every
 * read for the same reason). Dynamic imports keep this module light for its
 * crawler-persistence importer and avoid load-time cycles. Returns null when
 * the live compute is unavailable, in which case the caller keeps the
 * conservative stop.
 */
async function computeLiveEngineDecision(db, profileId, subject) {
  try {
    const [{ loadProfileContext }, { buildProfileFacets }, { computeMatchDecision }] = await Promise.all([
      import('../profileHelpers.js'),
      import('../profile/profileTaxonomy.js'),
      import('../matchEngine.js'),
    ])
    const ctx = buildProfileFacets(await loadProfileContext(db, profileId))
    const rawProfile = ctx?.profile ?? ctx
    return computeMatchDecision(rawProfile, subject, {
      profileSections: ctx?.sections ?? null,
      signals: ctx?.signals ?? null,
    })
  } catch {
    return null
  }
}

export async function assessHamiltonFundingSource(db, { profileId, opportunity = null, grant = null } = {}) {
  const policyOpportunity = await loadOpportunityForPolicy(db, profileId, opportunity, grant)
  const subject = policyOpportunity || grant

  if (!subject?.id) {
    return {
      ok: false,
      code: 'missing_funding_source',
      reasons: ['missing_funding_source'],
      message: 'Funding source could not be found for Hamilton automation.',
    }
  }

  const trust = assessOpportunityTrust(subject, { allowDirectory: true, allowExpired: false })
  const trustReasons = trustBlockReasons(trust)
  if (!trust?.display || trustReasons.length) {
    return {
      ok: false,
      code: 'funding_source_disallowed',
      reasons: trustReasons.length ? trustReasons : ['trust_policy'],
      trust,
      message: buildPolicyMessage(trustReasons),
    }
  }

  const opportunityId = policyOpportunity?.id || grant?.funding_opportunity_id || grant?.opportunity_id || null
  const match = await loadProfileMatch(db, profileId, opportunityId)
  const decision = asLower(match?.match_decision)
  if (decision === 'reject') {
    const reasons = ['profile_match_rejected']
    if (match?.match_explanation) reasons.push(String(match.match_explanation).slice(0, 180))
    return {
      ok: false,
      code: 'funding_source_profile_rejected',
      reasons,
      trust,
      match,
      message: buildPolicyMessage(reasons),
    }
  }
  if (decision && !ALLOWED_MATCH_DECISIONS.has(decision)) {
    const reasons = ['profile_match_not_accepted']
    return {
      ok: false,
      code: 'funding_source_profile_not_accepted',
      reasons,
      trust,
      match,
      message: buildPolicyMessage(reasons),
    }
  }
  if (!match && profileId && opportunityId && requiresProfileMatch(subject)) {
    // No stored row ≠ no endorsement — the store is a rolling snapshot (see
    // computeLiveEngineDecision). Ask the engine LIVE before stopping.
    const live = await computeLiveEngineDecision(db, profileId, subject)
    const liveDecision = asLower(live?.decision)
    if (liveDecision === 'accept' || liveDecision === 'review') {
      return {
        ok: true,
        reasons: [],
        warnings: ['live_engine_endorsed'],
        trust,
        match: {
          live: true,
          match_decision: liveDecision,
          match_score: Number.isFinite(Number(live?.score)) ? Number(live.score) : null,
          match_explanation: live?.explanation ?? null,
          matcher_version: 'live-recheck',
        },
        opportunityId,
        grantId: grant?.id || null,
      }
    }
    if (liveDecision === 'reject') {
      const reasons = ['profile_match_rejected']
      if (live?.explanation) reasons.push(String(live.explanation).slice(0, 180))
      return {
        ok: false,
        code: 'funding_source_profile_rejected',
        reasons,
        trust,
        match: { live: true, match_decision: 'reject', match_explanation: live?.explanation ?? null },
        message: buildPolicyMessage(reasons),
      }
    }
    // Live compute unavailable (profile failed to load, engine error) — keep
    // the conservative stop rather than inventing an endorsement.
    const reasons = ['missing_profile_crawler_match']
    return {
      ok: false,
      code: 'funding_source_missing_profile_match',
      reasons,
      trust,
      match,
      message: buildPolicyMessage(reasons),
    }
  }

  return {
    ok: true,
    reasons: [],
    warnings: match || !opportunityId ? [] : ['no_profile_match'],
    trust,
    match,
    opportunityId,
    grantId: grant?.id || null,
  }
}

export async function assertHamiltonFundingSourceAllowed(db, args = {}) {
  const assessment = await assessHamiltonFundingSource(db, args)
  if (assessment.ok) return assessment

  const error = new Error(assessment.message)
  error.code = assessment.code || 'funding_source_disallowed'
  error.status = 422
  error.reasons = assessment.reasons || []
  error.assessment = assessment
  throw error
}

function sourceWhereClause({ profileId, opportunityId, grantId }, prefix = '') {
  const column = (name) => `${prefix}${name}`
  const params = [String(profileId)]
  const sourceClauses = []

  if (opportunityId) {
    sourceClauses.push(`${column('opportunity_id')} = ?`)
    params.push(String(opportunityId))
  }
  if (grantId) {
    sourceClauses.push(`${column('grant_id')} = ?`)
    params.push(String(grantId))
  }

  if (!sourceClauses.length) return null

  return {
    sql: `${column('profile_id')} = ? AND (${sourceClauses.join(' OR ')})`,
    params,
  }
}

async function loadGeneratedDocumentIds(db, profileId, tasks) {
  const ids = new Set()
  for (const task of tasks) {
    for (const key of ['output_document_id', 'output_docx_document_id', 'output_pdf_document_id']) {
      if (task?.[key]) ids.add(String(task[key]))
    }

    try {
      const rows = db.prepare(`
        SELECT id
        FROM documents
        WHERE profile_id = ?
          AND type = 'hamilton_generated_application'
          AND notes LIKE ?
      `).all(String(profileId), `%task_id=${task.id}%`)
      for (const row of rows || []) ids.add(String(row.id))
    } catch {
      // Older schemas may not have notes/type in the same shape.
    }
  }
  return Array.from(ids)
}

async function insertTaskCancellationEvent(db, taskId, message, details) {
  try {
    db.prepare(`
      INSERT INTO application_task_events (
        id, task_id, event_type, status, step, message, details_json, actor_role, created_at
      )
      VALUES (?, ?, 'cancelled', 'cancelled', 'funding_source_policy', ?, ?, 'system', ${nowFn(db)})
    `).run(randomUUID(), String(taskId), message, JSON.stringify(details || {}))
  } catch {
    // Audit is best-effort here; cleanup must continue across schema drift.
  }
}

export async function cleanupDisallowedHamiltonTraces(
  db,
  { profileId, opportunityId = null, grantId = null, reason = 'funding_source_policy' } = {},
) {
  const empty = {
    cancelled_tasks: 0,
    removed_documents: 0,
    removed_missing_info: 0,
    removed_portal_links: 0,
    revoked_authorizations: 0,
  }
  if (!db || !profileId || (!opportunityId && !grantId)) return empty

  const where = sourceWhereClause({ profileId, opportunityId, grantId })
  if (!where) return empty

  let tasks = []
  try {
    tasks = db.prepare(`
      SELECT *
      FROM application_tasks
      WHERE ${where.sql}
    `).all(...where.params) || []
  } catch {
    return empty
  }

  const activeTasks = tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(asLower(task.status)))
  const taskIds = unique(tasks.map((task) => task.id))
  const message = buildPolicyMessage([String(reason)])

  let cancelledTasks = 0
  for (const task of activeTasks) {
    try {
      const result = db.prepare(`
        UPDATE application_tasks
        SET status = 'cancelled',
            cancelled_at = ${nowFn(db)},
            completed_at = COALESCE(completed_at, ${nowFn(db)}),
            last_agent_message = ?,
            updated_at = ${nowFn(db)}
        WHERE id = ?
      `).run(message, String(task.id))
      cancelledTasks += result?.changes || 0
    } catch {
      try {
        const result = db.prepare(`
          UPDATE application_tasks
          SET status = 'cancelled', updated_at = ${nowFn(db)}
          WHERE id = ?
        `).run(String(task.id))
        cancelledTasks += result?.changes || 0
      } catch {
        // Keep cleaning other traces.
      }
    }
    await insertTaskCancellationEvent(db, task.id, message, { reason, opportunity_id: opportunityId, grant_id: grantId })
  }

  let removedMissingInfo = 0
  if (taskIds.length) {
    try {
      const result = db.prepare(`
        DELETE FROM application_missing_info
        WHERE task_id IN (${placeholders(taskIds)})
      `).run(...taskIds)
      removedMissingInfo = result?.changes || 0
    } catch {
      removedMissingInfo = 0
    }
  }

  const documentIds = await loadGeneratedDocumentIds(db, profileId, tasks)
  let removedDocuments = 0
  if (documentIds.length) {
    try {
      db.prepare(`
        DELETE FROM profile_documents
        WHERE profile_id = ? AND document_id IN (${placeholders(documentIds)})
      `).run(String(profileId), ...documentIds)
    } catch {
      // Profile-document links are best-effort cleanup across schema versions.
    }

    try {
      const result = db.prepare(`
        DELETE FROM documents
        WHERE profile_id = ?
          AND type = 'hamilton_generated_application'
          AND id IN (${placeholders(documentIds)})
      `).run(String(profileId), ...documentIds)
      removedDocuments = result?.changes || 0
    } catch {
      removedDocuments = 0
    }
  }

  let removedPortalLinks = 0
  try {
    const result = db.prepare(`
      DELETE FROM application_portal_links
      WHERE ${where.sql}
    `).run(...where.params)
    removedPortalLinks = result?.changes || 0
  } catch {
    removedPortalLinks = 0
  }

  let revokedAuthorizations = 0
  try {
    const authClauses = []
    const authParams = [String(profileId)]
    if (opportunityId) {
      authClauses.push('funding_source_id = ?')
      authParams.push(String(opportunityId))
    }
    if (grantId) {
      authClauses.push('funding_source_id = ?')
      authParams.push(String(grantId))
    }
    if (taskIds.length) {
      authClauses.push(`task_id IN (${placeholders(taskIds)})`)
      authParams.push(...taskIds)
    }

    if (authClauses.length) {
      const result = db.prepare(`
        UPDATE hamilton_authorizations
        SET revoked_at = ${nowFn(db)},
            revoked_reason = ?
        WHERE profile_id = ?
          AND revoked_at IS NULL
          AND (${authClauses.join(' OR ')})
      `).run(`funding_source_policy:${reason}`, ...authParams)
      revokedAuthorizations = result?.changes || 0
    }
  } catch {
    revokedAuthorizations = 0
  }

  return {
    cancelled_tasks: cancelledTasks,
    removed_documents: removedDocuments,
    removed_missing_info: removedMissingInfo,
    removed_portal_links: removedPortalLinks,
    revoked_authorizations: revokedAuthorizations,
  }
}
