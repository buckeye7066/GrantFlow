/**
 * conditionSourceSearch.js — the adapter wishlist's CONSUMER.
 *
 * WHY THIS EXISTS. The fleet gap scoreboard correctly reports "No disease-specific
 * source lane exists for X" for real diagnoses (epilepsy, cipn, obesity,
 * hypercholesterolemia — prod 2026-07-16). That finding was right every single
 * night, and nothing ever acted on it: `amyAgent` emitted one telemetry row
 * (`amy.adapter_wishlist`, status `blocked`) and the owner was asked to add source
 * adapters by hand. A correct finding with no actor is an unpaid debt that reads
 * like diligence — the identical shape as `web_parity_gap_queue`, which nothing read
 * until 2026-07-16.
 *
 * Canonical rules this closes:
 *   - "a failure is queued work, never a shrug"
 *   - "any queue this system writes must name its consumer"
 *   - "Robert grows the official-lane surface: discovered sources feed the lane
 *      registry and RETIRE adapter-wishlist items"
 *   - the owner rule: "if a funding source is found that meets a profile's needs,
 *     add that funding source"
 *
 * WHAT IT DOES. A `no_disease_source` wishlist entry is a search waiting to happen.
 * For each one we run a bounded web search for a real patient-assistance source and
 * queue every real-looking hit onto the EXISTING `web_parity_gap_queue`, per affected
 * profile. From there the already-shipped seeding lane
 * (`loadGapSeedPagesForProfile` → `runWebDiscoveryLane opts.seedPages`) fetches,
 * LLM-extracts, reality-gates, dedupes and scores it through the canonical match
 * engine on that profile's next discovery.
 *
 * SO THIS ADDS NO INGESTION PATH AND BYPASSES NO GATE. It only removes a search's
 * failure to find. A hit is a URL, never a verdict — exactly the seeding contract.
 *
 * HONESTY (owner decision, 2026-07-16). A search that finds nothing does NOT delete
 * the wishlist entry: the entry stays and carries what was tried ("searched 6
 * queries → 0 found", then `exhausted`). "Nobody has looked yet" and "we looked and
 * there is nothing" are different facts and must not be collapsed — the same
 * remaining-vs-exhausted distinction the amount sweep needed. Never suppress a real
 * gap: a lane the registry lacks is a structural gap, never a silent miss.
 *
 * HOST. Invoked from Amy, not Robert, despite the canonical rule naming Robert:
 * `robertSourceDiscovery` is env-gated OFF by default (`ROBERT_ALLOW_LIVE_WEB` /
 * `ROBERT_ALLOW_SEARCH_ENGINE`) and terminates in Robert's own source-candidate
 * store, which feeds neither the registry nor the seed queue — wiring there would
 * ship into a dark path that lands in the wrong place. Amy already computes the
 * structural gap actions and runs daily. Robert's doctrinal role is satisfied in
 * EFFECT by the coverage overlay: an adopted source retires the wishlist entry.
 */

import { appendGapCandidates, isRealFundingHit, isOutOfStateGovHit } from '../webParityBenchmark.js'
import { conditionCoverageKey } from '../coverageEvidenceService.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:conditionSourceSearch')

/** system_kv key holding per-condition search evidence (what was tried, and when). */
export const KV_KEY = 'adapter_wishlist_search'

/** Conditions searched per run — each costs real search calls. */
export const MAX_CONDITIONS_PER_RUN = 3

/** Queries per condition. */
export const MAX_QUERIES_PER_CONDITION = 2

/** Results requested per query. */
export const MAX_RESULTS_PER_QUERY = 8

/**
 * Honest searches before a condition is declared `exhausted`.
 * Without this Amy re-searches `cipn` every night forever — the provider bill for
 * re-learning the same fact.
 */
export const MAX_ATTEMPTS = 3

/** A non-exhausted condition is not re-searched inside this window. */
export const RESEARCH_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000

/** Candidate URLs queued per condition (each becomes a fetch + LLM extract downstream). */
export const MAX_CANDIDATES_PER_CONDITION = 3

/**
 * Queries for a condition. Deliberately phrased for PATIENT-ASSISTANCE funding
 * rather than clinical information — "epilepsy" alone returns WebMD, which the
 * benchmark's noise list already knows is never a funder.
 */
export function buildConditionQueries(condition) {
  const c = String(condition || '').trim()
  if (!c) return []
  return [
    `${c} patient assistance program financial help`,
    `${c} foundation grants for patients`,
  ].slice(0, MAX_QUERIES_PER_CONDITION)
}

