// @vitest-environment jsdom
/**
 * "Let the work Hamilton is doing, once automation begins, pop open in its own
 * window — and the user can watch if they choose to." (owner, 2026-08-21)
 *
 * Two things have to be true for that to be real rather than decorative:
 *
 *  1. The window must open INSIDE the click gesture. `beginHamiltonAutomation`
 *     awaits a POST that launches a real browser and can take seconds; a
 *     window.open in the mutation's onSuccess is no longer user-initiated and
 *     browsers block it. liveLoginWindow.js already learned this the hard way —
 *     the old cloud-login popup either got blocked (and the code falsely toasted
 *     "opened") or opened a dead about:blank. Same rule here.
 *
 *  2. Watching is OPTIONAL, so a blocked popup must never stop the run. The work
 *     is the point; the window is a courtesy. A browser that refuses the popup
 *     gets a truthful toast, not a failed automation.
 *
 * And the window must never be a dead end: if the start call fails, the SAME
 * window says why instead of spinning on "Preparing…" forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAutomationWatchUrl } from '../automationWatchWindow.js'

describe('resolveAutomationWatchUrl', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds a SAME-ORIGIN absolute URL for the watch page', () => {
    const url = resolveAutomationWatchUrl('profile-42')
    // Absolute: the popup starts on about:blank, so a relative href would not
    // resolve when passed to location.replace().
    const parsed = new URL(url)
    expect(parsed.origin).toBe(window.location.origin)
    expect(parsed.pathname).toBe('/HamiltonAutomationWatch')
    expect(parsed.searchParams.get('profile')).toBe('profile-42')
  })

  it('encodes a profile id that would otherwise break the query string', () => {
    const url = resolveAutomationWatchUrl('a b&c=d')
    expect(new URL(url).searchParams.get('profile')).toBe('a b&c=d')
  })

  it('refuses to build a link with no profile — a watch window with nothing to watch', () => {
    expect(resolveAutomationWatchUrl('')).toBeNull()
    expect(resolveAutomationWatchUrl(null)).toBeNull()
    expect(resolveAutomationWatchUrl(undefined)).toBeNull()
  })
})
