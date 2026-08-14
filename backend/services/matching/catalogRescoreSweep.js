/**
 * catalogRescoreSweep.js — CONTINUOUS CATALOG-WIDE RE-MATCHING (the general
 * re-scoring sweep CLAUDE.md has carried as "STILL OPEN WORK").
 *
 * ── THE HOLE, measured read-only in prod 2026-08-03T16:49Z ──────────────────
 * Of 11,050 ACTIVE non-pointer catalog rows, **641 (5.8%) have EVER carried a
 * match row for ANY profile**. Each golden profile has ~10,930+ active
 * non-pointer rows the engine has never been asked about — because
 * `profile_opportunity_matches` is a ROLLING SNAPSHOT (`persistRun` deletes a
 * profile's crawler-os rows every run and re-inserts only what THAT run
 * re-found), and the keyed recall nets (institution / field-of-study /
 * in-state aid / county-crisis) reach only the slices their keys name. The
 * engine is willing every time a pair is replayed (HOPE ACCEPT 100, Love INC
 * ACCEPT 100, AFTE ACCEPT 83); the pair is simply never put in front of it.
 *
 * Every ScholarshipOwl/Fastweb/Instrumentl-class competitor runs this loop as
 * its core product: the profile is STANDING, and new inventory is pushed
 * through it continuously — matching is a cheap repeated join, not a
 * crawl-on-demand event. This sweep is that loop, GrantFlow-style: the
 * canonical engine stays the SOLE authority, and this module only decides
 * WHICH pairs get put in front of it, bounded per run, resumable via a cursor.
 *
 * ── WHY WRITES DEFAULT ON (after the junk chain landed) ─────────────────────
 * A blind engine-adjudication of a 2,500-row sample once ACCEPTed 13.3–20.2%
 * including junk (embassy notices, federal-register). That is why writes
 * shipped OFF. The shared fundability choke point now consumes
 * `fundingResultFilters.isFundableOpportunity` + proposal-eligible kinds
 * (`passesFundabilityGate`) — the fix/qa-36-profile-junk chain. With that
 * gate live, leaving writes OFF forever is the write-only-queue anti-pattern:
 * the census reports `wouldLink` every boot while profiles stay empty.
 *
 * Default ON. `ENFORCE_CATALOG_RESCORE=0` (or false/off/no) for count-only —
 * the same convention as the older sweeps.
 *
 * ── RULES HONORED ───────────────────────────────────────────────────────────
 * - ACCEPT-ONLY visible truth (REVIEW/REJECT remove this sweep's stale ACCEPT).
 * - matcher_version 'catalog-rescore-link' (SURFACED_MATCHER_VERSIONS carries
 *   it; the reconcile DELETE names only crawler-os/crawler-os-xmatch, so these
 *   rows survive the rolling snapshot until the next canonical rescore).
 * - Every active non-pointer pair is revisited in repeating bounded cycles.
 *   Existing rows are not excluded: current policy must be able to replace an
 *   old score/version or withdraw a stale ACCEPT.
 * - Pointer kinds are refused before the engine is called (the county-crisis
 *   posture: a directory is a pointer, never an award).
 * - Amy synthetic profiles and unconfigured profiles are skipped.
 * - Cursor state is persisted ONLY when writes are enabled: a count-only boot
 *   is a stateless census, so enabling writes later starts from the beginning
 *   instead of skipping everything the census already walked past (the
 *   "green while doing nothing" class).
 * - ACCEPT upserts the complete current canonical result. The sweep provenance
 *   remains in matcher_version; engine/score/policy versions live in the full
 *   match_explain_json because the table has no dedicated scale/policy columns.
 */

import { isProposalEligibleOpportunity } from '../../../shared/opportunityFundability.js'
import { isFundableOpportunity } from '../../config/fundingResultFilters.js'
import { SCORE_SCALE_ID } from '../../config/matchThresholds.js'
import { createLogger } from '../../utils/logger.js'
import { NEED_FIRST_SCORING_VERSION } from './needFirstScoringAdapter.js'

const log = createLogger('catalog-rescore')

export const CATALOG_RESCORE_MATCHER_VERSION = 'catalog-rescore-link'
export const CATALOG_RESCORE_KV_KEY = 'catalog_rescore_cursor'

/** Rows fetched per DB round-trip (not a work bound — the budgets are). */
const BATCH_SIZE = 200

