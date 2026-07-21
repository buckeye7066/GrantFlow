/**
 * Durable qualified-match -> pipeline convergence job.
 *
 * Candidate selection deliberately ignores stored match_score/match_decision.
 * Every attempted row goes through saveToProfilePipeline, which performs a
 * fresh canonical decision and records the outcome through the sink below.
 */

import { createLogger } from '../utils/logger.js'
import { loadProfileContext } from './profileHelpers.js'
import { saveToProfilePipeline, pipelineAdmissionFingerprints } from './opportunityMatcher.js'
import { reconcileDismissedGrants } from './pipelineDismissals.js'
import {
  ORIGIN_CREATED_BY,
  ORIGIN_AGENT,
  CREATED_FOR,
  METADATA_SECTION_KEY,
  TAG_SYNTHETIC,
  TAG_PIPELINE,
} from './amy/amyConstants.js'
import {
  enforceAmySyntheticExpiry,
  enforceGrantCatalogLink,
  enforceAmountEnrichment,
} from '../startup/enforceInvariants.js'
import { runWithSchedulerLock } from './schedulerLock.js'
import { eligibleDayKey, etNowParts } from '../utils/etTime.js'

const log = createLogger('pipelinePromotion')
const TERMINAL_OUTCOMES = new Set([
  'promoted', 'tombstoned', 'duplicate', 'source_excluded', 'live_reject', 'below_bar',
])
const CURSOR_KEY = 'pipeline_promotion_round_robin_cursor'
const SCHEDULE_MARKER_KEY = 'qualified_pipeline_promotion_last_run'
const SCHEDULE_LOCK_NAME = 'qualified-pipeline-promotion'
export const PROJECTION_KEY = 'promotion_projection'

function envBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function changesOf(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0) || 0
}

function parseJson(value, fallback) {
  try { return typeof value === 'string' ? JSON.parse(value) : (value ?? fallback) } catch { return fallback }
}

function isSyntheticProfile(profile, sections = {}) {
  if (String(profile?.created_by || '') === ORIGIN_CREATED_BY) return true
  const tags = Array.isArray(profile?.tags) ? profile.tags : parseJson(profile?.tags, [])
  if (tags.map(String).some((tag) => tag === TAG_SYNTHETIC || tag === TAG_PIPELINE)) return true
  const metadata = sections?.[METADATA_SECTION_KEY] ?? {}
  return metadata?.synthetic === true ||
    metadata?.allow_sam_cleanup === true ||
    String(metadata?.origin_agent || '').toLowerCase() === ORIGIN_AGENT.toLowerCase() ||
    String(metadata?.created_for || '') === CREATED_FOR
}

function classifyOutcome(payload) {
  if (payload?.outcome === 'promoted') return 'promoted'
  const reason = String(payload?.reason || 'error:transient')
  if (reason === 'tombstoned') return 'tombstoned'
  if (reason.startsWith('duplicate:')) return 'duplicate'
  if (reason === 'source_excluded') return 'source_excluded'
  if (reason === 'live_reject') return 'live_reject'
  if (reason === 'below_bar' || reason === 'relevance_floor') return 'below_bar'
  return 'error'
}

async function kvSet(db, key, value) {
  const now = new Date().toISOString()
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
  const updated = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(stringValue, now, key)
  if (!changesOf(updated)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, stringValue, now)
  }
}

async function kvGet(db, key) {
  const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key)
  return row?.value ?? null
}