async function readEvidence(db) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    return row?.value ? (JSON.parse(row.value)?.conditions ?? {}) : {}
  } catch {
    return {}
  }
}

async function writeEvidence(db, conditions, at) {
  const value = JSON.stringify({ updated_at: at, conditions })
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, at, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, at)
    }
  } catch (err) {
    log.warn('condition search evidence persist failed (non-fatal)', { error: String(err?.message || err) })
  }
}

/** Read the evidence store (Anya's report annotates wishlist lines from it). */
export async function readConditionSearchEvidence(db) {
  if (!db?.prepare) return {}
  return readEvidence(db)
}

/**
 * The profile's state, for the out-of-state geo filter. Injectable so tests stay
 * offline. Best-effort: an unknown state means NO geo filtering (never invent a
 * location, and never drop a candidate on a guess).
 */
async function defaultLoadProfileState(db, profileId) {
  try {
    const { buildThesisForProfile } = await import('../crawlerOsService.js')
    const thesis = await buildThesisForProfile(db, profileId)
    return thesis?.location?.state ?? null
  } catch {
    return null
  }
}

/**
 * Is this condition due for a search?
 *
 * Never (re)searched → yes. Exhausted → no (we have our answer; the entry stays
 * visible with its evidence). Otherwise only once the cooldown has elapsed.
 */
export function isDueForSearch(record, now = new Date()) {
  if (!record) return true
  if (record.exhausted) return false
  const last = Date.parse(record.searched_at ?? '')
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= RESEARCH_COOLDOWN_MS
}

/**
 * searchForMissingConditionSources — find real sources for wishlist conditions and
 * queue them for gated adoption.
 *
 * @param {object} db
 * @param {Array<object>} wishlist scoreboard `adapter_wishlist` entries
 * @param {object} [opts] injectable: { searchWeb, now, maxConditions, appendCandidates }
 * @returns {Promise<{ran:boolean, searched:number, queued:number, exhausted:number, conditions:Array}>}
 */
