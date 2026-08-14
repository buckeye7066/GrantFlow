/**
 * anyaMatchScout
 * --------------
 * "Anya Match Scout" — a recommend-only background scan that finds
 * funding opportunities with a deterministic match_score >= THRESHOLD
 * (the canonical strong-match bar) for one profile and writes a PENDING row to
 * `anya_match_suggestions` plus a notification of `type='anya_high_match'`.
 *
 * Hard rules (mirrored in tests):
 *
 *   - Never auto-adds to a pipeline.
 *   - Never suggests below the configured threshold.
 *   - Never suggests an opportunity already in the profile's pipeline.
 *   - Never suggests an opportunity the user previously dismissed.
 *   - Never suggests loan-only / expired / placeholder / untrusted rows
 *     (same trust gate as `/api/comprehensiveMatch`).
 *   - Respects the per-user `anya_match_scout_muted` preference.
 *   - Caps at ANYA_MATCH_SCOUT_MAX_ALERTS_PER_PROFILE per run (default 3).
 *
 * Triggered by:
 *   - the dispatcher when a `crawler_jobs` row of type `'anya_match_scout'`
 *     is queued (preferred — gives the scout retries + worker concurrency),
 *   - or a direct call from `anyaAutonomousScheduler` when running ad-hoc.
 */

import crypto from 'crypto'

import { loadProfileContext } from './profileHelpers.js'
import { computeMatchDecision } from './matchEngine.js'
import { decorateOpportunityFreshness } from './opportunityMatcher.js'
import { isJunkOpportunity } from './contentFilter.js'
import { assessOpportunityTrust } from './opportunityTrust.js'
import { interpretProfileNeeds } from './profileNeedsInterpreter.js'
import { safeParseJSON, safeStringifyJSON } from '../utils/safeJson.js'
import { createLogger } from '../utils/logger.js'
import { SCORE_SCALE_ID, STRONG_MATCH_SCORE } from '../config/matchThresholds.js'
import {
  isOpportunityLifecycleVisible,
  opportunityLifecycleVisibilitySql,
} from '../config/matchSurfacing.js'

const log = createLogger('service:anya-match-scout')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getThreshold() {
  const raw = Number(process.env.ANYA_MATCH_SCOUT_THRESHOLD)
  if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return raw
  return STRONG_MATCH_SCORE
}

function getMaxAlertsPerProfile() {
  const raw = Number(process.env.ANYA_MATCH_SCOUT_MAX_ALERTS_PER_PROFILE)
  if (Number.isFinite(raw) && raw >= 1 && raw <= 50) return Math.floor(raw)
  return 3
}

function getCandidateLimit() {
  const raw = Number(process.env.ANYA_MATCH_SCOUT_CANDIDATE_LIMIT)
  if (Number.isFinite(raw) && raw >= 50 && raw <= 5000) return Math.floor(raw)
  return 500
}

// ---------------------------------------------------------------------------
// User preference: muted?
// ---------------------------------------------------------------------------

/**
 * Read a single user's `anya_match_scout_muted` preference. Returns false
 * if no row exists (default: scout is enabled).
 *
 * Exported so the routes can use it too (e.g. the `/pending` endpoint can
 * short-circuit and return an empty list for muted users).
 */
export async function isScoutMutedForUser(db, userId) {
  if (!userId) return false
  try {
    const row = await db
      .prepare('SELECT custom_preferences FROM user_preferences WHERE user_id = ? LIMIT 1')
      .get(String(userId))
    if (!row?.custom_preferences) return false
    const custom =
      typeof row.custom_preferences === 'string'
        ? safeParseJSON(row.custom_preferences, {})
        : row.custom_preferences
    return Boolean(custom?.anya_match_scout_muted)
  } catch (err) {
    log.warn('isScoutMutedForUser failed (treating as not muted)', { user_id: userId, err: err?.message })
    return false
  }
}

// ---------------------------------------------------------------------------
// Candidate loading + filtering
// ---------------------------------------------------------------------------

