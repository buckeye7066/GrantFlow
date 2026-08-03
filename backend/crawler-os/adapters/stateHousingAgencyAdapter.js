// crawler-os/adapters/stateHousingAgencyAdapter.js
//
// The STATE HOUSING FINANCE AGENCY locator, resolved per profile.
//
// A homeowner in foreclosure and a renter facing eviction both end up at the
// same door: their state's housing finance agency (IHCDA in Indiana, OHFA in
// Ohio, WVHDF in West Virginia). That agency administers Homeowner Assistance
// Fund money, foreclosure-prevention counseling, rental assistance, home repair
// and the state's HUD-approved counseling network. Measured 2026-08-02, the
// registry named none of them.
//
// WHY AN ADAPTER AND NOT 51 REGISTRY ROWS: `planner.servesGeo` keeps a
// state-scoped source when the thesis has NO state ("unknown location -> keep"),
// so 51 state rows meant the 5 real prod profiles with no resolvable state
// selected ALL of them (+54 sources each — the 2026-07 geo-link flood class).
// One national row + this adapter gives every profile exactly ONE, and the gate
// in planner.js is left exactly as it was.
//
// HONESTY: the URL and the agency name come from the SAME curated registry the
// rest of the product reads (`services/shared/data/stateRegistry.js`); nothing
// is guessed. A profile with no resolvable state gets the honest national HUD
// state-resources page under its generic title — never a made-up state.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { STATE_REGISTRY } from '../../services/shared/data/stateRegistry.js';

/**
 * PURE. Resolve the profile's own state housing finance agency.
 * @returns {{state:string|null, name:string|null, url:string|null}}
 */
export function resolveStateHousingAgency(thesis) {
  const raw = thesis?.location?.state;
  const st = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  // A two-letter code is the only thing STATE_REGISTRY is keyed by; anything
  // else (a full name, the junk "USA" prod carries) resolves to nothing rather
  // than to a wrong state.
  if (!/^[A-Z]{2}$/.test(st)) return { state: null, name: null, url: null };
  const entry = STATE_REGISTRY[st];
  if (!entry?.housingUrl) return { state: null, name: null, url: null };
  return {
    state: st,
    name: entry.housingName || `${entry.name || st} housing finance agency`,
    url: entry.housingUrl,
  };
}

export function createStateHousingAgencyAdapter(sourceId) {
  if (!sourceId) throw new Error('createStateHousingAgencyAdapter: sourceId required');

  return createBaseAdapter({
    source_id: sourceId,
    family: 'directory',
    requiredEnv: [],
    buildRequests(thesis, source) {
      const agency = resolveStateHousingAgency(thesis);
      const url = agency.url || source.base_url;
      const title = agency.name
        ? `${agency.name} — homeowner & renter housing programs`
        : (source.resource_title || source.name || source.source_id);
      const summary = agency.name
        ? `Official ${agency.name}: homeowner assistance and foreclosure-prevention programs, rental assistance, home repair and weatherization, down-payment help, and the state's HUD-approved housing counseling network.`
        : (source.resource_summary || null);
      return [{
        url,
        parseCfg: {
          directoryCandidate: {
            kind: OPPORTUNITY_KIND.DIRECTORY,
            title,
            sponsor: agency.name || source.sponsor_name || source.name,
            summary,
            info_url: url,
            apply_url: null,
            // THE STATE THE ADAPTER JUST RESOLVED IS A FACT ABOUT THE ROW
            // (2026-08-03, the Robert White out-of-state-HFA class). The first
            // version dropped it here, so every minted per-state row ("West
            // Virginia Housing Development Fund — …") inherited the NATIONAL
            // source's geography, was stamped `is_national = 1, state NULL`,
            // and cross-matched to every profile in the fleet — the state
            // lived only in the title, as a FULL NAME the `"<Place>, XX — "`
            // gates cannot read. A resolved agency is state-exclusive by
            // construction; only the unresolved generic fallback stays
            // national. Boot net for the rows already minted wrong:
            // enforceStateAgencyGeoScope (enforceInvariants.js).
            geography: agency.state
              ? { national: false, states: [agency.state] }
              : undefined,
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
        // Prefer the per-state geography the request carried (a resolved
        // agency); fall back to the source's own (national) scope only when
        // the state could not be resolved.
        geography: raw.geography ?? source.geography ?? { national: true, states: [] },
        is_loan: false,
        requires_cost_share: false,
        raw,
      };
    },
  });
}

export default { createStateHousingAgencyAdapter, resolveStateHousingAgency };
