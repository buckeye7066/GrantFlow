/**
 * HttpOnly-cookie session refresh.
 *
 * Access tokens are process-memory-only; refresh tokens are never visible to
 * JavaScript. Web Locks serialize tabs, while the backend's 409 contract gives
 * browsers without Web Locks one bounded retry after a rotation race.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import client from '@/api/client'

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: vi.fn((key) => (store.has(key) ? store.get(key) : null)),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
    removeItem: vi.fn((key) => store.delete(key)),
  }
}

describe('APIClient HttpOnly-cookie refresh', () => {
  let storage

  beforeEach(() => {
    storage = makeLocalStorage()
    global.localStorage = storage
    global.window = { localStorage: storage }
    client.token = null
    client.refreshPromise = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete global.fetch
    delete global.window
    delete global.localStorage
  })

  it('keeps access tokens in memory and never reads or writes token storage keys', () => {
    client.setToken('AT_MEMORY')

    expect(client.getToken()).toBe('AT_MEMORY')
    expect(client.getRefreshToken()).toBeNull()
    expect(storage.getItem).not.toHaveBeenCalledWith('grantflow:access-token')
    expect(storage.getItem).not.toHaveBeenCalledWith('grantflow:refresh-token')
    expect(storage.setItem).not.toHaveBeenCalledWith('grantflow:access-token', expect.anything())
    expect(storage.setItem).not.toHaveBeenCalledWith('grantflow:refresh-token', expect.anything())
  })

  it('refreshes with credentials include and an empty body, then stores only the access token in memory', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'AT_NEW', expiresIn: 600 }),
    }))

    const result = await client._refreshTokenNetwork()

    expect(result.accessToken).toBe('AT_NEW')
    expect(client.getToken()).toBe('AT_NEW')
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/refresh'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: '{}',
        headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
      }),
    )
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('retries one refresh-rotation conflict without clearing the current access token', async () => {
    client.setToken('AT_CURRENT')
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'refresh_in_progress', retryable: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ accessToken: 'AT_AFTER_RACE' }),
      })

    const result = await client._refreshTokenNetwork()

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(result.accessToken).toBe('AT_AFTER_RACE')
    expect(client.getToken()).toBe('AT_AFTER_RACE')
  })

  it('single-flights concurrent refresh requests inside one tab', async () => {
    let releaseRefresh
    const pendingRefresh = new Promise((resolve) => {
      releaseRefresh = resolve
    })
    const runSpy = vi.spyOn(client, '_runRefresh').mockReturnValue(pendingRefresh)

    const first = client.refreshTokens()
    const second = client.refreshTokens()
    releaseRefresh({ accessToken: 'AT_SINGLE_FLIGHT' })

    await expect(first).resolves.toEqual({ accessToken: 'AT_SINGLE_FLIGHT' })
    await expect(second).resolves.toEqual({ accessToken: 'AT_SINGLE_FLIGHT' })
    expect(runSpy).toHaveBeenCalledTimes(1)
  })

  it('uses a named Web Lock to serialize refresh rotation across tabs', async () => {
    const request = vi.fn(async (name, callback) => callback())
    vi.stubGlobal('navigator', { locks: { request } })
    const networkSpy = vi
      .spyOn(client, '_refreshTokenNetwork')
      .mockResolvedValue({ accessToken: 'AT_LOCKED' })

    await expect(client._runRefresh()).resolves.toEqual({ accessToken: 'AT_LOCKED' })

    expect(request).toHaveBeenCalledWith('grantflow:auth-refresh', expect.any(Function))
    expect(networkSpy).toHaveBeenCalledTimes(1)
  })

  it('clears memory and legacy token keys after a genuinely dead refresh cookie', async () => {
    client.setToken('AT_DEAD')
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'refresh_token_reuse_detected' }),
    }))

    await expect(client._refreshTokenNetwork()).rejects.toThrow('refresh_token_reuse_detected')
    expect(client.getToken()).toBeNull()
    expect(storage.removeItem).toHaveBeenCalledWith('grantflow:access-token')
    expect(storage.removeItem).toHaveBeenCalledWith('grantflow:refresh-token')
  })

  it('does not clear the in-memory token on a transient backend failure', async () => {
    client.setToken('AT_CURRENT')
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    }))

    await expect(client._refreshTokenNetwork()).rejects.toThrow('unavailable')
    expect(client.getToken()).toBe('AT_CURRENT')
  })

  it('bootstraps a reloaded session from the cookie before requesting identity', async () => {
    const refreshSpy = vi.spyOn(client, 'refreshTokens').mockImplementation(async () => {
      client.setToken('AT_BOOTSTRAP')
      return { accessToken: 'AT_BOOTSTRAP' }
    })
    const fetchSpy = vi.spyOn(client, 'fetch').mockResolvedValue({ user: { id: 'user-1' } })

    const result = await client.auth.me()

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/me')
    expect(result.user.id).toBe('user-1')
  })
})
