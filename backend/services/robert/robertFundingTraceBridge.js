/**
 * Robert × Funding Trace Bridge
 * -----------------------------
 * Lets Robert (the funding-discovery agent) use the Funding Trace tool as a
 * discovery source: given an entity (a company / public entity / individual
 * known to receive funding), trace WHERE its money comes from and turn each
 * addable funder into a pending Robert source candidate for the normal
 * review → verify → ingest pipeline.
 *
 * Serves GrantFlow goals #1 (find REAL funding sources, not junk) and #6
 * (bring in useful sources): the funders surfaced here are evidenced by actual
 * federal award records, not guessed.
 *
 * Robert never auto-adds anything — candidates land as `status='pending'`.
 */

import { traceFunding } from '../fundingTraceService.js'
import { findSimilarOrgsFunders } from '../reverseLookupService.js'
import { makeSourceCandidate, SOURCE_STATUS } from './robertTypes.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('robertFundingTrace')

// Map a traced source type to Robert's source-type taxonomy + scope + trust.
// Federal award data is authoritative, so those carry high trust; AI-identified
// channels are plausible leads and carry lower trust pending verification.
export function classifyTracedSource(source) {
  switch (source.type) {
    case 'federal_agency':
      return { source_type: 'federal_portal', source_scope: 'federal', trust: 85 }
    case 'state_agency':
      return { source_type: 'state_grant_portal', source_scope: 'state', trust: 70 }
    case 'foundation':
      return { source_type: 'private_foundation', source_scope: 'national', trust: 45 }
    case 'corporate_csr':
    case 'parent_company':
    case 'venture_capital':
      return { source_type: 'corporate_giving', source_scope: 'national', trust: 40 }
    default:
      return { source_type: 'nonprofit_directory', source_scope: 'national', trust: 35 }
  }
}

/**
 * Trace an entity's funding and upsert the addable funders as Robert source
 * candidates. Pure-ish: persistence is injected via `upsert` so it's testable.
 *
 * @param {object}   db        request/db handle (passed through to traceFunding + upsert)
 * @param {object}   args
 * @param {string}   args.entity        free-text entity to trace
 * @param {string}   [args.entityType]  'company' | 'public_entity' | 'individual'
 * @param {boolean}  [args.useAi]       include AI-synthesized channels (default true)
 * @param {Function} args.upsert        async (db, candidate) => { id, inserted, updated }
 * @param {string|null} [args.runId]    associate candidates with a Robert run
 * @param {Function} [args.traceFn]     trace implementation (injected for tests)
 * @returns {Promise<object>} summary { entity, traced, addable, upserted, skipped, candidates }
 */
