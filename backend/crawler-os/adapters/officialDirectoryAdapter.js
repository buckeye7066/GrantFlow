// crawler-os/adapters/officialDirectoryAdapter.js
//
// Generic source adapter for real official or reputable directory/program pages
// that do not expose a structured API. It emits one honest candidate pointing
// at the source itself. When the registry row is marked directory, the row is a
// DIRECTORY only; otherwise it may be a standing PROGRAM/IN_KIND/etc. page with
// the page URL as its application/instructions URL.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

export function createOfficialDirectoryAdapter(sourceId) {
  if (!sourceId) throw new Error('createOfficialDirectoryAdapter: sourceId required');

  return createBaseAdapter({
    source_id: sourceId,
    family: 'directory',
    requiredEnv: [],
    buildRequests(thesis, source) {
      const url = source.application_url || source.base_url;
      const topNeed = (thesis.needs ?? [])[0] ?? null;
      const kind = source.directory ? OPPORTUNITY_KIND.DIRECTORY : (source.default_kinds?.[0] ?? OPPORTUNITY_KIND.DIRECTORY);
      const title = source.resource_title || source.name || source.source_id;
      return [{
        url,
        parseCfg: {
          directoryCandidate: {
            kind,
            title: topNeed && source.title_prefix
              ? `${source.title_prefix} - ${topNeed}`
              : title,
            sponsor: source.sponsor_name || source.name || title,
            summary: source.resource_summary || source.description || null,
            info_url: source.base_url,
            apply_url: kind === OPPORTUNITY_KIND.DIRECTORY ? null : url,
          },
        },
      }];
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || !source) return null;
      const kind = source.directory ? OPPORTUNITY_KIND.DIRECTORY : (raw.kind ?? source.default_kinds?.[0] ?? OPPORTUNITY_KIND.DIRECTORY);
      return {
        kind,
        title: raw.title ?? source.resource_title ?? source.name ?? null,
        sponsor: raw.sponsor ?? source.sponsor_name ?? source.name ?? null,
        summary: raw.summary ?? source.resource_summary ?? source.description ?? null,
        info_url: raw.info_url ?? source.base_url ?? null,
        apply_url: kind === OPPORTUNITY_KIND.DIRECTORY ? null : (raw.apply_url ?? source.application_url ?? source.base_url ?? null),
        is_directory: kind === OPPORTUNITY_KIND.DIRECTORY,
        applicant_types: source.applicant_types ?? ['*'],
        need_categories: source.need_categories ?? ['*'],
        geography: source.geography ?? { national: true, states: [] },
        is_loan: false,
        requires_cost_share: Boolean(source.cost_share_allowed && source.requires_cost_share_default),
        raw,
      };
    },
  });
}

export default { createOfficialDirectoryAdapter };
