// crawler-os/adapters/benefitsGovAdapter.js
//
// Benefits.gov — the federal benefit finder. We do not (yet) extract each
// individual benefit program with its own application URL, so the honest output
// is ONE DIRECTORY candidate pointing at the benefit finder, optionally scoped by
// the profile's top need category. This is labeled a directory, never a
// "direct grant", and never a loan.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

export function createBenefitsGovAdapter() {
  return createBaseAdapter({
    source_id: 'benefits_gov',
    family: 'directory',
    requiredEnv: [],
    buildRequests(thesis, source) {
      const url = `${source.base_url}/benefit-finder`;
      const topNeed = (thesis.needs ?? [])[0] ?? null;
      return [{
        url,
        parseCfg: {
          directoryCandidate: {
            kind: OPPORTUNITY_KIND.DIRECTORY,
            title: topNeed
              ? `Benefits.gov finder — ${topNeed} benefits`
              : 'Benefits.gov — federal benefit finder',
            sponsor: 'U.S. Government (Benefits.gov)',
            summary: 'Answer a short eligibility questionnaire to discover federal/state benefit programs you may qualify for.',
            info_url: url,
            apply_url: null,
          },
        },
      }];
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw) return null;
      return {
        kind: OPPORTUNITY_KIND.DIRECTORY,
        title: raw.title ?? null,
        sponsor: raw.sponsor ?? 'U.S. Government (Benefits.gov)',
        summary: raw.summary ?? null,
        info_url: raw.info_url ?? null,
        apply_url: null,
        is_directory: true,
        applicant_types: source?.applicant_types ?? ['individual', 'family'],
        need_categories: source?.need_categories ?? ['housing', 'food', 'medical', 'energy'],
        geography: source?.geography ?? { national: true, states: [] },
        raw,
      };
    },
  });
}

export default { createBenefitsGovAdapter };
