// crawler-os/blindFactsMapper.js
//
// Profile-blind page facts -> canonical Crawler OS candidate. Everything that
// can influence matching comes from the page-fact object. Missing eligibility,
// geography, amount, deadline, or applicant-type evidence stays unknown; no
// profile facts are copied into the opportunity.

import { OPPORTUNITY_KIND } from './contract.js';
import { cleanEligibilityText, cleanEligibilityBullets, cleanFieldProvenance } from './pageFacts.js';

export const BLIND_WEB_SOURCE_ID = 'web_search';

/**
 * @param {object} facts one evidence-validated page-fact object.
 * @returns {object|null} canonical OS candidate.
 */
export function mapBlindFactsToCandidate(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const title = String(facts.title || '').trim();
  const sponsor = String(facts.sponsor || '').trim();
  if (!title || sponsor.length < 2) return null;

  const geo = facts.geography && typeof facts.geography === 'object' ? facts.geography : {};
  const national = geo.national === true;
  const states = national
    ? []
    : [...new Set((Array.isArray(geo.states) ? geo.states : [])
      .map((s) => String(s || '').trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s)))];

  const needCategories = Array.isArray(facts.need_categories)
    ? [...new Set(facts.need_categories
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => n.trim().toLowerCase()))].slice(0, 12)
    : [];

  const applyUrl = typeof facts.apply_url === 'string' && facts.apply_url
    ? facts.apply_url
    : null;
  const infoUrl = typeof facts.info_url === 'string' && facts.info_url
    ? facts.info_url
    : (applyUrl || facts.page_url || null);
  const isRolling = facts.is_rolling === true;

  return {
    external_id: null,
    source_id: BLIND_WEB_SOURCE_ID,
    // A non-rolling page with no verified application target is informational:
    // it must not be represented as an immediately applicable direct grant.
    kind: (isRolling || !applyUrl) ? OPPORTUNITY_KIND.PROGRAM : OPPORTUNITY_KIND.DIRECT_GRANT,
    title,
    sponsor,
    summary: typeof facts.summary === 'string' && facts.summary.trim()
      ? facts.summary.trim().slice(0, 800)
      : null,
    deadline: typeof facts.deadline === 'string' ? facts.deadline : null,
    is_rolling: isRolling,
    // Eligibility remains evidence-bearing prose. Do not infer a categorical
    // applicant type from a passing word and do not copy the searching profile.
    applicant_types: [],
    need_categories: needCategories,
    geography: { national, states },
    amount_min: typeof facts.amount_min === 'number' ? facts.amount_min : null,
    amount_max: typeof facts.amount_max === 'number' ? facts.amount_max : null,
    is_loan: facts.is_loan === true,
    requires_cost_share: facts.requires_cost_share === true,
    apply_url: applyUrl,
    info_url: infoUrl,
    eligibility_text: cleanEligibilityText(facts.eligibility_text),
    eligibility_bullets: cleanEligibilityBullets(facts.eligibility_bullets),
    page_fact_schema_version: facts.page_fact_schema_version ?? null,
    field_provenance: cleanFieldProvenance(facts.field_provenance),
    raw: {
      blind_extraction: true,
      page_url: facts.page_url ?? null,
      extractor_version: facts.extractor_version ?? null,
      evidence_validation: facts.evidence_validation ?? null,
    },
  };
}

export default { mapBlindFactsToCandidate, BLIND_WEB_SOURCE_ID };
