// crawler-os/adapters/officialDirectoryAdapter.js
//
// Generic adapter for official/reputable program and locator pages that do not
// expose a structured API. It emits one honest pointer to the registered source.
// The profile may select this lane, but it never changes the source's title,
// applicant facts, geography, or application path.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

function resolvedKind(source = {}, raw = {}) {
  if (source.directory === true) return OPPORTUNITY_KIND.DIRECTORY;
  return raw.kind ?? source.default_kinds?.[0] ?? OPPORTUNITY_KIND.PROGRAM;
}

export function createOfficialDirectoryAdapter(sourceId) {
  if (!sourceId) throw new Error('createOfficialDirectoryAdapter: sourceId required');

  return createBaseAdapter({
    source_id: sourceId,
    family: 'directory',
    requiredEnv: [],
    buildRequests(_thesis, source) {
      const url = source.application_url || source.base_url;
      const kind = resolvedKind(source);
      const title = source.resource_title || source.name || source.source_id;
      return [{
        url,
        parseCfg: {
          directoryCandidate: {
            kind,
            title,
            sponsor: source.sponsor_name || source.name || title,
            summary: source.resource_summary || source.description || null,
            info_url: source.base_url || url || null,
            // A base/info page is not silently promoted to an application. Only
            // an explicit registry application_url may occupy apply_url.
            apply_url: kind === OPPORTUNITY_KIND.DIRECTORY
              ? null
              : (source.application_url || null),
          },
        },
      }];
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || !source) return null;
      const kind = resolvedKind(source, raw);
      const applicationUrl = kind === OPPORTUNITY_KIND.DIRECTORY
        ? null
        : (raw.apply_url ?? source.application_url ?? null);
      return {
        kind,
        title: raw.title ?? source.resource_title ?? source.name ?? null,
        sponsor: raw.sponsor ?? source.sponsor_name ?? source.name ?? null,
        summary: raw.summary ?? source.resource_summary ?? source.description ?? null,
        info_url: raw.info_url ?? source.base_url ?? applicationUrl ?? null,
        apply_url: applicationUrl,
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
