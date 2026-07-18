// crawler-os/blindFactsMapper.js
//
// Phase 1a of the web-lane de-contamination program: the PROFILE-BLIND mapper.
//
// The live mapper (webLane.toCandidate) STAMPS the profile's own facts onto the
// candidate before scoring: it copies `thesis.applicant_types` onto the row and
// falls the geography back to the profile's state. That pre-loads the candidate
// with the profile's answers, so the match engine then "confirms" facts the
// profile supplied rather than facts the page stated — a hidden thumb on the
// scale. This mapper carries ONLY what the page supports: eligibility, geography,
// and need categories come exclusively from the page-fact object. Anything the
// page did not state stays EMPTY/neutral — never inferred from a profile (there
// is none here). Page/source provenance is preserved in NON-scoring metadata.
//
// PURE. No I/O, no profile input.

import { OPPORTUNITY_KIND } from './contract.js';
import { cleanEligibilityText, cleanEligibilityBullets, cleanFieldProvenance } from './pageFacts.js';

// Catalog lane id for open-web finds (same lane the live web source uses). Kept
// as a constant here so the additive module is self-contained; wiring is a later PR.
export const BLIND_WEB_SOURCE_ID = 'web_search';

/**
 * mapBlindFactsToCandidate — turn one profile-blind page-fact object into the OS
 * candidate contract consumed by enforceReality / normalize / makeOpportunity.
 *
 * Everything that could influence the score is page-supported ONLY:
 *   - applicant_types: ALWAYS [] — the page's stated eligibility prose lives in
 *     eligibility_text/field_provenance; we NEVER stamp a profile's types.
 *   - need_categories: only what the page stated (facts.need_categories).
 *   - geography: only what the page stated (facts.geography); an unstated scope
 *     stays { national:false, states:[] } (neutral), never the profile's state.
 * Provenance (page_url, extractor version, field_provenance) rides in `raw` and
 * the page-fact columns, which are non-scoring.
 *
 * @param {object} facts a single page-fact object from extractPageFactsBlind.
 * @returns {object|null} an OS candidate, or null if the facts lack title+sponsor.
 */
export function mapBlindFactsToCandidate(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const title = String(facts.title || '').trim();
  const sponsor = String(facts.sponsor || '').trim();
  if (!title || sponsor.length < 2) return null;

  const geo = facts.geography && typeof facts.geography === 'object' ? facts.geography : {};
  const national = geo.national === true;
  const states = national ? [] : (Array.isArray(geo.states) ? geo.states.filter(Boolean) : []);

  const need_categories = Array.isArray(facts.need_categories)
    ? facts.need_categories.filter((n) => typeof n === 'string' && n.trim()).slice(0, 12)
    : [];

  // apply/info URLs are already inventory-verified by the extractor; carry them
  // through unchanged. A fallback (page as info) is already in info_url, never apply.
  const apply_url = typeof facts.apply_url === 'string' && facts.apply_url ? facts.apply_url : null;
  const info_url = typeof facts.info_url === 'string' && facts.info_url ? facts.info_url : (apply_url || facts.page_url || null);

  const amount_min = typeof facts.amount_min === 'number' ? facts.amount_min : null;
  const amount_max = typeof facts.amount_max === 'number' ? facts.amount_max : null;

  return {
    external_id: null,
    source_id: BLIND_WEB_SOURCE_ID,
    kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title,
    sponsor,
    summary: typeof facts.summary === 'string' && facts.summary.trim() ? facts.summary.trim().slice(0, 800) : null,
    // NEVER profile-derived. The page's eligibility is prose + provenance, not a
    // stamped applicant type. Empty here means the match engine decides fit from
    // the page facts alone.
    applicant_types: [],
    need_categories,
    geography: { national, states },
    amount_min,
    amount_max,
    is_loan: facts.is_loan === true,
    requires_cost_share: facts.requires_cost_share === true,
    apply_url,
    info_url,
    // --- Page facts (Phase 0.1 shape) — carried for storage; non-scoring -------
    eligibility_text: cleanEligibilityText(facts.eligibility_text),
    eligibility_bullets: cleanEligibilityBullets(facts.eligibility_bullets),
    page_fact_schema_version: facts.page_fact_schema_version ?? null,
    field_provenance: cleanFieldProvenance(facts.field_provenance),
    // --- Non-scoring provenance metadata ---------------------------------------
    raw: {
      blind_extraction: true,
      page_url: facts.page_url ?? null,
      extractor_version: facts.extractor_version ?? null,
      evidence_validation: facts.evidence_validation ?? null,
    },
  };
}

export default { mapBlindFactsToCandidate, BLIND_WEB_SOURCE_ID };