async function recordOutcome(db, { profileId, opportunityId, mode, payload }) {
  const outcome = classifyOutcome(payload)
  const attemptedAt = new Date().toISOString()
  const args = [
    profileId,
    opportunityId,
    mode,
    outcome,
    String(payload?.reason || (outcome === 'promoted' ? 'accepted' : 'error:transient')),
    Number.isFinite(Number(payload?.score)) ? Number(payload.score) : null,
    attemptedAt,
    payload.profile_facts_hash,
    payload.policy_version,
    String(payload.opportunity_updated_at ?? ''),
  ]
  const conflictGuard = mode === 'dry_run'
    ? " WHERE pipeline_promotion_outcomes.mode = 'dry_run'"
    : " WHERE NOT (pipeline_promotion_outcomes.mode = 'live' AND pipeline_promotion_outcomes.outcome = 'promoted')"
  await db.prepare(
    `INSERT INTO pipeline_promotion_outcomes
       (profile_id, opportunity_id, mode, outcome, reason, score, attempted_at, attempts,
        profile_facts_hash, policy_version, opportunity_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(profile_id, opportunity_id) DO UPDATE SET
       mode = excluded.mode,
       outcome = excluded.outcome,
       reason = excluded.reason,
       score = excluded.score,
       attempted_at = excluded.attempted_at,
       attempts = pipeline_promotion_outcomes.attempts + 1,
       profile_facts_hash = excluded.profile_facts_hash,
       policy_version = excluded.policy_version,
       opportunity_updated_at = excluded.opportunity_updated_at${conflictGuard}`,
  ).run(...args)
}

function fingerprintsMatch(row, current) {
  return String(row?.profile_facts_hash || '') === current.profile_facts_hash &&
    String(row?.policy_version || '') === current.policy_version &&
    String(row?.opportunity_updated_at || '') === current.opportunity_updated_at
}

function errorCooldownElapsed(row, nowMs) {
  const attempts = Math.max(0, Number(row?.attempts) || 0)
  const attemptedMs = Date.parse(row?.attempted_at || '')
  if (!Number.isFinite(attemptedMs)) return true
  const cooldownMs = Math.min(24, Math.max(1, attempts)) * 60 * 60 * 1000
  return nowMs - attemptedMs >= cooldownMs
}

function nightlyRecheckElapsed(row, nowMs) {
  const attemptedMs = Date.parse(row?.attempted_at || '')
  return !Number.isFinite(attemptedMs) || nowMs - attemptedMs >= 20 * 60 * 60 * 1000
}

async function loadRealProfiles(db) {
  const rows = await db.prepare(
    `SELECT p.*
       FROM profiles p
      WHERE p.deleted_at IS NULL
        AND (p.status IS NULL OR LOWER(p.status) NOT IN ('deleted','archived','merged','inactive'))
      ORDER BY p.id ASC`,
  ).all()
  const real = []
  for (const profile of rows || []) {
    let context
    try { context = await loadProfileContext(db, profile.id) } catch { continue }
    if (!isSyntheticProfile(profile, context.sections)) real.push({ profile, context })
  }
  return real
}

async function listEligibleCandidates(db, profileContext, profileId, nowMs = Date.now()) {
  const rows = await db.prepare(
    `SELECT o.*, m.match_score AS stored_match_score, m.match_decision AS stored_match_decision,
            po.mode AS promotion_mode, po.outcome AS promotion_outcome, po.reason AS promotion_reason,
            po.attempted_at, po.attempts, po.profile_facts_hash, po.policy_version,
            po.opportunity_updated_at AS recorded_opportunity_updated_at
       FROM profile_opportunity_matches m
       JOIN funding_opportunities o ON o.id = m.opportunity_id
       LEFT JOIN pipeline_promotion_outcomes po
         ON po.profile_id = m.profile_id AND po.opportunity_id = m.opportunity_id AND po.mode = 'live'
      WHERE m.profile_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM grants g
           WHERE g.profile_id = m.profile_id AND g.funding_opportunity_id = m.opportunity_id
        )
      ORDER BY COALESCE(po.attempts, 0) ASC,
               CASE WHEN COALESCE(o.amount_max, 0) > 0 OR COALESCE(o.amount_min, 0) > 0 THEN 0 ELSE 1 END ASC,
               m.opportunity_id ASC`,
  ).all(profileId)

  return (rows || []).filter((row) => {
    if (row.promotion_mode !== 'live' || !row.promotion_outcome) return true
    if (row.promotion_outcome === 'duplicate') return nightlyRecheckElapsed(row, nowMs)
    if (row.promotion_outcome === 'promoted') return true
    if (row.promotion_outcome === 'error') return errorCooldownElapsed(row, nowMs)
    if (!TERMINAL_OUTCOMES.has(row.promotion_outcome)) return true
    const current = pipelineAdmissionFingerprints(profileContext, row)
    return !fingerprintsMatch({
      ...row,
      opportunity_updated_at: row.recorded_opportunity_updated_at,
    }, current)
  })
}

