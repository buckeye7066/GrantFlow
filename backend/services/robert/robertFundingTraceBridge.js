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
import { makeSourceCandidate, SOURCE_STATUS } from './robertTypes.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('robertFundingTrace')

// Map a traced source type to Robert's source-type taxonomy + scope + trust.
// Federal award data is authoritative, so those carry high trust; AI-identified
// channels are plausible leads and carry lower trust pending verification.
function classify(source) {
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
 * @returns {Promise<object>} summary { entity, traced, addable, upserted, skipped, candidates }
 */
export async function traceFundingIntoCandidates(db, { entity, entityType = 'company', useAi = true, upsert, runId = null } = {}) {
  if (typeof upsert !== 'function') throw new Error('traceFundingIntoCandidates: upsert function required')

  const trace = await traceFunding(db, { entity, entityType, useAi })

  // Only addable funders become candidates; a source MUST have a real URL
  // (Robert rejects sources without one — goal #1: no dead/placeholder links).
  const addable = (trace.sources || []).filter((s) => s.addable !== false && s.sample_url)
  const skippedNoUrl = (trace.sources || []).filter((s) => s.addable !== false && !s.sample_url).length

  let inserted = 0
  let updated = 0
  const candidates = []

  for (const source of addable) {
    const { source_type, source_scope, trust } = classify(source)
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
