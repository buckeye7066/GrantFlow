// crawler-os/adapters/foundationDirectoryAdapter.js
//
// Council on Foundations — Community Foundation Locator. This is a DIRECTORY: a
// pointer to where local funders can be found, NOT a direct application. The
// adapter emits exactly ONE honest directory candidate (the locator itself). It
// never invents per-county "grants" (the geo-stub anti-pattern the reality gate
// explicitly rejects). The fetch still runs so evidence (a content hash of the
// locator page) is captured.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

export function createFoundationDirectoryAdapter() {
  return createBaseAdapter({
    source_id: 'cof_locator',
    family: 'directory',
    requiredEnv: [],
    buildRequests(thesis, source) {
      const url = `${source.base_url}/page/community-foundation-locator`;
      const state = thesis.location?.state ?? null;
      return [{
        url,
        parseCfg: {
          directoryCandidate: {
            kind: OPPORTUNITY_KIND.DIRECTORY,
            title: state
              ? `Community foundations serving ${state} (locator)`
              : 'Community Foundation Locator (national directory)',
            sponsor: 'Council on Foundations',
            summary: 'Searchable directory of community foundations. Use it to find local funders, then apply to each foundation directly.',
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
        sponsor: raw.sponsor ?? 'Council on Foundations',
        summary: raw.summary ?? null,
        info_url: raw.info_url ?? null,
        apply_url: null,
        is_directory: true,
        applicant_types: source?.applicant_types ?? ['*'],
        need_categories: source?.need_categories ?? ['*'],
        geography: source?.geography ?? { national: true, states: [] },
        raw,
      };
    },
  });
}

export default { createFoundationDirectoryAdapter };
