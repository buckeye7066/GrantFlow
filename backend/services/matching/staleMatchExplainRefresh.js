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
import {
  fundingTruthProofFrom,
  refreshFourTruthProof,
  failedFourTruths,
  hasPositiveFourTruthProof,
} from '../../config/fundingTruthPolicy.js'
import { isFundingResource } from './fundingSourcePresentation.js'

const log = createLogger('stale-match-explain')

/** Lanes whose rows crawler-os authored: the four-truth gate is theirs. */
const CRAWLER_OS_LANES = new Set(['crawler-os', 'crawler-os-xmatch'])

/**
 * `needs_defaulted` is a thesis-level fact (crawler-os profileIntelligence):
 * true when the profile declared no readable need and the set is a type-shaped
 * guess. It is the one proof input that is neither on the row nor in the
 * canonical decision, so it is derived once per profile from the same thesis
 * builder crawl uses. Loaded lazily: the drain runs at boot and must not pull
 * the crawler-os thesis builder into module load for the count-only path.
 */
async function thesisNeedsDefaulted(ctx) {
  const [{ buildThesis }, { profileContextToThesisInput }] = await Promise.all([
    import('../../crawler-os/profileIntelligence.js'),
    import('../crawlerOsPersistenceCore.js'),
  ])
  const thesis = buildThesis(profileContextToThesisInput(ctx))
  return thesis?.needs_defaulted === true
}

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
  const needsDefaultedOf = typeof deps.thesisNeedsDefaulted === 'function' ? deps.thesisNeedsDefaulted : thesisNeedsDefaulted
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
    proofs_carried: 0,
    held_at_review: 0,
    truncated: false,
  }

  let rows
  try {
    rows = await db.prepare(
      `SELECT
              m.id AS match_id,
              m.opportunity_id,
              m.matcher_version,
              m.match_explain_json AS existing_explain,
              m.match_decision AS stored_decision,
              m.match_score AS stored_score,
              fo.*,
              m.profile_id AS profile_id
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
  const needsDefaultedCache = new Map()
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

    const previousExplain = parseExplain(row.existing_explain)
    const gateMeta = gateMetaFromStub(previousExplain)

    // CARRY THE PROOF FORWARD. The canonical engine never builds a four-truth
    // proof; persisting its explain over a crawler-os one silently unproved
    // every proven direct row it touched (prod 2026-09-07: 452 crawler-os rows
    // refreshed, 96 still proven). The REAL leg is capture-time evidence and
    // is kept verbatim; the profile-side legs are recomputed from THIS decision.
    let refreshedProof = null
    const previousProof = fundingTruthProofFrom(previousExplain)
    if (previousProof) {
      let needsDefaulted
      const cached = needsDefaultedCache.get(profileId)
      if (cached !== undefined) needsDefaulted = cached
      else {
        try { needsDefaulted = await needsDefaultedOf(ctx) } catch { needsDefaulted = undefined }
        needsDefaultedCache.set(profileId, needsDefaulted)
      }
      refreshedProof = refreshFourTruthProof(previousProof, { canonical: decision, opportunity: row, needsDefaulted })
      if (refreshedProof) summary.proofs_carried += 1
    }

    const explain = buildPersistedMatchExplain(
      decision,
      refreshedProof ? { ...gateMeta, four_truth_proof: refreshedProof } : gateMeta,
    )
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

    // Gate-preserving write policy:
    // - Never downgrade a linker-authored match (accept > review > reject)
    // - ACCEPT-only lanes ('county-crisis-need-link', 'catalog-rescore-link') keep ACCEPT only
    // - For linker lanes that allow REVIEW (e.g. 'funder-behavior-link'), refuse REJECT overwrites
    // The refresh exists to backfill explain policy/version, not to change linker admission.
    const matcherVersion = String(row.matcher_version || '').toLowerCase()
    const storedDecision = String(row.stored_decision || '').toLowerCase()
    const rank = (d) => (d === 'accept' ? 2 : d === 'review' ? 1 : 0)
    const ACCEPT_ONLY_VERSIONS = new Set(['county-crisis-need-link', 'catalog-rescore-link'])
    const LINKER_VERSIONS = new Set([
      'web-llm',
      'institution-link',
      'profile-discovery-link',
      'field-of-study-link',
      'student-aid-instate-link',
      'county-crisis-need-link',
      'catalog-rescore-link',
      'funder-behavior-link',
    ])

    let verdictToWrite = verdict || null
    let scoreToWrite = Number.isFinite(score) ? score : null
    let explanationToWrite = decision?.explanation ?? null

    // THE FOUR-TRUTH GATE, exactly as crawler-os applies it: a direct-funding
    // ACCEPT is unrecommendable without an all-passed proof, and the display
    // gate (config/matchSurfacing.qualifiesForDisplay) refuses it anyway. On
    // crawler-os lanes the drain must therefore hold such an ACCEPT at REVIEW
    // and SAY which truth failed, instead of writing an ACCEPT that only ever
    // shows up as debt in the boot census.
    const isDirectFunding = refreshedProof
      ? refreshedProof.direct_funding === true
      : !isFundingResource(row)
    if (verdictToWrite === 'accept' && isDirectFunding &&
        (refreshedProof ? refreshedProof.all_passed !== true : CRAWLER_OS_LANES.has(matcherVersion))) {
      verdictToWrite = 'review'
      explanationToWrite = refreshedProof
        ? `four-truth gate held at REVIEW: ${failedFourTruths(refreshedProof).join(', ')}`
        : 'no four-truth proof on record — held at REVIEW until this pair is re-scored through crawler-os'
      summary.held_at_review += 1
    }

    // Accept-only lanes: only allow ACCEPT to be written; keep stored decision/score otherwise
    if (ACCEPT_ONLY_VERSIONS.has(matcherVersion) && verdictToWrite !== 'accept') {
      verdictToWrite = null
      scoreToWrite = null
    }
    // For linker lanes in general: never allow a downgrade (e.g., accept -> review/reject)
    if (LINKER_VERSIONS.has(matcherVersion)) {
      if (rank(verdictToWrite) < rank(storedDecision)) {
        verdictToWrite = null
        // Do not lower the score alongside a downgrade; keep existing score
        scoreToWrite = null
      }
      // Never let a linker row flip to REJECT in place
      if (verdictToWrite === 'reject') {
        verdictToWrite = null
        scoreToWrite = null
      }
    }

    // A SUPPRESSED verdict (one of the guards above refused to apply the fresh
    // recompute) must never leave behind a WEAKER proof than what is already on
    // record. `match_decision` stays exactly as stored below (COALESCE keeps
    // it), so `match_explain_json` must keep matching that decision too.
    // Persisting the fresh (possibly failing) `refreshedProof` here while the
    // decision column still reads 'accept' produces exactly the shape
    // `persisted_match_decision_integrity` deletes on the very next boot-ladder
    // step: an incomplete/in-flight signal-derivation recompute (or any other
    // transient disagreement) would then PERMANENTLY DESTROY a row this exact
    // write-policy exists to protect — proven in prod 2026-09-12: a
    // catalog-rescore-link ACCEPT for Axiom BioLabs / NSF "Computational and
    // Data-Enabled Science and Engineering", independently adjudicated CORRECT,
    // was silently corrupted to a failing proof by this drain (ACCEPT_ONLY
    // policy nulled the decision write but not the proof write) and deleted
    // moments later by the integrity net, with no negative verdict ever
    // actually applied to `match_decision`. Only a determined negative verdict
    // — one this policy actually agrees to WRITE — may downgrade the proof.
    let explainToPersist = explain
    if (verdictToWrite === null && storedDecision === 'accept') {
      explanationToWrite = null
      const previousWasPositive = previousProof
        ? hasPositiveFourTruthProof({ four_truth_proof: previousProof })
        : false
      if (previousWasPositive) {
        explainToPersist = { ...explain, four_truth_proof: previousProof }
      }
    }

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
        JSON.stringify(explainToPersist),
        scoreToWrite,
        verdictToWrite,
        explanationToWrite,
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
