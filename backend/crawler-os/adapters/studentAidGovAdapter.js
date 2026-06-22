// crawler-os/adapters/studentAidGovAdapter.js
//
// Federal Student Aid (studentaid.gov). There is no single "apply" endpoint to
// scrape; the honest representation is a DIRECTORY/locator candidate that points
// students to the official aid-types page (Pell Grants and other federal aid).
// Marked is_directory so the reality gate classifies it correctly (never an
// "apply now"), with no fabricated apply_url.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

export function createStudentAidGovAdapter() {
  return createBaseAdapter({
    source_id: 'studentaid_gov',
    family: 'directory',
    requiredEnv: [],
    buildRequests(thesis, source) {
      const url = `${source.base_url}/aid-types/grants`;
      return [{
        url,
        parseCfg: {
          directoryCandidate: {
            kind: OPPORTUNITY_KIND.DIRECTORY,
            title: 'Federal Student Aid programs',
            sponsor: 'U.S. Department of Education (Federal Student Aid)',
            summary: 'Explore federal student aid options such as Pell Grants and other scholarships.',
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
        title: raw.title ?? 'Federal Student Aid programs',
        sponsor: raw.sponsor ?? 'U.S. Department of Education (Federal Student Aid)',
        summary: raw.summary ?? 'Explore federal student aid options such as Pell Grants and other scholarships.',
        info_url: raw.info_url ?? `${source.base_url}/aid-types/grants`,
        apply_url: null,
        is_directory: true,
        applicant_types: source?.applicant_types ?? ['student', 'family'],
        need_categories: source?.need_categories ?? ['education'],
        geography: source?.geography ?? { national: true, states: [] },
        raw,
      };
    },
  });
}

export default { createStudentAidGovAdapter };