function rotateProfiles(profiles, cursor) {
  if (!profiles.length || !cursor) return profiles
  const index = profiles.findIndex(({ profile }) => String(profile.id) > String(cursor))
  if (index <= 0) return index === 0 ? profiles : profiles
  return [...profiles.slice(index), ...profiles.slice(0, index)]
}

async function remainingFromDb(db, profiles) {
  let remaining = 0
  for (const { profile, context } of profiles) {
    remaining += (await listEligibleCandidates(db, context, profile.id)).length
  }
  return remaining
}

export async function getPromotionOutcomeSummary(db, profileId) {
  const rows = await db.prepare(
    `SELECT po.outcome, po.reason, LOWER(COALESCE(o.opportunity_kind, '')) AS opportunity_kind,
            COUNT(*) AS count
       FROM pipeline_promotion_outcomes po
       LEFT JOIN funding_opportunities o ON o.id = po.opportunity_id
      WHERE po.profile_id = ? AND po.mode = 'live'
      GROUP BY po.outcome, po.reason, LOWER(COALESCE(o.opportunity_kind, ''))`,
  ).all(profileId)
  const summary = { qualified: 0, more_places_to_look: 0, reasons: {} }
  for (const row of rows || []) {
    const count = Number(row.count) || 0
    const locator = row.opportunity_kind === 'directory' || row.opportunity_kind === 'past_award_intel'
    if (row.outcome === 'promoted') {
      if (locator) summary.more_places_to_look += count
      else summary.qualified += count
    } else {
      summary.reasons[row.reason] = (summary.reasons[row.reason] || 0) + count
    }
  }
  return summary
}

