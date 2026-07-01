/**
 * resolveLiveLoginUrl must anchor the Hamilton live-login popup to THIS app's
 * origin — never the backend-supplied liveUrl origin.
 *
 * Regression for `stream_http_401`: the backend builds liveUrl from
 * req.get('host'), which behind the Vercel→Railway proxy is the API/proxy host.
 * Opening the popup there (a different origin) gives it an empty localStorage
 * with no GrantFlow session, so the live-view SSE stream 401s instantly. The URL
 * must be same-origin AND absolute (the popup starts on about:blank).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// env.appBase drives any base-path prefix; default to '/' (no prefix) here.
vi.mock('@/config/env.js', () => ({ env: { appBase: '/' } }))

import { resolveLiveLoginUrl } from '@/components/hamilton/liveLoginWindow'

describe('resolveLiveLoginUrl', () => {
  beforeEach(() => {
    global.window = { location: { origin: 'https://app.axiombiolabs.org' } }
  })
  afterEach(() => {
    delete global.window
    vi.restoreAllMocks()
  })

  it('ignores a cross-origin backend liveUrl and uses window.location.origin', () => {
    const url = resolveLiveLoginUrl({
      liveSessionId: 'cl_abc123',
      portalHost: '211.org',
      // Backend handed us the WRONG origin (the API/proxy host).
      liveUrl: 'https://grantflow-api.up.railway.app/HamiltonLiveLogin?session=cl_abc123&host=211.org',
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://app.axiombiolabs.org')
    expect(parsed.pathname).toBe('/HamiltonLiveLogin')
    expect(parsed.searchParams.get('session')).toBe('cl_abc123')
    expect(parsed.searchParams.get('host')).toBe('211.org')
  })

  it('builds a same-origin absolute URL from just a session id', () => {
    const url = resolveLiveLoginUrl({ liveSessionId: 'cl_xyz', portalHost: 'studentaid.gov' })
    expect(url).toBe(
      'https://app.axiombiolabs.org/HamiltonLiveLogin?session=cl_xyz&host=studentaid.gov',
    )
  })

  it('accepts the `id` alias for the session id', () => {
    const url = resolveLiveLoginUrl({ id: 'cl_alias' })
    expect(new URL(url).searchParams.get('session')).toBe('cl_alias')
  })

  it('returns null when there is no session id and no fallback', () => {
    expect(resolveLiveLoginUrl({})).toBeNull()
    expect(resolveLiveLoginUrl(null)).toBeNull()
  })
})
