/**
 * Cloud-login live mirror — the "disconnects when I click sign in" regression.
 *
 * ROOT CAUSE GUARDED HERE (verified live against mtsu.edu, 2026-07-31): portal
 * sign-in links routinely open the SSO login in a NEW WINDOW — MTSU's
 * "PipelineMT" opens login.microsoftonline.com as a popup. The screencast and
 * Input.* CDP sessions were bound to the ORIGINAL page, which never changes,
 * so the real login form existed invisibly server-side while the user's
 * mirror sat frozen on the opener: every click "did nothing" and signing in
 * was structurally impossible on any popup-based portal.
 *
 * THE FIX: wirePageFollow/retargetLivePage — on a context 'page' event the
 * mirror retargets the screencast to the new page over the SAME viewer
 * callback (same open SSE stream), drops the cached input CDP so input
 * re-attaches to the new page, and falls back to the most recent still-open
 * page when the popup closes (SAML popups close themselves after login).
 * Every test here fails on the pre-fix code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addSyntheticHamiltonNetworkSurface, prepareSyntheticHamiltonEgress } from './helpers/hamiltonBrowserHarness.mjs'

process.env.RUNTIME_SECRETS_KEY = 'f'.repeat(64)
process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = 'self_hosted'

const {
  startCloudLogin, startScreencast, getCloudLoginSession, dispatchInput, cancelCloudLogin,
} = await import('../services/hamilton/hamiltonCloudLogin.js')

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }

/** Fake CDP session labeled by the page it was created on. */
function makeFakeCdp(page) {
  return {
    page,
    sent: [],
    handlers: {},
    on(evt, fn) { this.handlers[evt] = fn },
    async send(method, params) {
      this.sent.push({ method, params })
      if (method === 'Page.captureScreenshot') {
        // Frame pixels identify the SOURCE PAGE so tests can assert what the
        // user is actually being shown.
        return { data: Buffer.from(page.name).toString('base64') }
      }
      return {}
    },
    detach: vi.fn(async () => {}),
  }
}

function makeFakePage(name, ctxRef) {
  const listeners = new Map()
  let closed = false
  const page = {
    name,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
    },
    emit(evt) { for (const fn of listeners.get(evt) || []) fn() },
    isClosed: () => closed,
    close() { closed = true; page.emit('close') },
    viewportSize: () => ({ width: 1280, height: 900 }),
    context: () => ctxRef.ctx,
    goto: vi.fn(async () => {}),
    url: () => `https://${name}${name === 'portal.example.edu' ? '/login' : '/'}`,
    locator: () => ({ count: async () => 0 }),
  }
  return page
}

function makeFakeWorld() {
  const ctxRef = {}
  const cdps = []
  const pageListeners = []
  const ctx = addSyntheticHamiltonNetworkSurface({
    on(evt, fn) { if (evt === 'page') pageListeners.push(fn) },
    newCDPSession: vi.fn(async (page) => {
      const cdp = makeFakeCdp(page)
      cdps.push(cdp)
      return cdp
    }),
    newPage: async () => makeFakePage('portal.example.edu', ctxRef),
    storageState: async () => ({ cookies: [{ name: 'sid', value: 'x', domain: 'portal.example.edu', path: '/' }], origins: [] }),
    opts: {},
  })
  ctxRef.ctx = ctx
  const browser = { newContext: async () => ctx, close: vi.fn(async () => {}) }
  const launchBrowser = async () => ({ browser, engine: 'fake' })
  const openPopup = (name) => {
    const popup = makeFakePage(name, ctxRef)
    for (const fn of pageListeners) fn(popup)
    return popup
  }
  return { launchBrowser, ctx, cdps, openPopup }
}

const frameSource = (frame) => Buffer.from(frame.data, 'base64').toString()

describe('the live mirror follows SSO popups', () => {
  let world
  let liveId
  let frames

  beforeEach(async () => {
    world = makeFakeWorld()
    frames = []
    const res = await startCloudLogin({
      userId: 'u1', profileId: 'pA', portalHost: 'portal.example.edu',
      loginUrl: 'https://portal.example.edu/login', label: 'Portal',
      launchBrowser: world.launchBrowser,
      prepareBrowserEgress: prepareSyntheticHamiltonEgress,
    })
    expect(res.ok).toBe(true)
    liveId = res.liveSessionId
    const stop = await startScreencast(liveId, (f) => frames.push(f))
    expect(typeof stop).toBe('function')
    await settle()
  })

  afterEach(async () => {
    if (liveId) await cancelCloudLogin(liveId)
    vi.clearAllMocks()
  })

  it('a popup opening RETARGETS the mirror: the same viewer starts receiving the popup\'s pixels', async () => {
    expect(frames.length).toBeGreaterThan(0)
    expect(frameSource(frames[frames.length - 1])).toBe('portal.example.edu')

    world.openPopup('login.microsoftonline.com')
    await settle()

    const s = getCloudLoginSession(liveId)
    expect(s.page.name).toBe('login.microsoftonline.com')
    // The SAME onFrame (same open SSE stream) now carries the popup's pixels —
    // on the pre-fix code the viewer kept mirroring the frozen opener.
    expect(frameSource(frames[frames.length - 1])).toBe('login.microsoftonline.com')
  })

  it('blocks input on an unreviewed cross-origin popup', async () => {
    world.openPopup('login.microsoftonline.com')
    await settle()

    const r = await dispatchInput(liveId, { type: 'mousedown', x: 0.5, y: 0.5, button: 0, modifiers: 0 })
    expect(r).toEqual({ ok: false, reason: 'live_page_path_not_allowed' })
    const inputSends = world.cdps.flatMap((c) =>
      c.sent.filter((m) => m.method === 'Input.dispatchMouseEvent').map(() => c.page.name))
    expect(inputSends).not.toContain('login.microsoftonline.com')
    expect(inputSends).not.toContain('portal.example.edu')
  })

  it('the OLD page\'s screencast is stopped on retarget (no zombie screencast keeps touching the session)', async () => {
    const originalCdp = world.cdps.find((c) => c.page.name === 'portal.example.edu' &&
      c.sent.some((m) => m.method === 'Page.startScreencast'))
    expect(originalCdp).toBeTruthy()

    world.openPopup('login.microsoftonline.com')
    await settle()

    expect(originalCdp.sent.some((m) => m.method === 'Page.stopScreencast')).toBe(true)
    expect(originalCdp.detach).toHaveBeenCalled()
  })

  it('when the popup CLOSES the mirror falls back to the opener (SAML popups close themselves after login)', async () => {
    const popup = world.openPopup('login.microsoftonline.com')
    await settle()
    expect(getCloudLoginSession(liveId).page.name).toBe('login.microsoftonline.com')

    const framesBefore = frames.length
    popup.close()
    await settle()

    const s = getCloudLoginSession(liveId)
    expect(s.page.name).toBe('portal.example.edu')
    expect(frames.length).toBeGreaterThan(framesBefore)
    expect(frameSource(frames[frames.length - 1])).toBe('portal.example.edu')
  })

  it('a second popup chains: the mirror follows the NEWEST page', async () => {
    world.openPopup('login.microsoftonline.com')
    await settle()
    world.openPopup('duo.mtsu.edu')
    await settle()
    expect(getCloudLoginSession(liveId).page.name).toBe('duo.mtsu.edu')
  })
})