const changesOf = (res) => Number(res?.changes ?? res?.rowCount ?? 0) || 0

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function json(value, fallback) {
  try { return JSON.stringify(value) } catch { return JSON.stringify(fallback) }
}

function parseExplainJson(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Early catalog-rescore writes persisted a stub
 * `{"gate":"catalog_rescore"}` with no score-scale / policy provenance.
 * Funding-sources then reports those rows as scoring_policy_unknown, so the
 * owner-facing receipt cannot prove scores match the current scale even when
 * the numeric score is correct. Detect that residue so the sweep prioritizes
 * refreshing it with a full canonicalExplain (and never invents a policy
 * stamp without re-running the engine).
 */
export function isStaleCatalogRescoreExplain(raw) {
  const explain = parseExplainJson(raw)
  if (!explain) return true
  const policy = String(
    explain.scoring_policy_version ??
    explain.scoreBreakdown?.scoring_policy_version ??
    explain.score_breakdown?.scoring_policy_version ??
    '',
  ).trim()
  if (!policy) return true
  // The original stub had only `{ gate: 'catalog_rescore' }`. A refreshed
  // explain always carries scoring_policy_version + catalog_rescore metadata.
  if (
    Object.keys(explain).length === 1 &&
    String(explain.gate || '') === 'catalog_rescore'
  ) {
    return true
  }
  return false
}

/**
 * SQL predicate (no leading AND) for catalog-rescore rows whose explain still
 * lacks a usable scoring_policy_version. Shared by the drain query and the
 * profile-priority census so the two cannot drift.
 */
export function staleCatalogRescoreExplainSql(alias = 'm') {
  const col = `${alias}.match_explain_json`
  return `(
    ${col} IS NULL
    OR ${col} NOT LIKE '%scoring_policy_version%'
    OR ${col} LIKE '%"scoring_policy_version": null%'
    OR ${col} LIKE '%"scoring_policy_version":null%'
    OR ${col} LIKE '%"scoring_policy_version": ""%'
    OR ${col} LIKE '%"scoring_policy_version":""%'
  )`
}

function canonicalExplain(decision, evaluatedAt) {
  const explain = asObject(decision?.match_explain)
  const breakdown = asObject(explain.scoreBreakdown ?? explain.score_breakdown)
  const scoreScaleId = decision?.scoreScaleId ?? explain.score_scale_id ?? SCORE_SCALE_ID
  const scoringPolicyVersion = decision?.scoringPolicyVersion ??
    explain.scoring_policy_version ??
    breakdown.scoring_policy_version ??
    NEED_FIRST_SCORING_VERSION
  const engineMatcherVersion = decision?.matcherVersion ?? explain.matcher_version ?? null

  return {
    ...explain,
    score_scale_id: scoreScaleId,
    scoring_policy_version: scoringPolicyVersion,
    matcher_version: engineMatcherVersion,
    catalog_rescore: {
      ...asObject(explain.catalog_rescore),
      persistence_version: CATALOG_RESCORE_MATCHER_VERSION,
      evaluated_at: decision?.evaluatedAt ?? evaluatedAt,
    },
  }
}

function envInt(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Writes DEFAULT ON once the fundability gate is wired. Opt out with
 * `ENFORCE_CATALOG_RESCORE=0` (or false/off/no) for a count-only census.
 */
export function isCatalogRescoreWriteEnabled(env = process.env) {
  const raw = String(env.ENFORCE_CATALOG_RESCORE ?? '1').trim()
  if (raw === '') return true
  return !/^(0|false|no|off)$/i.test(raw)
}

/**
 * THE FUNDABILITY CHOKE POINT. Every candidate passes here BEFORE the engine
 * is consulted. It consumes BOTH shared chains — one hook, not scattered
 * call-site checks:
 *   - `shared/opportunityFundability.js` (kind classes: never a proposal
 *     surface for DIRECTORY/BENEFIT-as-proposal/PAST_AWARD_INTEL legacy rows),
 *   - `config/fundingResultFilters.classifyFundingResult` (#1133, the
 *     fix/qa-36-profile-junk chain): regulatory/lead-gen/clearly-expired/
 *     anonymized-funder junk and signal-less rows never reach the engine.
 *     This is exactly the class the 2026-08-03 flood dry-run measured in the
 *     blind ACCEPT set (federal-register notices, embassy program rows).
 *
 * Both modules are loaded once at module initialization. This function runs on
 * every candidate row, so per-row dynamic imports would add thousands of
 * unnecessary promises to each boot census.
 */
export function passesFundabilityGate(opp) {
  return isProposalEligibleOpportunity(opp) && isFundableOpportunity(opp)
}

async function kvSet(db, key, value) {
  const now = new Date().toISOString()
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
  const updated = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(stringValue, now, key)
  if (!changesOf(updated)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, stringValue, now)
  }
}

async function kvGetJson(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key)
    if (!row?.value) return null
    return JSON.parse(row.value)
  } catch { return null }
}

