/**
 * Cross-window token-refresh coherence.
 *
 * Regression for the Hamilton live-login `stream_http_401` bug: the live-login
 * popup is a SEPARATE window with its own APIClient but SHARED localStorage.
 * The refresh token is single-use (server rotates it on every /auth/refresh), so
 * two windows must not clobber each other:
 *   - reads must prefer the shared localStorage value (never a stale in-memory
 *     token another window already rotated), and
 *   - a lost refresh race must ADOPT the peer's freshly-stored token instead of
 *     clearing the shared session (which logged both windows out + 401'd the
 *     SSE stream).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import client from '@/api/client'

// Minimal in-memory localStorage that mirrors the browser contract.
function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => store.clear(),
    _store: store,
  }
}

const AKEY = 'grantflow:access-token'
const RKEY = 'grantflow:refresh-token'
const EKEY = 'grantflow:access-expiry'

describe('APIClient cross-window token refresh', () => {
  let ls
  beforeEach(() => {
    ls = makeLocalStorage()
    global.localStorage = ls
    global.window = { localStorage: ls, addEventListener: () => {} }
    // Node's global `navigator` has no `.locks`, so refreshTokens() exercises the
    // unlocked fallback path here (Web Locks are covered in real browsers).
    client.token = null
    client.refreshToken = null
    client.refreshPromise = null
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete global.fetch
    delete global.window
    delete global.localStorage
  })

  it('reads the fresh localStorage token even when in-memory is stale', () => {
    client.token = 'AT_STALE'
    client.refreshToken = 'RT_STALE'
    ls.setItem(AKEY, 'AT_FRESH')
    ls.setItem(RKEY, 'RT_FRESH')
    expect(client.getToken()).toBe('AT_FRESH')
    expect(client.getRefreshToken()).toBe('RT_FRESH')
  })

  it('adopts a peer-rotated token instead of refreshing again', async () => {
    // A peer window rotated after we snapshotted `expected`.
    ls.setItem(AKEY, 'AT_NEW')
    ls.setItem(RKEY, 'RT_NEW')
    ls.setItem(EKEY, String(Date.now() + 600_000))
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy

    const result = await client._refreshTokenNetwork('RT_OLD')

    expect(fetchSpy).not.toHaveBeenCalled() // never hit the network
    expect(result.adoptedFromPeer).toBe(true)
    expect(result.accessToken).toBe('AT_NEW')
    expect(result.refreshToken).toBe('RT_NEW')
    expect(Number.isFinite(result.accessExpires)).toBe(true)
  })

  it('adopts on a 401 when a peer stored a newer token mid-flight', async () => {
    ls.setItem(AKEY, 'AT1')
    ls.setItem(RKEY, 'RT1')
    // The refresh 401s (our token was consumed) but a peer already wrote RT2.
    global.fetch = vi.fn(async () => {
      ls.setItem(AKEY, 'AT2')
      ls.setItem(RKEY, 'RT2')
      return { ok: false, status: 401, json: async () => ({ error: 'invalid' }) }
    })

    const result = await client._refreshTokenNetwork('RT1')

    expect(result.adoptedFromPeer).toBe(true)
    expect(result.refreshToken).toBe('RT2')
    // Shared auth must NOT be cleared.
    expect(ls.getItem(RKEY)).toBe('RT2')
  })

  it('clears tokens on a genuinely dead refresh token (no peer)', async () => {
    ls.setItem(AKEY, 'ATx')
    ls.setItem(RKEY, 'RTx')
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid' }) }))

    await expect(client._refreshTokenNetwork('RTx')).rejects.toThrow()
    expect(ls.getItem(AKEY)).toBeNull()
    expect(ls.getItem(RKEY)).toBeNull()
  })

  it('does NOT clear tokens on a transient (non-401) failure', async () => {
    ls.setItem(AKEY, 'ATok')
    ls.setItem(RKEY, 'RTok')
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }))

    await expect(client._refreshTokenNetwork('RTok')).rejects.toThrow()
    // A backend blip must not log the user out.
    expect(ls.getItem(AKEY)).toBe('ATok')
    expect(ls.getItem(RKEY)).toBe('RTok')
  })

  it('stores rotated tokens on a successful refresh', async () => {
    ls.setItem(RKEY, 'RTold')
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'ATnew', refreshToken: 'RTnew' }),
    }))

    const result = await client._refreshTokenNetwork('RTold')

    expect(result.accessToken).toBe('ATnew')
    expect(ls.getItem(AKEY)).toBe('ATnew')
    expect(ls.getItem(RKEY)).toBe('RTnew')
  })
})
