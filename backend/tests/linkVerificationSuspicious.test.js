import { describe, expect, it } from 'vitest'
import { classifySuccessfulProbe, checkUrl } from '../services/linkVerificationService.js'

/**
 * Epic slice 2: a 200 must not read as unconditional proof the PROGRAM page
 * is alive. The one structural signal available without reading a body is
 * where the redirect chain SETTLED — landing on a DIFFERENT registrable
 * host's homepage is the parked-domain / program-retired signature.
 * Everything else stays 'ok' (conservative: silence is not a denial).
 */
describe('classifySuccessfulProbe', () => {
  it('flags a cross-host redirect that settles on the other host\'s homepage', () => {
    expect(
      classifySuccessfulProbe('https://grants.example.org/programs/roof-repair', 'https://parked-domains.com/'),
    ).toMatch(/redirected_off_host_to_homepage:parked-domains\.com/)
  })

  it('flags a cross-host redirect to a one-segment vanity path (still homepage-ish)', () => {
    expect(
      classifySuccessfulProbe('https://fund.example.org/apply', 'https://other-funder.com/home'),
    ).toMatch(/redirected_off_host_to_homepage/)
  })

  it('does NOT flag a same-site redirect (www / trailing slash)', () => {
    expect(classifySuccessfulProbe('https://example.org/apply', 'https://www.example.org/')).toBeNull()
  })

  it('does NOT flag a cross-host redirect to a DEEP program path (program moved)', () => {
    expect(
      classifySuccessfulProbe('https://oldfunder.org/grant', 'https://newfunder.org/programs/2026/grant-cycle'),
    ).toBeNull()
  })

  it('does NOT flag when the final URL carries a query string (an app surface, not a homepage)', () => {
    expect(
      classifySuccessfulProbe('https://a.org/apply', 'https://portal.example.com/login?returnTo=apply'),
    ).toBeNull()
  })

  it('treats an unlisted two-part suffix conservatively (never flags on suffix ambiguity)', () => {
    expect(
      classifySuccessfulProbe('https://fund.example.co.uk/apply', 'https://other.example.co.uk/'),
    ).toBeNull()
  })

  it('does NOT flag when there is no final URL to compare (HEAD with no redirect info)', () => {
    expect(classifySuccessfulProbe('https://example.org/apply', null)).toBeNull()
    expect(classifySuccessfulProbe('https://example.org/apply', '')).toBeNull()
  })

  it('never throws on malformed input', () => {
    expect(classifySuccessfulProbe('not a url', 'also not a url')).toBeNull()
  })
})

describe('checkUrl suspicious verdict', () => {
  // safeFetch performs redirect-following itself (re-validating every hop) and
  // stamps grantflowFinalUrl from the chain it actually walked — so the mock
  // must SERVE a redirect, not claim one. Public-IP hosts clear the SSRF DNS
  // gate without network flakiness (the linkVerificationQuarantine strategy).
  const redirectingFetch = (redirectTo) => async (target) => {
    const url = String(target)
    if (redirectTo && !url.startsWith(redirectTo)) {
      return new Response(null, { status: 302, headers: { location: redirectTo } })
    }
    return new Response(null, { status: 200 })
  }

  it('returns status "suspicious" (not ok) when a 200 settled on a foreign homepage', async () => {
    const result = await checkUrl('https://8.8.8.8/programs/roof-repair', {
      fetchImpl: redirectingFetch('https://9.9.9.9/'),
    })
    expect(result.status).toBe('suspicious')
    expect(result.code).toBe(200)
    expect(result.error).toMatch(/redirected_off_host_to_homepage/)
  })

  it('still returns "ok" for a 200 that stayed on the requested site', async () => {
    const result = await checkUrl('https://8.8.8.8/programs/roof-repair', {
      fetchImpl: redirectingFetch(null),
    })
    expect(result.status).toBe('ok')
  })
})