export async function traceFundingIntoCandidates(db, { entity, entityType = 'company', useAi = true, upsert, runId = null, traceFn = traceFunding } = {}) {
  if (typeof upsert !== 'function') throw new Error('traceFundingIntoCandidates: upsert function required')

  const trace = await traceFn(db, { entity, entityType, useAi })

  // Only addable funders become candidates; a source MUST have a real URL
  // (Robert rejects sources without one — goal #1: no dead/placeholder links).
  const addable = (trace.sources || []).filter((s) => s.addable !== false && s.sample_url)
  const skippedNoUrl = (trace.sources || []).filter((s) => s.addable !== false && !s.sample_url).length

  let inserted = 0
  let updated = 0
  const candidates = []

  for (const source of addable) {
    const { source_type, source_scope, trust } = classifyTracedSource(source)
    try {
      const candidate = makeSourceCandidate({
        source_name: source.parent_agency ? `${source.name} (${source.parent_agency})` : source.name,
        source_url: source.sample_url,
        source_type,
        source_scope,
        trust_score: trust,
        discovered_by: 'robert:funding-trace',
        status: SOURCE_STATUS.PENDING,
        evidence: {
          tool: 'funding_trace',
          traced_entity: trace.entity,
          entity_type: trace.entity_type,
          origin: source.origin,
          total_amount: source.total_amount ?? null,
          award_count: source.award_count ?? null,
          latest_year: source.latest_year ?? null,
          parent_agency: source.parent_agency ?? null,
          rationale: source.rationale ?? null,
          run_id: runId,
        },
      })
      const result = await upsert(db, candidate)
      if (result?.inserted) inserted += 1
      else if (result?.updated) updated += 1
      candidates.push({ id: result?.id ?? null, source_name: candidate.source_name, source_type, trust_score: trust, inserted: !!result?.inserted })
    } catch (err) {
      log.warn(`[robert:funding-trace] failed to upsert candidate "${source.name}": ${err?.message}`)
    }
  }

  log.info(`[robert:funding-trace] entity="${trace.entity}" traced=${trace.sources?.length ?? 0} addable=${addable.length} inserted=${inserted} updated=${updated}`)

  return {
    entity: trace.entity,
    entity_type: trace.entity_type,
    addability: trace.addability,
    traced: trace.sources?.length ?? 0,
    addable: addable.length,
    upserted: inserted + updated,
    inserted,
    updated,
    skipped_no_url: skippedNoUrl,
    candidates,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Auto-seed: derive entities to trace from a profile Robert already covers.
// ───────────────────────────────────────────────────────────────────────────

// Generic words that make a peer-org name useless as a USASpending recipient
// search (they match thousands of unrelated recipients).
const STOPWORD_NAMES = new Set(['unknown', 'n/a', 'none', 'various', 'anonymous'])

function usableEntityName(name) {
  const n = String(name || '').trim()
  if (n.length < 4) return false
  return !STOPWORD_NAMES.has(n.toLowerCase())
}

/**
 * PURE: turn a profile's peer organizations into a deduped, capped list of
 * entities worth tracing. The premise (goals #1/#6): organizations *similar to
 * our user* that already win funding reveal real funders we can add — so we
 * trace the peers, not the user.
 *
 * @param {object} args
 * @param {Array}  args.similarOrgs   peer orgs from reverse-lookup ([{ name }])
 * @param {object} [args.profileSummary] { entity_type }
 * @param {string} [args.ownOrgName]  the profile's own org name (traced too if established)
 * @param {number} [args.max]         cap on entities returned
 * @returns {Array<{ entity, entityType, reason }>}
 */
export function deriveSeedEntities({ similarOrgs = [], profileSummary = {}, ownOrgName = null, max = 8 } = {}) {
  // Peers are organizations regardless of the profile's own entity type.
  const entityType = 'company'
  const seeds = []
  const seen = new Set()

  const push = (name, reason) => {
    if (!usableEntityName(name)) return
    const key = name.trim().toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    seeds.push({ entity: name.trim(), entityType, reason })
  }

  // The profile's own org first (find where THEY already get funding).
  if (ownOrgName) push(ownOrgName, 'profile_own_org')
  // Then mission-aligned peers, in the order reverse-lookup ranked them.
  for (const org of similarOrgs) push(org?.name, 'similar_org_peer')

  // profileSummary kept for future weighting (e.g. de-prioritize peers in a
  // different state); not needed for the current ordering.
  void profileSummary

  return seeds.slice(0, max)
}

/**
 * Auto-seed funding-trace from a profile: find peers, trace each, stage the
 * funders as pending source candidates. Dependencies are injected so the
 * orchestration is testable without network or DB.
 *
 * @param {object} db
 * @param {object} args
 * @param {string} args.profileId
 * @param {number} [args.maxEntities]   cap on peer entities to trace (default 5)
 * @param {boolean} [args.useAi]        pass-through to the trace (default false here — peers are many, keep it cheap)
 * @param {string|null} [args.runId]
 * @param {object} [args.deps]          { findPeers, traceInto, upsert }
 * @returns {Promise<object>} aggregate summary
 */
export async function autoSeedTraceForProfile(db, { profileId, maxEntities = 5, useAi = false, runId = null, deps = {} } = {}) {
  if (!profileId) throw new Error('autoSeedTraceForProfile: profileId required')
  const findPeers = deps.findPeers || ((d, id) => findSimilarOrgsFunders(d, id, { maxResults: 15 }))
  const traceInto = deps.traceInto || traceFundingIntoCandidates
  const upsert = deps.upsert
  if (typeof upsert !== 'function') throw new Error('autoSeedTraceForProfile: deps.upsert function required')

  const peerResult = await findPeers(db, profileId)
  const seeds = deriveSeedEntities({
    similarOrgs: peerResult?.similar_orgs || [],
    profileSummary: peerResult?.profile_summary || {},
    ownOrgName: peerResult?.profile_summary?.org_name || null,
    max: maxEntities,
  })

  const perEntity = []
  let totalUpserted = 0
  let totalAddable = 0
  for (const seed of seeds) {
    try {
      const summary = await traceInto(db, {
        entity: seed.entity,
        entityType: seed.entityType,
        useAi,
        upsert,
        runId,
      })
      totalUpserted += summary.upserted || 0
      totalAddable += summary.addable || 0
      perEntity.push({ ...seed, addable: summary.addable, upserted: summary.upserted })
    } catch (err) {
      log.warn(`[robert:funding-trace] auto-seed trace failed for "${seed.entity}": ${err?.message}`)
      perEntity.push({ ...seed, error: err?.message || 'trace failed' })
    }
  }

  log.info(`[robert:funding-trace] auto-seed profile=${profileId} peers=${seeds.length} addable=${totalAddable} upserted=${totalUpserted}`)

  return {
    profile_id: profileId,
    seeds_traced: seeds.length,
    total_addable: totalAddable,
    total_upserted: totalUpserted,
    per_entity: perEntity,
  }
}
