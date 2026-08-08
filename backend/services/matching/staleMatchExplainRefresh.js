/**
 * staleMatchExplainRefresh.js — residue drain for linker (and any other)
 * match rows whose explain still lacks scoring_policy_version.
 *
 * Distinct from catalogRescoreSweep: this UPDATEs explain in place and KEEPS
 * matcher_version (institution-link / student-aid-instate-link / …). Routing
 * those stubs through catalog-rescore would rebrand them and lose gate provenance.
 */

import { createLogger } from '../../utils/logger.js'
import {
  buildPersistedMatchExplain,
  isStaleMatchExplain,
  staleMatchExplainSql,
} from './matchExplainPersistence.js'

const log = createLogger('stale-match-explain')

const changesOf = (res) => Number(res?.changes ?? res?.rowCount ?? 0) || 0

function envInt(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function parseExplain(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Gate provenance keys to retain from the stub when refreshing.
 * Engine explain is the base; these overlay so attendance / term / county claims survive.
 */
function gateMetaFromStub(stub) {
  const keep = {}
  for (const key of [
    'gate', 'institution', 'term', 'evidence', 'state', 'stage',
    'county', 'anchor_via', 'needs', 'source',
  ]) {
    if (stub[key] !== undefined) keep[key] = stub[key]
  }
  return keep
}

/**
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.pairBudget]
 * @param {number} [opts.timeBudgetMs]
 * @param {boolean} [opts.writeEnabled]
 * @param {object} [opts.deps]
 */
export async function runStaleMatchExplainRefresh(db, opts = {}) {
  const startedAt = Date.now()
  const pairBudget = Number.isFinite(opts.pairBudget) ? opts.pairBudget
    : envInt(process.env.STALE_MATCH_EXPLAIN_PAIR_BUDGET, 800)
  const timeBudgetMs = Number.isFinite(opts.timeBudgetMs) ? opts.timeBudgetMs
    : envInt(process.env.STALE_MATCH_EXPLAIN_TIME_BUDGET_MS, 45000)
  const writeEnabled = opts.writeEnabled !== false &&
    !/^(0|false|no|off)$/i.test(String(process.env.ENFORCE_STALE_MATCH_EXPLAIN ?? '1').trim())

  const deps = opts.deps ?? {}
  const { computeMatchDecision } = deps.computeMatchDecision
    ? { computeMatchDecision: deps.computeMatchDecision }
    : await import('../matchEngine.js')
  const { loadProfileContext } = deps.loadProfileContext
    ? { loadProfileContext: deps.loadProfileContext }
    : await import('../profileHelpers.js')

  const isPg = (db?.dialect || 'sqlite') === 'postgres'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  const stalePred = staleMatchExplainSql('m')

  const summary = {
    ok: true,
    write_enabled: writeEnabled,
    scanned: 0,
    refreshed: 0,
    would_refresh: 0,
    unscorable: 0,
    skipped_no_profile: 0,
    convergence_errors: 0,
    truncated: false,
  }

  let rows
  try {
    rows = await db.prepare(
      `SELECT m.id AS match_id, m.profile_id, m.opportunity_id, m.matcher_version,
              m.match_explain_json AS existing_explain,
              fo.id AS fo_id, fo.title, fo.sponsor, fo.description, fo.state,
              fo.is_national, fo.opportunity_kind, fo.source, fo.source_url,
              fo.application_url, fo.is_directory_resource, fo.excluded_from_grant_scoring,
              fo.profile_id AS fo_profile_id, fo.is_active
         FROM profile_opportunity_matches m
         JOIN funding_opportunities fo ON fo.id = m.opportunity_id
        WHERE ${stalePred}
          AND (fo.is_active IS NULL OR fo.is_active = ${isPg ? 'TRUE' : '1'})
        ORDER BY m.profile_id, m.opportunity_id
        LIMIT ?`,
    ).all(Math.max(pairBudget, 1))
  } catch (err) {
    log.warn('stale-match-explain candidate query failed (non-fatal)', { error: String(err?.message || err) })
    return { ...summary, ok: false, skipped: 'query' }
  }

  const ctxCache = new Map()
  for (const row of rows || []) {
    if (summary.scanned >= pairBudget || (Date.now() - startedAt) >= timeBudgetMs) {
      summary.truncated = true
      break
    }
    summary.scanned += 1
    if (!isStaleMatchExplain(row.existing_explain)) continue

    const profileId = String(row.profile_id)
    let ctx = ctxCache.get(profileId)
    if (ctx === undefined) {
      try { ctx = await loadProfileContext(db, profileId) } catch { ctx = null }
      ctxCache.set(profileId, ctx)
    }
    if (!ctx?.profile) { summary.skipped_no_profile += 1; continue }

    let decision
    try {
      decision = computeMatchDecision(ctx.profile, row, { profileSections: ctx.sections })
    } catch {
      summary.unscorable += 1
      continue
    }

    const gateMeta = gateMetaFromStub(parseExplain(row.existing_explain))
    const explain = buildPersistedMatchExplain(decision, gateMeta)
    if (!explain.scoring_policy_version) {
      // Engine did not measure a policy — leave the stub; do not invent.
      summary.unscorable += 1
      continue
    }

    if (!writeEnabled) {
      summary.would_refresh += 1
      continue
    }

    const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
    const verdict = String(decision?.decision ?? '').toLowerCase()
    try {
      const res = await db.prepare(
        `UPDATE profile_opportunity_matches
            SET match_explain_json = ?,
                match_score = COALESCE(?, match_score),
                match_decision = COALESCE(?, match_decision),
                match_explanation = COALESCE(?, match_explanation),
                updated_at = ${nowFn},
                evaluated_at = ${nowFn}
          WHERE id = ?
            AND matcher_version = ?`,
      ).run(
        JSON.stringify(explain),
        score,
        verdict || null,
        decision?.explanation ?? null,
        row.match_id,
        row.matcher_version,
      )
      if (changesOf(res) > 0) summary.refreshed += 1
    } catch (err) {
      summary.convergence_errors += 1
      log.warn('stale-match-explain update failed (non-fatal)', {
        match: row.match_id, error: String(err?.message || err),
      })
    }
  }

  summary.elapsed_ms = Date.now() - startedAt
  if (summary.convergence_errors > 0) summary.ok = false
  return summary
}

export default { runStaleMatchExplainRefresh }
