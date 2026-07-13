// crawler-os/tests/fixtures/fakeFetch.mjs
//
// A deterministic, offline fake network for tests and offline scripts. It mimics
// the doFetch interface createFetcher expects:
//   doFetch(url, init) -> { status, ok, url, headers:{get}, text() }
//
// Routes are matched by URL substring. The default routes return realistically
// shaped bodies for the implemented adapters so the REAL pipeline runs end to end
// with zero network and zero external deps.

import { createFetcher } from '../../fetcher.js';

function resp(status, body, finalUrl) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: finalUrl,
    headers: { get: () => null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

/** Build a Grants.gov Search2-shaped JSON body from simple opp specs. */
export function grantsGovBody(opps = []) {
  return {
    data: {
      oppHits: opps.map((o, i) => ({
        id: o.id ?? `OPP-${1000 + i}`,
        number: o.number ?? `AG-${1000 + i}`,
        title: o.title ?? `Federal Grant ${i + 1}`,
        agency: o.agency ?? 'U.S. Department of Example',
        agencyCode: o.agencyCode ?? 'DOE',
        openDate: o.openDate ?? '01/01/2026',
        closeDate: o.closeDate ?? futureDate(120),
        oppStatus: o.oppStatus ?? 'posted',
        docType: 'synopsis',
        synopsis: o.synopsis ?? o.summary ?? null,
      })),
    },
  };
}

/** Build a Federal Register documents.json-shaped body from simple notice specs. */
export function federalRegisterBody(notices = []) {
  return {
    count: notices.length,
    results: notices.map((n, i) => ({
      document_number: n.document_number ?? `2026-${10000 + i}`,
      title: n.title ?? `Notice of Funding Opportunity ${i + 1}`,
      html_url:
        n.html_url ??
        `https://www.federalregister.gov/documents/2026/07/01/2026-${10000 + i}/notice-of-funding-opportunity-${i + 1}`,
      abstract: n.abstract ?? n.summary ?? null,
      publication_date: n.publication_date ?? '2026-07-01',
      agencies: n.agencies ?? [{ name: n.agency ?? 'Federal Emergency Management Agency', raw_name: 'FEMA' }],
    })),
  };
}

function futureDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

/**
 * makeFakeFetch — build a doFetch.
 * @param {object} [options]
 * @param {Array} [options.grantsGov] opp specs for the grants.gov route
 * @param {object} [options.routes] extra { substring: body } routes
 * @param {Set<string>} [options.fail] URL substrings that should return 500
 */
export function makeFakeFetch(options = {}) {
  const grants = options.grantsGov ?? [
    {
      title: 'Rural Community Facilities Grant',
      agency: 'USDA',
      summary: 'Funding for rural emergency services facilities, equipment, and community infrastructure.',
      closeDate: futureDate(90),
    },
    {
      title: 'Volunteer Fire Equipment Grant',
      agency: 'FEMA',
      summary: 'Funding for volunteer fire department emergency equipment and firefighter response gear.',
      closeDate: futureDate(60),
    },
  ];
  const extraRoutes = options.routes ?? {};
  const fail = options.fail ?? new Set();

  return async function doFetch(url /*, init */) {
    for (const sub of fail) if (url.includes(sub)) return resp(500, 'error', url);

    for (const [sub, body] of Object.entries(extraRoutes)) {
      if (url.includes(sub)) return resp(200, body, url);
    }
    if (url.includes('api.grants.gov')) return resp(200, grantsGovBody(grants), url);
    // federal_register is an api-family lane with requiredListPath — without a
    // shaped route it would hit the default empty body and report a permanent
    // (false) parse_error, masking real adapter regressions.
    if (url.includes('federalregister.gov/api/v1/documents')) {
      return resp(200, federalRegisterBody(options.federalRegister ?? [
        {
          title: 'Fire Prevention and Safety Grants — FY 2026 Notice of Funding Opportunity',
          agency: 'Federal Emergency Management Agency',
          abstract: 'FEMA announces the FY 2026 Fire Prevention and Safety funding opportunity for fire departments and community risk reduction.',
        },
        {
          title: 'Rural Emergency Medical Services Training and Equipment Funding Availability',
          agency: 'Department of Agriculture',
          abstract: 'USDA Rural Development announces funding availability for rural emergency medical services training and equipment.',
        },
      ]), url);
    }
    if (url.includes('cof.org')) return resp(200, '<html><body>Community Foundation Locator</body></html>', url);
    if (url.includes('benefits.gov')) return resp(200, '<html><body>Benefit Finder</body></html>', url);
    if (url.includes('sam.gov/api/prod/sgs')) return resp(200, { _embedded: { results: [] } }, url);
    // default: empty 200
    return resp(200, '', url);
  };
}

/**
 * makeOfflineFetcher — a fully hermetic fetcher for tests and offline scripts.
 *
 * The production default resolver performs a real DNS lookup so the SSRF /
 * DNS-rebinding guard is active out of the box. That is correct for production,
 * but it would couple the offline suite to live DNS (an air-gapped CI would
 * block every fetch and store zero). This helper keeps the guard EXERCISED while
 * staying deterministic: it injects a stub resolver returning a public
 * (non-private) TEST-NET-3 address (203.0.113.0/24, RFC 5737), so the guard runs
 * and passes without any network. Pass the same options as makeFakeFetch.
 */
export function makeOfflineFetcher(options = {}) {
  return createFetcher({
    doFetch: makeFakeFetch(options),
    resolve: async () => ['203.0.113.10'],
    rateMs: 0,
  });
}

/** A profile fixture covering a VFD org in Tennessee (matches FEMA/USDA/grants.gov). */
export const SAMPLE_VFD_PROFILE = Object.freeze({
  id: 'profile_vfd_1',
  name: 'Cleveland Volunteer Fire Department',
  type: 'vfd',
  state: 'TN',
  location: { state: 'TN', county: 'Bradley', city: 'Cleveland' },
  needs: ['equipment', 'emergency'],
  mission: 'Protect our rural community with reliable fire and emergency response.',
});

/** A student/individual profile (lower floor, education needs). */
export const SAMPLE_STUDENT_PROFILE = Object.freeze({
  id: 'profile_student_1',
  name: 'Jordan Lee',
  type: 'student',
  state: 'TN',
  location: { state: 'TN' },
  needs: ['education'],
  school: { name: 'State University', type: 'university' },
});

export default { makeFakeFetch, makeOfflineFetcher, grantsGovBody, federalRegisterBody, SAMPLE_VFD_PROFILE, SAMPLE_STUDENT_PROFILE };