export async function searchForMissingConditionSources(db, wishlist, opts = {}) {
  const {
    searchWeb,
    now = new Date(),
    maxConditions = MAX_CONDITIONS_PER_RUN,
    appendCandidates = appendGapCandidates,
    loadProfileState = defaultLoadProfileState,
  } = opts

  if (!db?.prepare) return { ran: false, reason: 'no_db', searched: 0, queued: 0, exhausted: 0, conditions: [] }
  if (typeof searchWeb !== 'function') {
    return { ran: false, reason: 'no_search_provider', searched: 0, queued: 0, exhausted: 0, conditions: [] }
  }

  const entries = (Array.isArray(wishlist) ? wishlist : [])
    // Only conditions. `matrix_uncovered_critical` entries are fleet-level and carry
    // NO affected profile ids by construction, so there is nothing to queue against.
    .filter((g) => g?.gap_class === 'no_disease_source')
    .filter((g) => String(g.detail || '').trim())
    // No profile ids = nothing to seed. Rather than silently queue nothing (the
    // failure this consumer was nearly born with), skip and say so.
    .filter((g) => Array.isArray(g.affected_profiles) && g.affected_profiles.length > 0)

  const evidence = await readEvidence(db)
  const at = (now instanceof Date ? now : new Date(now)).toISOString()

  const due = entries.filter((g) => isDueForSearch(evidence[conditionCoverageKey(g.detail)], now))
  const batch = due.slice(0, Math.max(0, maxConditions))

  const report = []
  let queuedTotal = 0
  let exhaustedTotal = 0
  let skippedOutOfState = 0
  // One state lookup per profile per run, not per hit.
  const stateCache = new Map()
  const stateFor = async (profileId) => {
    if (stateCache.has(profileId)) return stateCache.get(profileId)
    const st = await loadProfileState(db, profileId).catch(() => null)
    stateCache.set(profileId, st)
    return st
  }

  for (const gap of batch) {
    const condition = String(gap.detail).trim()
    const key = conditionCoverageKey(condition)
    const prior = evidence[key] ?? {}
    const attempts = Number(prior.attempts ?? 0) + 1

    const queries = buildConditionQueries(condition)
    const hits = []
    let searchFailed = 0
    for (const q of queries) {
      try {
        const results = await searchWeb(q, { count: MAX_RESULTS_PER_QUERY })
        for (const h of Array.isArray(results) ? results : []) {
          if (isRealFundingHit(h)) hits.push(h)
        }
      } catch (err) {
        searchFailed += 1
        log.warn('condition source search failed (non-fatal)', { condition, error: String(err?.message || err) })
      }
    }

    // A provider outage is NOT evidence that no source exists — do not spend an
    // attempt on it, or an outage would permanently exhaust a real condition.
    // (Same rule the URL-rescue cursor follows.)
    const providerOutage = searchFailed === queries.length && queries.length > 0
    if (providerOutage) {
      report.push({ condition, searched: false, reason: 'search_provider_unavailable' })
      continue
    }

    const deduped = []
    const seen = new Set()
    for (const h of hits) {
      const u = String(h.url || '').trim()
      if (!u || seen.has(u)) continue
      seen.add(u)
      deduped.push(h)
      if (deduped.length >= MAX_CANDIDATES_PER_CONDITION) break
    }

    // Queue per affected profile — the seeding lane is profile-scoped, and the full
    // gate stack decides whether any of this becomes a real source for that profile.
    //
    // GEO FILTER, per profile. A "<condition> patient assistance" search reliably
    // surfaces the biggest state's portals: searching "medical debt" for a profile
    // in Cleveland, TENNESSEE queued California's Medi-Cal and BenefitsCal (prod,
    // 2026-07-16). The benchmark already learned this exact lesson — those two
    // domains are named in `isOutOfStateGovHit` because they cratered the parity
    // score against a TN profile on 2026-07-12 — and this consumer reused
    // `isRealFundingHit` from the same module while walking past the filter next
    // to it. GrantFlow is RIGHT not to surface Medi-Cal in Tennessee.
    //
    // The downstream geo gate would reject these anyway, so this is not a
    // correctness hole — but every one costs a fetch + an LLM extract and occupies
    // a slot in a bounded queue, which is how a real candidate gets crowded out.
    // Filter per PROFILE (not per condition): the same hit can be in-scope for one
    // affected profile and out-of-scope for another.
    const candidates = []
    for (const profileId of gap.affected_profiles) {
      const state = await stateFor(profileId)
      for (const h of deduped) {
        // Unknown state ⇒ no filtering: never drop a candidate on a guess.
        if (state && isOutOfStateGovHit(h.url, state)) {
          skippedOutOfState += 1
          continue
        }
        candidates.push({
          url: h.url,
          title: h.title ?? null,
          profile_id: profileId,
          need: condition,
          source: 'condition_source_search',
        })
      }
    }
    let appended = 0
    if (candidates.length) {
      try {
        const res = await appendCandidates(db, candidates, { now })
        appended = Number(res?.appended ?? 0)
      } catch (err) {
        log.warn('queueing condition candidates failed (non-fatal)', { condition, error: String(err?.message || err) })
      }
    }
    queuedTotal += appended

    // Exhausted = we have SEARCHED our budget and found nothing real FOR THESE
    // PROFILES. `appended === 0` (not `deduped.length === 0`) is the honest test:
    // hits that all got geo-filtered mean this condition yielded nothing usable
    // here, which is the same answer as finding nothing. The wishlist entry stays;
    // it just stops being re-searched and starts telling the truth about why it is
    // still open.
    const exhausted = appended === 0 && attempts >= MAX_ATTEMPTS
    if (exhausted) exhaustedTotal += 1

    evidence[key] = {
      condition,
      searched_at: at,
      attempts,
      queries_run: queries.length,
      real_hits: deduped.length,
      candidates_queued: appended,
      exhausted,
    }
    report.push({ condition, searched: true, real_hits: deduped.length, candidates_queued: appended, attempts, exhausted })
  }

  if (skippedOutOfState > 0) {
    // Visible, not silent: a filter that drops candidates without saying so is
    // indistinguishable from a search that found nothing.
    log.info('condition search: skipped out-of-state government portals', { skipped: skippedOutOfState })
  }

  if (report.length) await writeEvidence(db, evidence, at)

  return {
    ran: true,
    searched: report.filter((r) => r.searched).length,
    queued: queuedTotal,
    exhausted: exhaustedTotal,
    skipped_no_profiles: entries.length - due.length >= 0 ? (Array.isArray(wishlist) ? wishlist : []).filter(
      (g) => g?.gap_class === 'no_disease_source' && !(Array.isArray(g.affected_profiles) && g.affected_profiles.length),
    ).length : 0,
    conditions: report,
  }
}

export default {
  KV_KEY,
  MAX_CONDITIONS_PER_RUN,
  MAX_ATTEMPTS,
  RESEARCH_COOLDOWN_MS,
  buildConditionQueries,
  isDueForSearch,
  readConditionSearchEvidence,
  searchForMissingConditionSources,
}
