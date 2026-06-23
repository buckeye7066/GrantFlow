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
    buildRequests(_thesis, source) {
      const url = `${source.base_url}/page/community-foundation-locator`;
      // The title MUST agree with the stored match-scope. This locator is a single
      // NATIONAL page (geography: { national: true } in the source registry) and it
      // dedups on the shared URL, so there is exactly one COF row in the corpus for
      // every profile. Earlier this baked the crawling profile's state into the
      // title ("...serving OH..."), but since the row matches every profile
      // nationwide, a Tennessee student would see an Ohio label — a misleading,
      // wrong-geo suggestion that violates honest-matching (goals #1/#6). Always
      // label it as the national directory it actually is; the user searches their
      // own area on cof.org.
      return [{
        url,
        parseCfg: {
          directoryCandidate: {
            kind: OPPORTUNITY_KIND.DIRECTORY,
            title: 'Community Foundation Locator (national directory)',
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