export async function runQualifiedPipelinePromotion(db, options = {}) {
  const enabled = options.enabled ?? envBool(process.env.ENFORCE_QUALIFIED_PROMOTION, false)
  const mode = enabled ? 'live' : 'dry_run'
  const batch = Math.max(1, Number.parseInt(options.batch ?? process.env.PROMOTION_BATCH ?? '100', 10) || 100)
  const timeBudgetMs = Math.max(1000, Number.parseInt(options.timeBudgetMs ?? process.env.PROMOTION_TIME_BUDGET_MS ?? '30000', 10) || 30000)
  const amountBudget = Math.max(1, Number.parseInt(options.amountBudget ?? process.env.PROMOTION_AMOUNT_BUDGET ?? '10', 10) || 10)
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  let deletedDryRun = 0
  if (enabled) {
    deletedDryRun = changesOf(await db.prepare("DELETE FROM pipeline_promotion_outcomes WHERE mode = 'dry_run'").run())
    log.info('qualified promotion enabled; cleared dry-run outcomes', { deletedDryRun })
  }

  const profiles = await loadRealProfiles(db)
  const cursor = await kvGet(db, CURSOR_KEY).catch(() => null)
  const ordered = rotateProfiles(profiles, cursor)
  const queues = new Map()
  for (const item of ordered) {
    queues.set(item.profile.id, await listEligibleCandidates(db, item.context, item.profile.id, startedMs))
  }

  let attempted = 0
  let promoted = 0
  let projectedNullAmounts = 0
  const promotedGrantIds = []
  const promotedOpportunityIds = []
  const affectedProfiles = new Set()
  const summaries = new Map()
  let lastProfileId = cursor

  while (attempted < batch && Date.now() - startedMs < timeBudgetMs) {
    let progressed = false
    for (const { profile, context } of ordered) {
      if (attempted >= batch || Date.now() - startedMs >= timeBudgetMs) break
      const queue = queues.get(profile.id) || []
      const candidate = queue.shift()
      if (!candidate) continue
      progressed = true
      attempted++
      lastProfileId = profile.id
      const summary = summaries.get(profile.id) || { attempted: 0, promoted: 0, reasons: {} }
      summary.attempted++

      let recordedPayload = null
      const attemptPromotion = async (writeDb) => {
        const sink = {
          mode,
          required: mode === 'live',
          failClosedTombstone: true,
          freshRescoreRequired: true,
          quiet: true,
          record: async (payload) => {
            recordedPayload = payload
            await recordOutcome(writeDb, {
              profileId: profile.id,
              opportunityId: candidate.id,
              mode,
              payload,
            })
          },
        }
        return saveToProfilePipeline(writeDb, candidate, profile.id, context, null, null, sink)
      }
      if (mode === 'live' && typeof db.withTransaction !== 'function') {
        throw new Error('Live qualified promotion requires transactional database support')
      }
      const result = mode === 'live'
        ? await db.withTransaction(attemptPromotion)
        : await attemptPromotion(db)
      const outcome = classifyOutcome(recordedPayload)
      summary.reasons[outcome] = (summary.reasons[outcome] || 0) + 1
      if (result?.saved || result?.projected) {
        promoted++
        summary.promoted++
        if (!(Number(candidate.amount_max) > 0 || Number(candidate.amount_min) > 0)) projectedNullAmounts++
      }
      if (result?.saved) {
        affectedProfiles.add(profile.id)
        promotedGrantIds.push(result.pipelineId)
        promotedOpportunityIds.push(candidate.id)
      }
      summaries.set(profile.id, summary)
    }
    if (!progressed) break
  }

  if (lastProfileId) await kvSet(db, CURSOR_KEY, lastProfileId)

  if (mode === 'dry_run') {
    await kvSet(db, PROJECTION_KEY, {
      projected_rows: promoted,
      projected_null_amounts: projectedNullAmounts,
      started_at: startedAt,
    })
  } else if (promotedGrantIds.length) {
    await enforceGrantCatalogLink(db, { grantIds: promotedGrantIds, limit: amountBudget })
    if (options.amountFollowup !== false) {
      await enforceAmountEnrichment(db, {
        opportunityIds: promotedOpportunityIds,
        limit: amountBudget,
        timeBudgetMs: Math.min(timeBudgetMs, 10_000),
      })
    }
    await reconcileDismissedGrants(db)
  }

  const remaining = await remainingFromDb(db, profiles)
  for (const [profileId, summary] of summaries) {
    log.info('qualified promotion profile summary', { profileId, mode, ...summary })
  }
  return {
    mode,
    attempted,
    promoted,
    projectedNullAmounts,
    remaining,
    profiles: summaries.size,
    affectedProfiles: affectedProfiles.size,
    deletedDryRun,
    startedAt,
  }
}

export async function runQualifiedPipelinePromotionAfterAmy(db, options = {}) {
  const amy = await enforceAmySyntheticExpiry(db)
  const promotion = await runQualifiedPipelinePromotion(db, options)
  return { amy, promotion }
}

export async function runScheduledQualifiedPipelinePromotion(db, options = {}) {
  const triggerHour = Math.max(0, Math.min(23, Number(options.triggerHour ?? process.env.PIPELINE_PROMOTION_HOUR_ET) || 4))
  const dayKey = options.dayKey ?? eligibleDayKey(triggerHour, options.nowParts ?? etNowParts())
  const source = options.source || 'scheduler'
  return runWithSchedulerLock(db, {
    lockName: SCHEDULE_LOCK_NAME,
    ttlMs: 2 * 60 * 60 * 1000,
    logger: options.logger || console,
    acquiredBy: `pipeline-promotion:${source}`,
  }, async () => {
    if (await kvGet(db, SCHEDULE_MARKER_KEY) === dayKey) {
      return { skipped: true, reason: 'already_ran', dayKey }
    }
    const result = await runQualifiedPipelinePromotionAfterAmy(db, options.promotionOptions)
    await kvSet(db, SCHEDULE_MARKER_KEY, dayKey)
    return result
  })
}

export const __testables = {
  isSyntheticProfile,
  classifyOutcome,
  fingerprintsMatch,
  listEligibleCandidates,
  remainingFromDb,
  getPromotionOutcomeSummary,
}