async function loadCandidateOpportunities(db, profileContext) {
  const isPostgres = db?.dialect === 'postgres'
  const profile = profileContext?.profile || {}
  const profileState =
    profile?.state ||
    profileContext?.sections?.basic_information?.state ||
    profileContext?.sections?.location_focus?.state ||
    null

  // Prefer state + national. Fall back to national-only if no state.
  const clauses = [opportunityLifecycleVisibilitySql({
    dialect: isPostgres ? 'postgres' : 'sqlite',
  })]
  const params = []
  if (profileState) {
    clauses.push('(UPPER(state) = UPPER(?) OR state IS NULL OR state = \'\' OR state = \'nationwide\')')
    params.push(String(profileState))
  }

  const limit = getCandidateLimit()
  const sql = `
    SELECT *
    FROM funding_opportunities
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT ?
  `
  try {
    const rows = await db.prepare(sql).all(...params, limit)
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    log.warn('candidate load failed', { err: err?.message })
    return []
  }
}

/**
 * IDs already in this profile's pipeline (any status). The scout never
 * re-suggests these — they're already on the user's board.
 */
async function loadPipelineOpportunityIds(db, profileId) {
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT funding_opportunity_id AS id
         FROM grants
         WHERE profile_id = ? AND funding_opportunity_id IS NOT NULL`,
      )
      .all(String(profileId))
    return new Set((rows || []).map((r) => String(r.id)))
  } catch (err) {
    log.warn('pipeline ids load failed', { profile_id: profileId, err: err?.message })
    // An EXCLUSION set that fails to load must not read as "nothing to
    // exclude" — that re-suggests everything already on the user's board. The
    // caller records the degradation and skips the run rather than reporting a
    // clean pass built on an exclusion list it never actually read.
    return { error: err?.message || String(err) }
  }
}

/**
 * Opportunity IDs the user dismissed (or that are still pending from a
 * prior scout run) — suppress popups for these.
 */
async function loadSuppressedOpportunityIds(db, profileId) {
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT opportunity_id
         FROM anya_match_suggestions
         WHERE profile_id = ?
           AND opportunity_id IS NOT NULL
           AND status IN ('pending', 'dismissed', 'accepted', 'already_in_pipeline')`,
      )
      .all(String(profileId))
    return new Set((rows || []).map((r) => String(r.opportunity_id)))
  } catch (err) {
    log.warn('suppressed ids load failed', { profile_id: profileId, err: err?.message })
    // Same rule as loadPipelineOpportunityIds: an unread suppression list is
    // UNKNOWN, never empty. Returning an empty Set here re-popped every
    // suggestion the user had already dismissed.
    return { error: err?.message || String(err) }
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function buildOpportunitySnapshot(opp, trust) {
  return {
    id: opp.id,
    title: opp.title || opp.program_name,
    sponsor: opp.sponsor || opp.funder || null,
    funder: opp.sponsor || opp.funder || null,
    url: trust?.primaryUrl || opp.application_url || opp.source_url || null,
    application_url: opp.application_url || opp.url || null,
    source_url: opp.source_url || null,
    deadline: opp.deadline || null,
    amount_min: opp.amount_min ?? null,
    amount_max: opp.amount_max ?? null,
    description: opp.description || opp.summary || null,
    state: opp.state ?? null,
    source: opp.source ?? null,
    source_id: opp.source_id ?? null,
  }
}

async function insertSuggestion(db, row) {
  const isPostgres = db?.dialect === 'postgres'
  const id = row.id || crypto.randomUUID()
  const jsonOrNull = (v) => (v === null || v === undefined ? null : safeStringifyJSON(v, null))

  // Idempotent insert: the partial unique index uq_anya_match_suggestions_active_pair
  // prevents two PENDING rows for the same (profile, opportunity). We
  // catch the unique violation and return null so the caller treats it as
  // a skip rather than a failure.
  // A SUPPRESSED conflict is not an exception. `ON CONFLICT DO NOTHING` /
  // `INSERT OR IGNORE` never throw, so the catch below could only ever fire for
  // a DIFFERENT constraint — and `return id` ran unconditionally. The caller's
  // `if (!suggestionId) continue` guard therefore never tripped: a suppressed
  // insert was counted as `stats.created`, listed in `stats.suggestions`, and
  // handed to `insertNotification`, which wrote a user-visible notification
  // whose accept/dismiss links point at a suggestion row that does not exist.
  // The affected-row count is the only honest signal, and both drivers expose it
  // (`changes` on better-sqlite3, `rowCount` on pg).
  let result = null
  try {
    if (isPostgres) {
      result = await db
        .prepare(
          `INSERT INTO anya_match_suggestions
             (id, profile_id, user_id, opportunity_id, title, funder, match_score,
              match_reasons, need_summary, search_strategy, opportunity_data, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, 'pending', NOW())
           ON CONFLICT DO NOTHING`,
        )
        .run(
          id,
          row.profile_id,
          row.user_id || null,
          row.opportunity_id || null,
          row.title,
          row.funder || null,
          row.match_score,
          jsonOrNull(row.match_reasons),
          jsonOrNull(row.need_summary),
          jsonOrNull(row.search_strategy),
          jsonOrNull(row.opportunity_data),
        )
    } else {
      result = await db
        .prepare(
          `INSERT OR IGNORE INTO anya_match_suggestions
             (id, profile_id, user_id, opportunity_id, title, funder, match_score,
              match_reasons, need_summary, search_strategy, opportunity_data, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
        )
        .run(
          id,
          row.profile_id,
          row.user_id || null,
          row.opportunity_id || null,
          row.title,
          row.funder || null,
          row.match_score,
          jsonOrNull(row.match_reasons),
          jsonOrNull(row.need_summary),
          jsonOrNull(row.search_strategy),
          jsonOrNull(row.opportunity_data),
        )
    }
    const written = Number(result?.changes ?? result?.rowCount ?? NaN)
    // A driver that reports NO count is unknown, not zero — fall back to the
    // previous behavior rather than silently dropping every real suggestion.
    if (Number.isFinite(written) && written < 1) {
      log.debug('suggestion insert suppressed by conflict — not reporting it as created', {
        profile_id: row.profile_id,
        opportunity_id: row.opportunity_id,
      })
      return null
    }
    return id
  } catch (err) {
    // Postgres without `ON CONFLICT DO NOTHING` (or sqlite without the
    // partial index) might still raise 23505 here. Treat as a silent
    // skip — the previous pending row is still actionable.
    const msg = err?.message || String(err)
    if (/duplicate key value|UNIQUE constraint failed|already exists/i.test(msg)) {
      log.debug('suggestion already pending — skipping', {
        profile_id: row.profile_id,
        opportunity_id: row.opportunity_id,
      })
      return null
    }
    throw err
  }
}

async function insertNotification(db, { userId, suggestionId, profileId, opportunityId, title, funder, matchScore }) {
  if (!userId) return false
  const isPostgres = db?.dialect === 'postgres'
  const id = crypto.randomUUID()
  const dataPayload = {
    suggestion_id: suggestionId,
    profile_id: profileId,
    opportunity_id: opportunityId,
    match_score: matchScore,
    title,
    funder: funder || null,
    add_url: `/api/anya/match-suggestions/${suggestionId}/accept`,
    dismiss_url: `/api/anya/match-suggestions/${suggestionId}/dismiss`,
  }
  const message = `${title} has a canonical evidence score of ${Math.round(matchScore)} for this profile.${
    funder ? ` Funder: ${funder}.` : ''
  }`
  // Expires after 30 days — same window as the rest of the suggestion's
  // useful life. Past then we'd rather re-evaluate than show stale copy.
  const expiresClause = isPostgres ? "NOW() + INTERVAL '30 days'" : "datetime('now', '+30 days')"
  try {
    await db
      .prepare(
        `INSERT INTO notifications (id, user_id, type, title, message, data, read, expires_at)
         VALUES (?, ?, 'anya_high_match', ?, ?, ?, 0, ${expiresClause})`,
      )
      .run(
        id,
        String(userId),
        'Anya found a strong funding match',
        message,
        safeStringifyJSON(dataPayload, '{}'),
      )
    return true
  } catch (err) {
    log.warn('notification insert failed', {
      user_id: userId,
      suggestion_id: suggestionId,
      err: err?.message,
    })
    return false
  }
}

// ---------------------------------------------------------------------------
// Main entry: scan one profile
// ---------------------------------------------------------------------------

/**
 * Result shape:
 *   {
 *     profile_id, user_id,
 *     scanned: <int>,           // candidates considered
 *     above_threshold: <int>,   // candidates >= threshold (pre-exclusion)
 *     created: <int>,           // suggestions actually inserted
 *     notified: <int>,          // notifications created
 *     skipped_existing: <int>,  // already in pipeline
 *     skipped_dismissed: <int>, // user dismissed previously
 *     suppressed_muted: <bool>, // user has anya_match_scout_muted=true
 *     suggestions: [{ id, opportunity_id, title, match_score }]
 *   }
 */
export async function runMatchScoutForProfile(db, profileId, options = {}) {
  const threshold = options.threshold ?? getThreshold()
  const maxAlerts = options.maxAlerts ?? getMaxAlertsPerProfile()

  const stats = {
    profile_id: String(profileId),
    user_id: null,
    scanned: 0,
    above_threshold: 0,
    created: 0,
    notified: 0,
    skipped_existing: 0,
    skipped_dismissed: 0,
    suppressed_muted: false,
    // Non-null when the run stopped early because a fact it depends on could
    // not be read. A degraded run must never be indistinguishable from a clean
    // one that simply found nothing.
    degraded_reason: null,
    suggestions: [],
  }

  let profileContext = null
  try {
    profileContext = await loadProfileContext(db, profileId)
  } catch (err) {
    log.warn('skip: profile not loadable', { profile_id: profileId, err: err?.message })
    return stats
  }

  const userId = profileContext?.profile?.user_id || null
  stats.user_id = userId

  if (await isScoutMutedForUser(db, userId)) {
    stats.suppressed_muted = true
    log.info('skip: user muted scout', { profile_id: profileId, user_id: userId })
    return stats
  }

  const [candidates, pipelineIdsOrError, suppressedIdsOrError] = await Promise.all([
    loadCandidateOpportunities(db, profileContext),
    loadPipelineOpportunityIds(db, profileId),
    loadSuppressedOpportunityIds(db, profileId),
  ])
  // Both loaders return a Set on success and `{ error }` when the read failed.
  // A failed EXCLUSION read is a hard stop for this profile: proceeding would
  // re-suggest pipeline members and already-dismissed rows while the run
  // reported itself clean.
  const exclusionErrors = [pipelineIdsOrError, suppressedIdsOrError]
    .filter((v) => !(v instanceof Set))
    .map((v) => v?.error || 'unknown')
  if (exclusionErrors.length > 0) {
    stats.degraded_reason = `exclusion_load_failed: ${exclusionErrors.join('; ')}`
    log.warn('skip: exclusion sets unreadable', { profile_id: profileId, reason: stats.degraded_reason })
    return stats
  }
  const pipelineIds = pipelineIdsOrError
  const suppressedIds = suppressedIdsOrError
  stats.scanned = candidates.length

  // ── 1. Junk + trust gate (same gates Discover Grants uses) ──
  const trustKept = []
  for (const opp of candidates) {
    // Defense in depth: the SQL loader excludes quarantined rows, and this
    // blocks mock/alternate callers or a lifecycle change racing the scan.
    if (!isOpportunityLifecycleVisible(opp)) continue
    if (isJunkOpportunity(opp, {})) continue
    const trust = assessOpportunityTrust(opp, { allowDirectory: true, allowExpired: false })
    if (!trust?.display) continue
    trustKept.push({ opp, trust })
  }

  // ── 2. Canonical decision + threshold ──
  // Use computeMatchDecision (the SOLE match authority) — not the
  // non-authoritative scoreOpportunity — so the scout never surfaces or notifies
  // a user about an opportunity the engine would REJECT (Mission System 2, RC-9).
  const scored = trustKept
    .map(({ opp, trust }) => {
      const decision = computeMatchDecision(
        profileContext.profile,
        opp,
        { profileSections: profileContext.sections, signals: profileContext.signals },
      )
      return {
        opp,
        trust,
        score: decision.score,
        decision: decision.decision,
        matcherVersion: decision.matcherVersion,
        reasons: decision.reasons ?? decision.matched_profile_facts ?? [],
      }
    })
    // Never surface/notify a REJECT. The threshold remains an additional
    // surfacing floor on top of the canonical accept/review decision.
    .filter((entry) => entry.decision !== 'REJECT' && entry.score >= threshold)
    .sort((a, b) => b.score - a.score)

  stats.above_threshold = scored.length

  if (scored.length === 0) {
    log.info('no candidates above threshold', { profile_id: profileId, threshold, scanned: stats.scanned })
    return stats
  }

  // ── 3. Exclude pipeline + previously suppressed ──
  const eligible = []
  for (const entry of scored) {
    const oppId = entry.opp?.id ? String(entry.opp.id) : null
    if (oppId && pipelineIds.has(oppId)) {
      stats.skipped_existing += 1
      continue
    }
    if (oppId && suppressedIds.has(oppId)) {
      stats.skipped_dismissed += 1
      continue
    }
    eligible.push(entry)
    if (eligible.length >= maxAlerts) break
  }

  if (eligible.length === 0) {
    log.info('all above-threshold candidates were excluded', { profile_id: profileId, ...stats })
    return stats
  }

  // ── 4. Pre-compute needs once for the suggestion's `need_summary` ──
  const needs = interpretProfileNeeds({
    profile: profileContext.profile,
    sections: profileContext.sections,
  })
  const primaryNeedKeys = needs.primaryNeeds.map((n) => n.key)

  // ── 5. Write rows + notifications ──
  for (const { opp, trust, score, decision, matcherVersion, reasons } of eligible) {
    const oppSnapshot = {
      ...buildOpportunitySnapshot(opp, trust),
      match_decision: decision,
      matcher_version: matcherVersion || null,
      score_scale: SCORE_SCALE_ID,
    }
    const suggestionId = await insertSuggestion(db, {
      profile_id: String(profileId),
      user_id: userId,
      opportunity_id: opp?.id ? String(opp.id) : null,
      title: oppSnapshot.title || '(untitled)',
      funder: oppSnapshot.funder || null,
      match_score: score,
      match_reasons: Array.isArray(reasons) ? reasons.slice(0, 10) : [],
      need_summary: { primary_need_keys: primaryNeedKeys },
      search_strategy: {
        route: 'DiscoverGrants',
        candidate_source: 'funding_opportunities',
        threshold,
        match_decision: decision,
        matcher_version: matcherVersion || null,
        score_scale: SCORE_SCALE_ID,
      },
      opportunity_data: oppSnapshot,
    })

    if (!suggestionId) continue
    stats.created += 1
    stats.suggestions.push({
      id: suggestionId,
      opportunity_id: oppSnapshot.id,
      title: oppSnapshot.title,
      match_score: score,
    })

    const notified = await insertNotification(db, {
      userId,
      suggestionId,
      profileId: String(profileId),
      opportunityId: oppSnapshot.id,
      title: oppSnapshot.title,
      funder: oppSnapshot.funder,
      matchScore: score,
    })
    if (notified) stats.notified += 1
  }

  log.info('match scout complete', {
    profile_id: profileId,
    user_id: userId,
    scanned: stats.scanned,
    above_threshold: stats.above_threshold,
    created: stats.created,
    notified: stats.notified,
    skipped_existing: stats.skipped_existing,
    skipped_dismissed: stats.skipped_dismissed,
  })

  return stats
}

// ---------------------------------------------------------------------------
// Bulk: scan ALL active profiles. Called by the scheduler.
// ---------------------------------------------------------------------------

export async function runMatchScoutForAllActiveProfiles(db, options = {}) {
  const overall = {
    profiles_scanned: 0,
    profiles_with_suggestions: 0,
    suggestions_created: 0,
    notifications_created: 0,
    started_at: new Date().toISOString(),
  }

  let rows = []
  try {
    rows = await db
      .prepare("SELECT id FROM profiles WHERE status = 'active'")
      .all()
  } catch (err) {
    log.warn('active profile load failed', { err: err?.message })
    rows = []
  }

  for (const row of rows || []) {
    overall.profiles_scanned += 1
    try {
      const result = await runMatchScoutForProfile(db, row.id, options)
      if (result.created > 0) overall.profiles_with_suggestions += 1
      overall.suggestions_created += result.created
      overall.notifications_created += result.notified
    } catch (err) {
      log.warn('per-profile scout failed', { profile_id: row.id, err: err?.message })
    }
  }

  overall.completed_at = new Date().toISOString()
  log.info('match scout — all profiles complete', overall)
  return overall
}

// ---------------------------------------------------------------------------
// crawler_jobs handler: type = 'anya_match_scout'
// ---------------------------------------------------------------------------

/**
 * Signature matches the other dispatcher handlers (e.g.
 * processPipelineAutomationJob).
 *
 *   - When `job.profile_id` is set, run for that profile only.
 *   - Otherwise, run for ALL active profiles.
 */
export async function processAnyaMatchScoutJob({ db, job }) {
  const parameters = job?.parameters ?? {}
  const profileId = job?.profile_id ?? parameters?.profile_id ?? null
  const threshold = Number.isFinite(parameters?.threshold) ? parameters.threshold : undefined
  const maxAlerts = Number.isFinite(parameters?.max_alerts) ? parameters.max_alerts : undefined

  if (profileId) {
    const result = await runMatchScoutForProfile(db, String(profileId), { threshold, maxAlerts })
    return { ok: true, mode: 'single', profile_id: String(profileId), result }
  }
  const result = await runMatchScoutForAllActiveProfiles(db, { threshold, maxAlerts })
  return { ok: true, mode: 'all_active', result }
}
