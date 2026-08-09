/**
 * SSRF regression tests for the shared axios client (`services/shared/httpClient.js`).
 *
 * This module was an unguarded outbound egress path. `headForVerification` is
 * reached from `opportunityInserter`, the canonical ingest gate that
 * liveness-checks every crawled / LLM-extracted opportunity URL. It ran a bare
 * axios HEAD with `maxRedirects: 5` and returned both `status` and the
 * post-redirect `finalUrl`, which is a semi-blind SSRF probe for anyone who
 * can get a URL into the catalog.
 *
 * The two load-bearing tests here pull in OPPOSITE directions, and that is the
 * point:
 *
 *   - "blocks a redirect into cloud metadata" fails against validate-then-follow.
 *   - "still reaches a loopback host when ssrfSafe is not set" fails against a
 *     BLANKET guard. SearXNG's documented default is
 *     `SEARXNG_URL=http://127.0.0.1:8080`, so guarding this module globally
 *     would classify our own search backend as an attack and blackhole web
 *     search — a "fix" that breaks the product.
 *
 * Only a targeted, opt-in guard passes both. All hosts are IP literals, so
 * assertSsrfSafeUrl short-circuits before DNS: these tests are hermetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('axios', () => ({
  default: { request: vi.fn() },
}))

import axios from 'axios'
import { getWithRetry, headForVerification } from '../services/shared/httpClient.js'

// 93.184.216.34 is public (example.com); isPrivateIp() returns false for it.
const PUBLIC_URL = 'http://93.184.216.34/opportunity'
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/'
const INTERNAL_URL = 'http://10.0.0.5/internal'
const SEARXNG_URL = 'http://127.0.0.1:8080/search?q=grants'

beforeEach(() => {
  axios.request.mockReset()
})

describe('headForVerification — always guarded', () => {
  it('refuses a direct probe of cloud metadata without touching the network', async () => {
    const res = await headForVerification(METADATA_URL)

    expect(res.ok).toBe(false)
    expect(res.blocked).toBe(true)
    expect(axios.request).not.toHaveBeenCalled()
  })

  it('refuses an RFC1918 host', async () => {
    const res = await headForVerification(INTERNAL_URL)

    expect(res.ok).toBe(false)
    expect(res.blocked).toBe(true)
    expect(axios.request).not.toHaveBeenCalled()
  })

  it('blocks a redirect into cloud metadata (the validate-then-follow bypass)', async () => {
    // The first hop is a clean public host; the SECOND is metadata. A guard
    // that only clears the initial URL lets this through.
    axios.request.mockResolvedValueOnce({
      status: 302,
      headers: { location: METADATA_URL },
      data: '',
    })

    const res = await headForVerification(PUBLIC_URL)

    expect(res.ok).toBe(false)
    expect(res.blocked).toBe(true)
    // The redirect target was never requested.
    expect(axios.request).toHaveBeenCalledTimes(1)
    expect(axios.request.mock.calls[0][0].url).toBe(PUBLIC_URL)
    expect(axios.request.mock.calls[0][0].maxRedirects).toBe(0)
  })

  it('reports a blocked URL as BLOCKED, not as a dead link', async () => {
    const res = await headForVerification(METADATA_URL)

    // "we refused to look" must stay distinguishable from "we looked and it
    // was dead" — only the latter is evidence about the funder's page.
    expect(res.blocked).toBe(true)
    expect(res.status).toBeNull()
    expect(res.reason).toBeTruthy()
  })

  it('still verifies a healthy public URL', async () => {
    axios.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: '',
    })

    const res = await headForVerification(PUBLIC_URL)

    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(res.blocked).toBe(false)
    expect(res.finalUrl).toBe(PUBLIC_URL)
  })
})

describe('getWithRetry — opt-in guard', () => {
  it('refuses an untrusted metadata URL when ssrfSafe is set', async () => {
    await expect(
      getWithRetry(METADATA_URL, {}, { ssrfSafe: true, retries: 0 }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })

    expect(axios.request).not.toHaveBeenCalled()
  })

  it('re-validates each redirect hop when ssrfSafe is set', async () => {
    // maxRedirects:0 means axios hands us the 302 and we follow it ourselves.
    axios.request.mockResolvedValueOnce({
      status: 302,
      headers: { location: METADATA_URL },
      data: '',
    })

    await expect(
      getWithRetry(PUBLIC_URL, {}, { ssrfSafe: true, retries: 0 }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })

    // It made the first request, then refused to follow into metadata.
    expect(axios.request).toHaveBeenCalledTimes(1)
  })

  it('never retries an SSRF refusal', async () => {
    // A policy refusal is not a transient network blip; retrying it would just
    // re-issue the same blocked request and muddy the telemetry.
    await expect(
      getWithRetry(METADATA_URL, {}, { ssrfSafe: true, retries: 3 }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })

    expect(axios.request).not.toHaveBeenCalled()
  })

  it('still reaches a loopback host when ssrfSafe is NOT set (SearXNG must keep working)', async () => {
    // SEARXNG_URL defaults to http://127.0.0.1:8080. A blanket guard on this
    // module would block our own search backend. This test is what stops a
    // future "harden everything" pass from silently killing web search.
    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: { results: [] } })

    const res = await getWithRetry(SEARXNG_URL)

    expect(res.status).toBe(200)
    expect(axios.request).toHaveBeenCalledTimes(1)
  })

  it('leaves hardcoded first-party API hosts unguarded by default', async () => {
    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: {} })

    await getWithRetry('http://10.0.0.5/internal-api')

    // No ssrfSafe → no guard → the request goes out. Trusted internal callers
    // (grants.gov client, Google CSE, SearXNG) rely on this.
    expect(axios.request).toHaveBeenCalledTimes(1)
  })
})
