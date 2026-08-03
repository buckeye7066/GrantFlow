/**
 * NGWeb "Scholarship Manager" (ScholarX) portal-sync connector — the platform
 * behind <school>.scholarships.ngwebsolutions.com (MTSU, Cleveland State CC).
 *
 * WHY IT EXISTS: the first live MTSU-tenant sync (2026-08-02, run 183195a2)
 * signed in fine and honestly reported "no structured data connector for this
 * portal yet" — 0 fields, 0 awards.
 *
 * The load-bearing guarantees under test (every fixture string below is
 * VERBATIM from the real signed-in MTSU tenant, probed 2026-08-02):
 *   - landing classification is DESTINATION-based: a private request answered
 *     with the public CMS landing (/CMXAdmin/Cmx_Content.aspx) is signed_out,
 *     while a direct request for that page is served;
 *   - application status comes only from USER-RECORD phrasing ("Thank you for
 *     your submission of the…"), never from the landing page's "Step 1:
 *     Complete the General Scholarship Application" CTA copy;
 *   - "Qualified Opportunities 0 / No Opportunities Found" is a REAL answer
 *     (the portal matches only Mon/Thu), not a read failure;
 *   - registry order: a credential saved for an ngweb tenant host labelled
 *     "MTSU Scholarships" resolves to THIS connector, never to the mtsu.edu
 *     connector (whose matchesCredential greedily claims any "mtsu" label);
 *   - the mtsu connector's default export carries supportsFullMerge (the
 *     omission made resolveMergeState treat every MTSU sync as un-mergeable).
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../services/hamilton/portalSync/llmPageExtract.js', () => ({
  extractPortalDataWithLLM: vi.fn(async () => ({
    awards: [], fields: [], notFound: [], rejected: [], raw: { stubbed: true },
  })),
}))

const connector = (await import('../services/hamilton/portalSync/connectors/ngwebScholarshipManager.js')).default
const {
  classifyLanding, classifyAccess, deriveApplicationStatus,
  deriveQualifiedOpportunities, tenantSlug, matchesCredential,
} = await import('../services/hamilton/portalSync/connectors/ngwebScholarshipManager.js')
const { resolveConnector, getConnectorForHost } = await import('../services/hamilton/portalSync/registry.js')
const mtsuConnector = (await import('../services/hamilton/portalSync/connectors/mtsu.js')).default

const HOST = 'mtsu.scholarships.ngwebsolutions.com'
const BASE = `https://${HOST}`

// Verbatim from the live signed-in probe (2026-08-02).
const SIGNED_IN_HEADER = 'Skip to main content\nAnastasia Nicole White | Logout\n Home\nMy Applications\nMy Opportunities\nMy Awards\nScholarships Search\nContact Us\nSession expires in 45 minutes.\n'
const AWARD_PAGE_TEXT = `${SIGNED_IN_HEADER}Award Information\n\nThank you for your submission of the Middle Tennessee State University Scholarship Application(s).\n\nThis application process runs from October 1st to March 1st.`
const MYOPPS_PAGE_TEXT = `${SIGNED_IN_HEADER}My Opportunities\nApplicant Home  My Opportunities\n\nPLEASE NOTE: Scholarship Matching ONLY OCCURS on Mondays & Thursdays.\n\nQualified Opportunities 0\nNo Opportunities Found`
const APPLICATIONS_PAGE_TEXT = `${SIGNED_IN_HEADER}My Applications\n\nWelcome back, Anastasia Nicole White, to MTSU's Scholarship Manager!\n\nApplications\nSorry, currently there are no applications available. Check back at a later date.`
const LANDING_CTA_TEXT = `${SIGNED_IN_HEADER}Home\nWelcome to the scholarship application portal.\nStep 1: Complete the General Scholarship Application.\nStep 2: Once the General Scholarship Application is submitted, you will be shown other scholarship applications.\nTasks  0\n- No Tasks at this time. -`
const PUBLIC_CMS_TEXT = 'Scholarship Manager\nThis website lists all of the scholarships available to Middle Tennessee State University (MTSU) students.\nApply Now\nScholarships (557)'

describe('classifyLanding — destination is the authority', () => {
  it('a private request answered with the public CMS landing is signed_out (the real signature)', () => {
    expect(classifyLanding(
      `${BASE}/Applicants/MyOpportunities`,
      `${BASE}/CMXAdmin/Cmx_Content.aspx?cpId=1276`,
    )).toBe('signed_out')
  })

  it('a DIRECT request for the CMS landing is served, not signed_out', () => {
    expect(classifyLanding(
      `${BASE}/CMXAdmin/Cmx_Content.aspx?cpId=1276`,
      `${BASE}/CMXAdmin/Cmx_Content.aspx?cpId=1276`,
    )).toBe('served')
  })

  it('landing on the requested private page is served', () => {
    expect(classifyLanding(
      `${BASE}/scholarx_studentaward.aspx`,
      `${BASE}/scholarx_studentaward.aspx`,
    )).toBe('served')
  })

  it('a redirect to a login path is signed_out; a cross-origin redirect is foreign', () => {
    expect(classifyLanding(`${BASE}/Applicants/MyOpportunities`, `${BASE}/Account/Login?ReturnUrl=x`)).toBe('signed_out')
    expect(classifyLanding(`${BASE}/Applicants/MyOpportunities`, 'https://login.microsoftonline.com/authorize')).toBe('foreign')
  })
})

describe('classifyAccess — the signed-in header is the proof', () => {
  it('the "<name> | Logout" header + session timer read as authenticated', () => {
    expect(classifyAccess({ url: `${BASE}/x`, title: 'Home', text: SIGNED_IN_HEADER })).toBe('authenticated')
  })
  it('the public catalog page (no header, no wall sentence) is unknown — content never proves sign-in', () => {
    expect(classifyAccess({ url: `${BASE}/CMXAdmin/Cmx_Content.aspx`, title: 'Scholarship Manager', text: PUBLIC_CMS_TEXT })).toBe('unknown')
  })
  it('an explicit wall sentence is signin_wall', () => {
    expect(classifyAccess({ url: `${BASE}/x`, title: '', text: 'Please sign in to continue.' })).toBe('signin_wall')
  })
})

describe('deriveApplicationStatus — user-record phrasing only', () => {
  it('reads "submitted" from the real award-page acknowledgement', () => {
    const got = deriveApplicationStatus(AWARD_PAGE_TEXT)
    expect(got?.status).toBe('submitted')
    expect(got?.evidence).toMatch(/thank you for your submission/i)
  })
  it('reads no_open_applications from the real My Applications copy', () => {
    const got = deriveApplicationStatus(APPLICATIONS_PAGE_TEXT)
    expect(got?.status).toBe('no_open_applications')
  })
  it('NEVER derives a status from the landing page CTA copy ("Step 1: Complete…")', () => {
    expect(deriveApplicationStatus(LANDING_CTA_TEXT)).toBeNull()
  })
})

describe('deriveQualifiedOpportunities — 0 is a real answer', () => {
  it('parses the real "Qualified Opportunities 0" header', () => {
    expect(deriveQualifiedOpportunities(MYOPPS_PAGE_TEXT)).toMatchObject({ count: 0 })
  })
  it('parses a populated count', () => {
    expect(deriveQualifiedOpportunities(`${SIGNED_IN_HEADER}Qualified Opportunities 7\nAaron & Clara Todd Pre-Dental Scholarship`)).toMatchObject({ count: 7 })
  })
  it('returns null when the page says nothing (never defaults)', () => {
    expect(deriveQualifiedOpportunities('completely unrelated text')).toBeNull()
  })
})

describe('registry resolution — the tenant trap', () => {
  it('resolves ngweb tenant hosts to this connector (MTSU and Cleveland State)', () => {
    expect(getConnectorForHost(HOST).id).toBe('ngweb_scholarship_manager')
    expect(getConnectorForHost('clevelandstatecc.scholarships.ngwebsolutions.com').id).toBe('ngweb_scholarship_manager')
  })
  it('a credential on a tenant host labelled "MTSU Scholarships" resolves HERE, never to mtsu.edu', () => {
    const got = resolveConnector({ host: HOST, username: 'anastasia@mtmail.mtsu.edu', label: 'MTSU Scholarships' })
    expect(got.id).toBe('ngweb_scholarship_manager')
  })
  it('a real mtsu.edu host still resolves to the mtsu connector', () => {
    expect(getConnectorForHost('pipelinemt.mtsu.edu').id).toBe('mtsu')
  })
  it('matchesCredential claims by tenant host only — never by label text', () => {
    expect(matchesCredential({ host: HOST })).toBe(true)
    expect(matchesCredential({ host: 'example.com', label: 'Scholarship Manager' })).toBe(false)
  })
  it('tenantSlug extracts the school from the host', () => {
    expect(tenantSlug(HOST)).toBe('mtsu')
    expect(tenantSlug('clevelandstatecc.scholarships.ngwebsolutions.com')).toBe('clevelandstatecc')
    expect(tenantSlug('unrelated.com')).toBeNull()
  })
})

describe('read() — landing honesty end to end', () => {
  /** A page that redirects every private request to the public CMS landing. */
  function makeSignedOutPage() {
    let current = { landed: `${BASE}/CMXAdmin/Cmx_Content.aspx?cpId=1276`, text: PUBLIC_CMS_TEXT, title: 'Scholarship Manager' }
    return {
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      url: () => current.landed,
      evaluate: vi.fn(async (fn) => {
        const src = String(fn)
        if (src.includes('innerText') && src.includes('length')) return current.text.length
        return { text: current.text, title: current.title }
      }),
    }
  }

  it('a dead session yields access signin_wall, zero awards, and an actionable reason', async () => {
    const page = makeSignedOutPage()
    const res = await connector.read(page, { portalHost: HOST, log: () => {} })
    expect(res.access).toBe('signin_wall')
    expect(res.awards).toHaveLength(0)
    expect(res.fields).toHaveLength(0)
    const reasons = res.notFound.map((n) => n.reason).join(' ')
    expect(reasons).toMatch(/NOT SIGNED IN/i)
    expect(reasons).not.toMatch(/no scholarships/i)
  })
})

