// crawler-os/adapters/countyCityDirectoryAdapter.js
//
// Geo-aware directory adapter for the COUNTY & CITY programs lane. Like
// officialDirectoryAdapter it emits one honest locator candidate per source —
// but personalized to the profile's own place:
//
//   - the candidate TITLE names the profile's county/city (so a Whatcom, WA
//     profile surfaces "Whatcom County — local assistance programs", not a
//     generic national row), and
//   - when the registry row declares a `url_template` with a `{zip}` slot and
//     the thesis has a ZIP, the info/apply link deep-links to the profile's
//     own results page (e.g. findhelp.org/search_results/98225).
//
// Honesty rules unchanged: these are locators (kind DIRECTORY, apply_url null)
// pointing at real public pages; nothing is invented. A profile with no known
// place still gets the plain national row — a locator is useful either way.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

/** "Whatcom County, WA" | "Bellingham, WA" | "WA" | null from a thesis. */
function placeLabel(thesis) {
  const loc = thesis?.location ?? {};
  const state = loc.state ? String(loc.state).trim() : '';
  const county = loc.county ? String(loc.county).trim() : '';
  const city = loc.city ? String(loc.city).trim() : '';
  if (county) {
    // Normalize "Whatcom" and "Whatcom County" both to "Whatcom County".
    const c = /\b(county|parish|borough)\b/i.test(county) ? county : `${county} County`;
    return state ? `${c}, ${state}` : c;
  }
  if (city) return state ? `${city}, ${state}` : city;
  return state || null;
}

function resolveUrl(thesis, source) {
  const zip = thesis?.location?.zip ? String(thesis.location.zip).trim() : '';
  const template = source?.url_template ? String(source.url_template) : '';
  if (template.includes('{zip}') && /^\d{5}(-\d{4})?$/.test(zip)) {
    return template.replace('{zip}', zip.slice(0, 5));
  }
  return source?.application_url || source?.base_url;
}

export function createCountyCityDirectoryAdapter(sourceId) {
  if (!sourceId) throw new Error('createCountyCityDirectoryAdapter: sourceId required');

  return createBaseAdapter({
    source_id: sourceId,
    family: 'directory',
    requiredEnv: [],
    buildRequests(thesis, source) {
      const url = resolveUrl(thesis, source);
      const place = placeLabel(thesis);
      const baseTitle = source.resource_title || source.name || source.source_id;
      return [{
        url,
        parseCfg: {
          directoryCandidate: {
            kind: OPPORTUNITY_KIND.DIRECTORY,
            title: place ? `${place} — ${baseTitle}` : baseTitle,
            sponsor: source.sponsor_name || source.name || baseTitle,
            summary: source.resource_summary || source.description || null,
            info_url: url,
            apply_url: null,
          },
        },
      }];
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || !source) return null;
      return {
        kind: OPPORTUNITY_KIND.DIRECTORY,
        title: raw.title ?? source.resource_title ?? source.name ?? null,
        sponsor: raw.sponsor ?? source.sponsor_name ?? source.name ?? null,
        summary: raw.summary ?? source.resource_summary ?? source.description ?? null,
        info_url: raw.info_url ?? source.base_url ?? null,
        apply_url: null,
        is_directory: true,
        applicant_types: source.applicant_types ?? ['*'],
        need_categories: source.need_categories ?? ['*'],
        geography: source.geography ?? { national: true, states: [] },
        is_loan: false,
        requires_cost_share: false,
        raw,
      };
    },
  });
}

export default { createCountyCityDirectoryAdapter };