/**
 * runCatalogRescoreSweep — one bounded, resumable pass.
 *
 * @param {object} db  the app DB shim (prepare().all/get/run)
 * @param {object} [opts]
 *   pairBudget    — max engine adjudications this pass (CATALOG_RESCORE_PAIR_BUDGET, 3000)
 *   timeBudgetMs  — wall-clock bound (CATALOG_RESCORE_TIME_BUDGET_MS, 20000)
 *   writeEnabled  — override the env switch (tests)
 *   deps          — { computeMatchDecision, loadProfileContext, assessProfileConfiguration } overrides (tests)
 */
export async function runCatalogRescoreSweep(db, opts = {}) {
  const startedAt = Date.now()
  const pairBudget = Number.isFinite(opts.pairBudget) ? opts.pairBudget
    : envInt(process.env.CATALOG_RESCORE_PAIR_BUDGET, 3000)
  let timeBudgetMs = Number.isFinite(opts.timeBudgetMs) ? opts.timeBudgetMs
    : envInt(process.env.CATALOG_RESCORE_TIME_BUDGET_MS, 20000)
  const writeEnabled = typeof opts.writeEnabled === 'boolean' ? opts.writeEnabled : isCatalogRescoreWriteEnabled()
  // When the fleet still carries stub explains, inventory walks compete with
  // provenance refresh under the 20s boot budget (prod 2026-08-08: 2754 stubs
  // still open after #1184). Prefer drain; optionally raise the wall clock.
  const explainDrainTimeBudgetMs = Number.isFinite(opts.explainDrainTimeBudgetMs)
    ? opts.explainDrainTimeBudgetMs
    : envInt(process.env.CATALOG_RESCORE_EXPLAIN_TIME_BUDGET_MS, 90000)

  const deps = opts.deps ?? {}
  const { computeMatchDecision } = deps.computeMatchDecision
    ? { computeMatchDecision: deps.computeMatchDecision }
    : await import('../matchEngine.js')
  const { loadProfileContext } = deps.loadProfileContext
    ? { loadProfileContext: deps.loadProfileContext }
    : await import('../profileHelpers.js')
  const { assessProfileConfiguration } = deps.assessProfileConfiguration
    ? { assessProfileConfiguration: deps.assessProfileConfiguration }
    : await import('../profile/profileConfiguration.js')
  const { pointerKindSql } = await import('../../config/opportunityKindClasses.js')

  const isPg = (db?.dialect || 'sqlite') === 'postgres'
  const trueLit = isPg ? 'TRUE' : '1'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  const pointerPredicate = pointerKindSql('fo.opportunity_kind')
  const notPointer = `NOT (${pointerPredicate})`

  const summary = {
    ok: true,
    write_enabled: writeEnabled,
    profiles_considered: 0,
    profiles_skipped_synthetic: 0,
    profiles_skipped_unconfigured: 0,
    profiles_completed: 0,
    scanned: 0,
    not_fundable: 0,
    adjudicated: 0,
    linked: 0,
    updated: 0,
    upserted: 0,
    would_link: 0,
    would_update: 0,
    would_remove: 0,
    review: 0,
    rejected_by_engine: 0,
    unscorable: 0,
    stale_removed: 0,
    explain_refreshed: 0,
    foreign_lane_skipped: 0,
    stale_explain_prioritized: 0,
    stale_explains_at_start: 0,
    inventory_paused_for_explain_drain: false,
    convergence_errors: 0,
    cycles_reopened: 0,
    truncated: false,
    examples: [],
  }

  let profiles
  try {
    profiles = await db.prepare(
      `SELECT id, created_by FROM profiles
        WHERE (status IS NULL OR status = 'active')
        ORDER BY created_at, id`,
    ).all()
  } catch {
    try {
      profiles = await db.prepare(
        `SELECT id, NULL AS created_by FROM profiles
          WHERE (status IS NULL OR status = 'active')
          ORDER BY id`,
      ).all()
    } catch (err) {
      log.warn('profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { ...summary, ok: false, skipped: 'query' }
    }
  }

  const cursor = (writeEnabled ? await kvGetJson(db, CATALOG_RESCORE_KV_KEY) : null) ?? { profiles: {}, last_profile: null }
  if (!cursor.profiles || typeof cursor.profiles !== 'object') cursor.profiles = {}

  const staleExplainPred = staleCatalogRescoreExplainSql('m')
  let staleExplainProfileIds = new Set()
  try {
    // Only consider stub-explain rows that are actually reachable by the
    // per-profile drain query: on ACTIVE, NON-POINTER opportunities and for
    // ACTIVE, non-synthetic profiles. This prevents a global pause being held
    // open by stale rows we would never process in the drain.
    const staleRows = await db.prepare(
      `SELECT DISTINCT m.profile_id AS profile_id
         FROM profile_opportunity_matches m
         JOIN funding_opportunities fo ON fo.id = m.opportunity_id
         JOIN profiles p ON p.id = m.profile_id
        WHERE m.matcher_version = '${CATALOG_RESCORE_MATCHER_VERSION}'
          AND ${staleExplainPred}
          AND (fo.is_active IS NULL OR fo.is_active = ${trueLit})
          AND ${notPointer}
          AND (p.status IS NULL OR p.status = 'active')
          AND (p.created_by IS NULL OR p.created_by <> 'agent:amy')`,
    ).all()
    for (const row of staleRows || []) {
      if (row?.profile_id) staleExplainProfileIds.add(String(row.profile_id))
    }
    summary.stale_explains_at_start = staleExplainProfileIds.size
  } catch (err) {
    log.warn('stale-explain profile census failed (non-fatal)', { error: String(err?.message || err) })
  }
  // Further narrow the pause gate to profiles this sweep will actually process:
  // unconfigured profiles are skipped in the main loop, so they must not hold
  // a global inventory pause open. We cheaply intersect against the active
  // profile list, then exclude unconfigured ones via assessProfileConfiguration.
  if (staleExplainProfileIds.size > 0) {
    const staleIds = [...staleExplainProfileIds]
    const activeById = new Map((profiles || []).map((p) => [String(p.id), p]))
    const eligible = new Set()
    for (const id of staleIds) {
      const p = activeById.get(id)
      if (!p) continue
      try {
        const ctx = await loadProfileContext(db, id)
        const conf = assessProfileConfiguration(ctx)
        if (!conf?.unconfigured) eligible.add(id)
      } catch {
        // A readable failure must not block the fleet — treat as eligible so
        // the drain still attempts this profile rather than pausing others.
        eligible.add(id)
      }
    }
    staleExplainProfileIds = eligible
  }
  // Pause catalog inventory until every eligible profile's stub explains are
  // drained. Inventory growth under a tight boot budget was starving
  // provenance refresh; this pause now applies only when there is at least one
  // eligible profile to drain.
  const pauseInventoryForExplainDrain = staleExplainProfileIds.size > 0 && opts.pauseInventoryForExplainDrain !== false
  summary.inventory_paused_for_explain_drain = pauseInventoryForExplainDrain
  if (pauseInventoryForExplainDrain) {
    timeBudgetMs = Math.max(timeBudgetMs, explainDrainTimeBudgetMs)
  }

  let ordered = [...(profiles || [])]
  if (pauseInventoryForExplainDrain) {
    const staleFirst = []
    const rest = []
    for (const p of ordered) {
      (staleExplainProfileIds.has(String(p.id)) ? staleFirst : rest).push(p)
    }
    // Rotate only within the stale cohort so a stuck inventory cursor cannot
    // keep pushing stub-bearing profiles to the back of the queue.
    if (cursor.last_profile) {
      const i = staleFirst.findIndex((p) => String(p.id) === String(cursor.last_profile))
      if (i >= 0) staleFirst.push(...staleFirst.splice(0, i + 1))
    }
    ordered = [...staleFirst, ...rest]
  } else if (cursor.last_profile) {
    const i = ordered.findIndex((p) => String(p.id) === String(cursor.last_profile))
    if (i >= 0) ordered.push(...ordered.splice(0, i + 1))
  }

  const spent = () => summary.adjudicated + summary.not_fundable
  const outOfBudget = () => spent() >= pairBudget || (Date.now() - startedAt) >= timeBudgetMs

  for (const p of ordered) {
    if (outOfBudget()) { summary.truncated = true; break }
    const profileId = String(p.id)
    if (String(p.created_by ?? '') === 'agent:amy') { summary.profiles_skipped_synthetic += 1; continue }
    if (pauseInventoryForExplainDrain && !staleExplainProfileIds.has(profileId)) {
      // No stub explains on this profile — leave it for a later inventory pass.
      continue
    }

    let ctx
    try { ctx = await loadProfileContext(db, profileId) } catch { ctx = null }
    if (!ctx?.profile) continue
    try {
      const conf = assessProfileConfiguration(ctx)
      if (conf?.unconfigured) { summary.profiles_skipped_unconfigured += 1; continue }
    } catch { /* an unreadable verdict never blocks a real profile */ }

    summary.profiles_considered += 1
    const entry = cursor.profiles[profileId] ?? {}
    const reopeningCompletedCycle = Boolean(entry.completed_at)
    if (reopeningCompletedCycle) summary.cycles_reopened += 1
    const previousCycle = Number.isFinite(Number(entry.cycle)) ? Number(entry.cycle) : 0
    const cycle = Math.max(1, previousCycle + (reopeningCompletedCycle ? 1 : 0))
    let watermark = reopeningCompletedCycle ? null : (entry.watermark ?? null)
    // Drain stale catalog-rescore explains BEFORE the inventory walk, and do
    // NOT apply the inventory id watermark to that drain. A CASE-reorder on
    // the inventory query + `fo.id > watermark` would permanently skip lower-id
    // stubs once the cursor advanced past them (item 43 residue / #944 class).
    let staleExplainDrainDone = false
    let explainWatermark = null
    let profileDone = false
    while (!profileDone && !outOfBudget()) {
      const remaining = Math.max(1, Math.min(BATCH_SIZE, pairBudget - spent()))
      let rows
      try {
        if (!staleExplainDrainDone) {
          const whereExplainMark = explainWatermark ? 'AND fo.id > ?' : ''
          const explainParams = explainWatermark ? [explainWatermark.id] : []
          rows = await db.prepare(
            `SELECT fo.*,
                    m.id AS existing_match_id,
                    m.matcher_version AS existing_matcher_version,
                    m.match_decision AS existing_match_decision,
                    m.match_explain_json AS existing_match_explain_json
               FROM profile_opportunity_matches m
               JOIN funding_opportunities fo ON fo.id = m.opportunity_id
              WHERE m.profile_id = ?
                AND m.matcher_version = '${CATALOG_RESCORE_MATCHER_VERSION}'
                AND ${staleExplainPred}
                AND (fo.is_active IS NULL OR fo.is_active = ${trueLit})
                AND ${notPointer}
                ${whereExplainMark}
              ORDER BY fo.id
              LIMIT ?`,
          ).all(profileId, ...explainParams, remaining)
          if (!rows || rows.length === 0) {
            staleExplainDrainDone = true
            continue
          }
        } else if (pauseInventoryForExplainDrain) {
          // Profile's stub explains are drained. Do not resume fo.id inventory
          // while any other profile still needs provenance refresh.
          profileDone = false
          break
        } else {
          // ID ordering is deliberately independent of created_at. Legacy rows
          // may have NULL timestamps; a timestamp watermark would make every
          // later NULL row unreachable after the first batch. Repeating cycles
          // pick up any newly inserted lower-sorting id on the next pass.
          const whereMark = watermark ? 'AND fo.id > ?' : ''
          const params = watermark ? [watermark.id] : []
          rows = await db.prepare(
            `SELECT fo.*,
                    m.id AS existing_match_id,
                    m.matcher_version AS existing_matcher_version,
                    m.match_decision AS existing_match_decision,
                    m.match_explain_json AS existing_match_explain_json
               FROM funding_opportunities fo
          LEFT JOIN profile_opportunity_matches m
                 ON m.profile_id = ? AND m.opportunity_id = fo.id
              WHERE (fo.is_active IS NULL OR fo.is_active = ${trueLit})
                AND ${notPointer}
                ${whereMark}
              ORDER BY fo.id
              LIMIT ?`,
          ).all(profileId, ...params, remaining)
        }
      } catch (err) {
        log.warn('candidate query failed (non-fatal)', { profile: profileId, error: String(err?.message || err) })
        summary.convergence_errors += 1
        break
      }

      for (const opp of rows || []) {
        summary.scanned += 1
        if (staleExplainDrainDone) watermark = { id: opp.id }
        else explainWatermark = { id: opp.id }
        const staleCatalogAccept = String(opp.existing_matcher_version ?? '') === CATALOG_RESCORE_MATCHER_VERSION
        const staleExplain = staleCatalogAccept && isStaleCatalogRescoreExplain(opp.existing_match_explain_json)
        if (staleExplain) summary.stale_explain_prioritized += 1
        const withdrawStaleCatalogAccept = async () => {
          if (!staleCatalogAccept) return 0
          if (!writeEnabled) {
            summary.would_remove += 1
            return 0
          }
          const res = await db.prepare(
            `DELETE FROM profile_opportunity_matches
              WHERE profile_id = ? AND opportunity_id = ? AND matcher_version = ?`,
          ).run(profileId, opp.id, CATALOG_RESCORE_MATCHER_VERSION)
          const removed = changesOf(res)
          summary.stale_removed += removed
          return removed
        }

        if (!passesFundabilityGate(opp)) {
          summary.not_fundable += 1
          try { await withdrawStaleCatalogAccept() } catch { summary.convergence_errors += 1 }
          continue
        }
        let decision
        try { decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections }) }
        catch { summary.unscorable += 1; summary.adjudicated += 1; continue }
        summary.adjudicated += 1
        const verdict = String(decision?.decision ?? '').toUpperCase()
        if (verdict === 'REVIEW') {
          summary.review += 1
          try { await withdrawStaleCatalogAccept() } catch { summary.convergence_errors += 1 }
          continue
        }
        if (verdict !== 'ACCEPT') {
          summary.rejected_by_engine += 1
          try { await withdrawStaleCatalogAccept() } catch { summary.convergence_errors += 1 }
          continue
        }
        const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
        if (score === null) {
          summary.unscorable += 1
          try { await withdrawStaleCatalogAccept() } catch { summary.convergence_errors += 1 }
          continue
        }

        if (!writeEnabled) {
          if (opp.existing_match_id) summary.would_update += 1
          else summary.would_link += 1
          if (summary.examples.length < 5) summary.examples.push(`${opp.title} (ACCEPT ${score})`)
          continue
        }
        try {
          const evaluatedAt = new Date().toISOString()
          const confidence = Number.isFinite(Number(decision?.confidence)) ? Number(decision.confidence) : null
          const reasons = Array.isArray(decision?.reasons)
            ? decision.reasons
            : (Array.isArray(decision?.matchedNeeds) ? decision.matchedNeeds : [])
          const explain = canonicalExplain(decision, evaluatedAt)
          // A row that ALREADY exists under a DIFFERENT lane (institution-link,
          // county-crisis-need-link, crawler-os, ...) is not this sweep's to
          // rebrand — see staleMatchExplainRefresh.js's header comment for the
          // invariant: routing another lane's stub through catalog-rescore
          // rebrands it and strips its gate provenance, making it unreachable
          // to its own lane's withdrawal sweep.
          const conflictsWithOtherLane = Boolean(opp.existing_match_id) &&
            String(opp.existing_matcher_version ?? '') !== CATALOG_RESCORE_MATCHER_VERSION
          const res = await db.prepare(
            `INSERT INTO profile_opportunity_matches
               (id, profile_id, opportunity_id, match_score, match_confidence, match_decision, match_explanation,
                match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                computed_at, updated_at, evaluated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${CATALOG_RESCORE_MATCHER_VERSION}', ${nowFn}, ${nowFn}, ?)
             ON CONFLICT (profile_id, opportunity_id) DO UPDATE SET
               match_score = excluded.match_score,
               match_confidence = excluded.match_confidence,
               match_decision = excluded.match_decision,
               match_explanation = excluded.match_explanation,
               match_reasons = excluded.match_reasons,
               match_explain_json = excluded.match_explain_json,
               matcher_version = excluded.matcher_version,
               computed_at = excluded.computed_at,
               updated_at = excluded.updated_at,
               evaluated_at = excluded.evaluated_at
             WHERE profile_opportunity_matches.matcher_version = '${CATALOG_RESCORE_MATCHER_VERSION}'`,
          ).run(
            `cr:${profileId}:${opp.id}`, profileId, opp.id, score,
            confidence,
            'accept',
            decision?.explanation ?? null,
            json(reasons, []),
            json(explain, {
              score_scale_id: SCORE_SCALE_ID,
              scoring_policy_version: NEED_FIRST_SCORING_VERSION,
              matcher_version: decision?.matcherVersion ?? null,
            }),
            null, 'catalog_rescore', decision?.evaluatedAt ?? evaluatedAt,
          )
          if (changesOf(res) > 0) {
            summary.upserted += 1
            if (opp.existing_match_id) summary.updated += 1
            else summary.linked += 1
            if (staleExplain) summary.explain_refreshed += 1
            if (summary.examples.length < 5) summary.examples.push(`${opp.title} (ACCEPT ${score})`)
          } else if (conflictsWithOtherLane) {
            summary.foreign_lane_skipped += 1
          }
        } catch (err) {
          log.warn('insert failed (non-fatal)', { profile: profileId, opportunity: opp.id, error: String(err?.message || err) })
          summary.convergence_errors += 1
        }
        if (outOfBudget()) break
      }

      if (!staleExplainDrainDone) {
        // Explain drain finished this batch short → move to inventory. Never
        // mark the profile complete from the drain alone.
        if (!rows || rows.length < remaining) staleExplainDrainDone = true
        continue
      }
      if (!rows || rows.length < remaining) profileDone = !outOfBudget()
      if (!rows || rows.length === 0) break
    }

    if (writeEnabled) {
      cursor.profiles[profileId] = profileDone
        ? { cycle, completed_at: new Date().toISOString() }
        : { cycle, ...(watermark ? { watermark } : {}) }
      cursor.last_profile = profileId
    }
    if (profileDone) summary.profiles_completed += 1
  }
  if (outOfBudget() && !summary.truncated) {
    // Both bounds are truncation. A time-limited pass that happened to finish
    // the last profile in the list is still incomplete and must not report a
    // full sweep merely because the pair counter remained below its ceiling.
    summary.truncated = true
  }

  if (writeEnabled) {
    try {
      const doomed = await db.prepare(
        `SELECT m.id FROM profile_opportunity_matches m
          LEFT JOIN funding_opportunities fo ON fo.id = m.opportunity_id
         WHERE m.matcher_version = '${CATALOG_RESCORE_MATCHER_VERSION}'
           AND (
             fo.id IS NULL
             OR (fo.is_active IS NOT NULL AND fo.is_active <> ${trueLit})
             OR ${pointerPredicate}
           )
         LIMIT 500`,
      ).all()
      for (let i = 0; i < (doomed?.length ?? 0); i += 200) {
        const slice = doomed.slice(i, i + 200).map((r) => r.id)
        const ph = slice.map(() => '?').join(', ')
        const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
        summary.stale_removed += changesOf(res)
      }
    } catch { summary.convergence_errors += 1 }
    try { await kvSet(db, CATALOG_RESCORE_KV_KEY, cursor) } catch { summary.convergence_errors += 1 }
  }

  summary.elapsed_ms = Date.now() - startedAt
  if (summary.convergence_errors > 0) summary.ok = false
  if (!writeEnabled && (summary.would_link > 0 || summary.would_update > 0 || summary.would_remove > 0)) {
    log.info('catalog rescore census: writes DISABLED (ENFORCE_CATALOG_RESCORE=0) — convergence waiting', {
      would_link: summary.would_link,
      would_update: summary.would_update,
      would_remove: summary.would_remove,
      adjudicated: summary.adjudicated,
      examples: summary.examples,
    })
  }
  return summary
}

export default {
  CATALOG_RESCORE_MATCHER_VERSION,
  CATALOG_RESCORE_KV_KEY,
  isCatalogRescoreWriteEnabled,
  isStaleCatalogRescoreExplain,
  staleCatalogRescoreExplainSql,
  passesFundabilityGate,
  runCatalogRescoreSweep,
}