describe('write() — signed-out safety', () => {
  it('refuses to fill anything when the portal does not serve an authenticated page', async () => {
    let landed = `${BASE}/CMXAdmin/Cmx_Content.aspx?cpId=1276`
    const page = {
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      url: () => landed,
      evaluate: vi.fn(async (fn) => {
        const src = String(fn)
        if (src.includes('length')) return PUBLIC_CMS_TEXT.length
        return { text: PUBLIC_CMS_TEXT, title: 'Scholarship Manager' }
      }),
    }
    const res = await connector.write(page, { portalHost: HOST, log: () => {} }, {
      fundingSources: [{ name: 'Coca-Cola Scholars', amount: 5000 }],
    })
    expect(res.written).toHaveLength(0)
    expect(res.skipped[0].reason).toMatch(/not signed in/i)
  })
})

describe('connector contract completeness', () => {
  it('the default export carries the merge-contract members', () => {
    expect(connector.requiresSession).toBe(true)
    expect(connector.supportsFullMerge).toBe(false)
    expect(Array.isArray(connector.requiredReadDomains)).toBe(true)
  })
  it('REGRESSION: the mtsu default export carries supportsFullMerge/requiredReadDomains (their omission made every MTSU sync un-mergeable)', () => {
    expect(mtsuConnector.supportsFullMerge).toBe(true)
    expect(Array.isArray(mtsuConnector.requiredReadDomains)).toBe(true)
    expect(mtsuConnector.requiredReadDomains.length).toBeGreaterThan(0)
  })
})
