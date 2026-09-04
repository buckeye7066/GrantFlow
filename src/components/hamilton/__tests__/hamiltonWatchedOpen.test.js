/**
 * openWithHamiltonWatching — the ONE way profile surfaces open a portal /
 * application URL. Guards the controlled-beta manual-browser boundary:
 *
 *   1. The secure popup is claimed SYNCHRONOUSLY (before the async cloud-login
 *      start), else popup blockers kill it.
 *   2. Success navigates the popup to the same-origin /HamiltonLiveLogin view.
 *   3. A failed synthetic cloud-login start degrades to the fixture URL in the SAME
 *      popup (never a dead window) and reports watched:false honestly.
 *   4. No profileId → plain window.open fallback (nothing to bind a session to).
 *   5. Non-http(s) URLs are refused outright.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/env.js', () => ({ env: { appBase: '/' } }))

// hamiltonWatchedOpen reports guided-tour step completion (a no-op outside
// an active tour) via useGuidedTourStore, which transitively imports
// authStore -> the real @/api/client -- irrelevant to what this file tests,
// so it's mocked directly rather than deepening the env.js mock above.
vi.mock('@/stores/guidedTourStore', () => ({
  useGuidedTourStore: { getState: () => ({ reportCompletion: vi.fn() }) },
}))

const startCloudLogin = vi.fn()
vi.mock('@/api/hamilton', () => ({
  startCloudLogin: (...args) => startCloudLogin(...args),
}))

const popup = { blocked: false, navigate: vi.fn(), fail: vi.fn(), close: vi.fn() }
const openPendingLoginWindow = vi.fn(() => popup)
vi.mock('@/components/hamilton/liveLoginWindow', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    openPendingLoginWindow: (...args) => openPendingLoginWindow(...args),
  }
})

import { canHamiltonWatch, openWithHamiltonWatching } from '@/components/hamilton/hamiltonWatchedOpen'

describe('openWithHamiltonWatching', () => {
  beforeEach(() => {
    popup.blocked = false
    global.window = {
      location: { origin: 'https://app.axiombiolabs.org' },
      open: vi.fn(),
    }
  })
  afterEach(() => {
    delete global.window
    vi.clearAllMocks()
  })

  it('keeps the watched path testable only on the reserved synthetic fixture', async () => {
    let popupOpenedFirst = false
    startCloudLogin.mockImplementation(async () => {
      // By the time the async start runs, the popup must already be claimed.
      popupOpenedFirst = openPendingLoginWindow.mock.calls.length === 1
      return { liveSessionId: 'cl_1', portalHost: 'hamilton-submit-fixture.invalid' }
    })

    const res = await openWithHamiltonWatching({
      profileId: 'p1',
      url: 'https://hamilton-submit-fixture.invalid/application',
      label: 'Synthetic fixture',
    })

    expect(popupOpenedFirst).toBe(true)
    expect(startCloudLogin).toHaveBeenCalledWith('p1', {
      portalHost: 'hamilton-submit-fixture.invalid',
      loginUrl: 'https://hamilton-submit-fixture.invalid/application',
      label: 'Synthetic fixture',
    })
    expect(popup.navigate).toHaveBeenCalledWith(
      'https://app.axiombiolabs.org/HamiltonLiveLogin?session=cl_1&host=hamilton-submit-fixture.invalid',
    )
    expect(res).toEqual({ opened: true, watched: true, blocked: false })
  })

  it('routes a real portal through cloud login and the watched popup', async () => {
    startCloudLogin.mockResolvedValueOnce({ liveSessionId: 'cl_real', portalHost: 'example.org' })
    const res = await openWithHamiltonWatching({ profileId: 'p1', url: 'https://example.org/apply' })
    expect(window.open).not.toHaveBeenCalled()
    expect(startCloudLogin).toHaveBeenCalledWith('p1', {
      portalHost: 'example.org', loginUrl: 'https://example.org/apply', label: 'example.org',
    })
    expect(popup.navigate).toHaveBeenCalledWith(
      'https://app.axiombiolabs.org/HamiltonLiveLogin?session=cl_real&host=example.org',
    )
    expect(res).toEqual({ opened: true, watched: true, blocked: false })
  })

  it('reports blocked (and opens nothing else) when the popup is refused', async () => {
    openPendingLoginWindow.mockReturnValueOnce({ ...popup, blocked: true })
    const res = await openWithHamiltonWatching({ profileId: 'p1', url: 'https://hamilton-submit-fixture.invalid/login' })
    expect(startCloudLogin).not.toHaveBeenCalled()
    expect(res).toEqual({ opened: false, watched: false, blocked: true })
  })

  it('falls back to a plain window.open without a profileId', async () => {
    const res = await openWithHamiltonWatching({ url: 'https://example.org/apply' })
    expect(window.open).toHaveBeenCalledWith('https://example.org/apply', '_blank', 'noopener,noreferrer')
    expect(startCloudLogin).not.toHaveBeenCalled()
    expect(res).toEqual({ opened: true, watched: false, blocked: false })
  })

  it('refuses non-http(s) URLs outright', async () => {
    const res = await openWithHamiltonWatching({ profileId: 'p1', url: 'javascript' + ':alert(1)' })
    expect(window.open).not.toHaveBeenCalled()
    expect(openPendingLoginWindow).not.toHaveBeenCalled()
    expect(res).toEqual({ opened: false, watched: false, blocked: false })
  })

  it('canHamiltonWatch requires a profileId and a valid http(s) URL', () => {
    expect(canHamiltonWatch({ profileId: 'p1', url: 'https://hamilton-submit-fixture.invalid/apply' })).toBe(true)
    expect(canHamiltonWatch({ profileId: 'p1', url: 'https://a.org' })).toBe(true)
    expect(canHamiltonWatch({ url: 'https://a.org' })).toBe(false)
    expect(canHamiltonWatch({ profileId: 'p1', url: 'ftp://a.org' })).toBe(false)
  })
})
