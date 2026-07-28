/**
 * Cloud-login LIVE-VIEW lifecycle — the "portal looks alive but nothing I click
 * works" report (2026-07-27).
 *
 * Two structural defects are guarded here (both reproduced end-to-end against
 * the real stack before the fix):
 *
 *  1. IMMORTAL "Live" OVER A DEAD SESSION: tearing a session down (complete /
 *     cancel / TTL sweep) never told the attached viewer. The SSE stream stayed
 *     open on 15s heartbeats, the window kept reading "Live" over the last
 *     painted frame, and every input POST 404'd — silently, forever. Teardown
 *     must NOTIFY registered viewers so the route can end the stream with a
 *     terminal event.
 *
 *  2. A DEAD CACHED INPUT CDP SESSION WAS PERMANENT: dispatchInput cached its
 *     Input.* CDP session forever; once that handle died under the page, every
 *     subsequent event failed with dispatch_failed while the screencast kept
 *     streaming — clicks permanently disconnected from a live page. One failed
 *     send must reattach and retry once. A rejecting CDP factory must also
 *     yield an honest { ok:false }, never a throw (a throw 500s the route).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = 'self_hosted'

const {
  startCloudLogin,
  cancelCloudLogin,
  completeCloudLogin,
  captureCloudLoginState,
  releaseCloudLoginCompletion,
  finalizeCloudLogin,
  registerCloudLoginViewer,
  dispatchInput,
} = await import('../services/hamilton/hamiltonCloudLogin.js')

function makeFakeCdp({ failWith = null } = {}) {
  const sent = []
  return {
    sent,
    send: vi.fn(async (method, params) => {
      if (failWith) throw new Error(failWith)
      sent.push({ method, params })
      return {}
    }),
    detach: vi.fn(async () => {}),
    on: () => {},
  }
}

/**
 * Injected launcher (the hamiltonCloudLoginSessionSeed convention), extended
 * with a context().newCDPSession page surface so dispatchInput is exercisable.
 * `cdpSessions` is consumed in order; when exhausted the last entry repeats.
 * Pass a function entry to make newCDPSession reject.
 */
function makeFakeLaunch({
  cdpSessions = [makeFakeCdp()],
  // Visible password-input count reported by page.locator('input[type=password]:visible')
  // — null omits the locator surface entirely (a page we "cannot read": the
  // heuristic must NOT block on it).
  passwordFieldCount = null,
  // Override what context.storageState() captures (e.g. {} for empty_session).
  captureState = undefined,
} = {}) {
  let cdpIndex = 0
  const newCDPSession = vi.fn(async () => {
    const entry = cdpSessions[Math.min(cdpIndex, cdpSessions.length - 1)]
    cdpIndex += 1
    if (typeof entry === 'function') return entry()
    return entry
  })
  const storageState = vi.fn()
  const newContext = vi.fn(async (opts = {}) => {
    storageState.mockImplementation(async () => (
      captureState !== undefined
        ? captureState
        : (opts.storageState || { cookies: [{ name: 'csrf', value: 'x', domain: 'mtsu.edu', path: '/' }], origins: [] })
    ))
    const ctx = {
      opts,
      newCDPSession,
      newPage: async () => ({
        goto: vi.fn(async () => {}),
        url: () => 'https://mtsu.edu/landing',
        viewportSize: () => ({ width: 1280, height: 900 }),
        context: () => ctx,
        ...(passwordFieldCount === null ? {} : {
          locator: (selector) => ({
            count: async () => (String(selector).includes('password') ? passwordFieldCount : 0),
          }),
        }),
      }),
      storageState,
    }
    return ctx
  })
  const browser = { newContext, close: vi.fn(async () => {}) }
  const launchBrowser = vi.fn(async () => ({ browser, engine: 'fake' }))
  return { launchBrowser, newCDPSession, browser, storageState }
}

let liveIds = []
async function startLive(launchBrowser) {
  const res = await startCloudLogin({
    userId: 'u1',
    profileId: 'pA',
    portalHost: 'mtsu.edu',
    loginUrl: 'https://mtsu.edu/login',
    label: 'MTSU',
    db: null,
    launchBrowser,
  })
  expect(res.ok).toBe(true)
  liveIds.push(res.liveSessionId)
  return res.liveSessionId
}

beforeEach(() => { liveIds = [] })
afterEach(async () => {
  for (const id of liveIds) await cancelCloudLogin(id)
  vi.clearAllMocks()
})

describe('session teardown ends the live view (no immortal "Live")', () => {
  it('cancel NOTIFIES the registered viewer with session_closed', async () => {
    const { launchBrowser } = makeFakeLaunch()
    const id = await startLive(launchBrowser)

    const notify = vi.fn()
    registerCloudLoginViewer(id, notify)

    await cancelCloudLogin(id)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('session_closed')
  })

  it('complete ("Done") also notifies the viewer, and an unregistered viewer is not called', async () => {
    const { launchBrowser } = makeFakeLaunch()
    const id = await startLive(launchBrowser)

    const kept = vi.fn()
    const removed = vi.fn()
    registerCloudLoginViewer(id, kept)
    const unregister = registerCloudLoginViewer(id, removed)
    unregister()

    const captured = await completeCloudLogin(id)
    expect(captured.ok).toBe(true)

    expect(kept).toHaveBeenCalledWith('session_closed')
    expect(removed).not.toHaveBeenCalled()
  })

  it('registering on a gone session is a safe no-op', async () => {
    const unregister = registerCloudLoginViewer('cl_never_existed', vi.fn())
    expect(typeof unregister).toBe('function')
    expect(() => unregister()).not.toThrow()
  })

  it('the stream route wires the viewer registration (source tripwire)', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = await readFile(path.join(here, '..', 'routes', 'hamiltonAutomation.js'), 'utf8')
    const startIdx = src.indexOf("'/sessions/cloud-login/:liveSessionId/stream'")
    const endIdx = src.indexOf("'/sessions/cloud-login/:liveSessionId/input'")
    expect(startIdx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(startIdx)
    const handler = src.slice(startIdx, endIdx)
    // The SSE handler must register for teardown and surface it as a terminal
    // SSE error event — otherwise a dead session streams heartbeats forever.
    expect(handler).toContain('registerCloudLoginViewer(')
    expect(handler).toContain('event: error')
  })
})

describe('dispatchInput input-channel lifecycle', () => {
  it('recovers from a DEAD cached CDP session: reattaches once and the click still lands', async () => {
    const deadCdp = makeFakeCdp({ failWith: 'Target page, context or browser has been closed' })
    const freshCdp = makeFakeCdp()
    const { launchBrowser } = makeFakeLaunch({ cdpSessions: [deadCdp, freshCdp] })
    const id = await startLive(launchBrowser)

    const out = await dispatchInput(id, { type: 'click', x: 0.5, y: 0.5, button: 0 })

    // OLD behavior: { ok:false, reason:'dispatch_failed' } and every later
    // event kept failing on the same cached dead handle.
    expect(out).toEqual({ ok: true })
    const methods = freshCdp.sent.map((s) => s.method)
    expect(methods).toEqual([
      'Input.dispatchMouseEvent', // move
      'Input.dispatchMouseEvent', // press
      'Input.dispatchMouseEvent', // release
    ])
    // The dead handle was dropped, not kept for the next event.
    const again = await dispatchInput(id, { type: 'keydown', key: 'a', code: 'KeyA', keyCode: 65 })
    expect(again).toEqual({ ok: true })
    expect(freshCdp.sent.some((s) => s.method === 'Input.dispatchKeyEvent')).toBe(true)
  })

  it('still scales coordinates correctly after the reattach (0.5,0.5 of 1280x900 → 640,450)', async () => {
    const deadCdp = makeFakeCdp({ failWith: 'Session closed' })
    const freshCdp = makeFakeCdp()
    const { launchBrowser } = makeFakeLaunch({ cdpSessions: [deadCdp, freshCdp] })
    const id = await startLive(launchBrowser)

    await dispatchInput(id, { type: 'mousedown', x: 0.5, y: 0.5, button: 0 })
    expect(freshCdp.sent[0].params).toMatchObject({ type: 'mousePressed', x: 640, y: 450 })
  })

  it('a CDP factory that REJECTS yields an honest { ok:false }, never a throw', async () => {
    const { launchBrowser } = makeFakeLaunch({
      cdpSessions: [() => { throw new Error('newCDPSession exploded') }],
    })
    const id = await startLive(launchBrowser)

    // OLD behavior: the rejection escaped dispatchInput entirely and the input
    // route 500'd through the express error handler.
    await expect(
      dispatchInput(id, { type: 'click', x: 0.1, y: 0.1, button: 0 }),
    ).resolves.toMatchObject({ ok: false, reason: 'dispatch_failed' })
  })

  it('a genuinely broken retry still reports dispatch_failed (bounded to ONE reattach)', async () => {
    const dead1 = makeFakeCdp({ failWith: 'Session closed' })
    const dead2 = makeFakeCdp({ failWith: 'Session closed' })
    const { launchBrowser, newCDPSession } = makeFakeLaunch({ cdpSessions: [dead1, dead2, dead2] })
    const id = await startLive(launchBrowser)

    const out = await dispatchInput(id, { type: 'click', x: 0.5, y: 0.5, button: 0 })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('dispatch_failed')
    // One original attach + exactly one reattach for this event — no loops.
    expect(newCDPSession).toHaveBeenCalledTimes(2)
  })

  it('forwards the CDP modifier bitmask on mouse AND key events (shift-click, ctrl shortcuts)', async () => {
    const cdp = makeFakeCdp()
    const { launchBrowser } = makeFakeLaunch({ cdpSessions: [cdp] })
    const id = await startLive(launchBrowser)

    await dispatchInput(id, { type: 'mousedown', x: 0.5, y: 0.5, button: 0, modifiers: 8 })
    expect(cdp.sent.at(-1).params).toMatchObject({ type: 'mousePressed', modifiers: 8 })

    await dispatchInput(id, { type: 'keydown', key: 'A', code: 'KeyA', keyCode: 65, modifiers: 10 })
    expect(cdp.sent.at(-1).params).toMatchObject({ type: 'keyDown', modifiers: 10 })

    // Absent/garbage modifiers still dispatch as 0 (never NaN).
    await dispatchInput(id, { type: 'mouseup', x: 0.5, y: 0.5, button: 0 })
    expect(cdp.sent.at(-1).params).toMatchObject({ type: 'mouseReleased', modifiers: 0 })
  })
})

describe('capture → import → finalize lifecycle (an import failure must not lose the live login)', () => {
  it('import failure keeps the session ALIVE and retryable: capture, release, capture again, finalize', async () => {
    const { launchBrowser, browser } = makeFakeLaunch()
    const id = await startLive(launchBrowser)

    const first = await captureCloudLoginState(id)
    expect(first.ok).toBe(true)
    expect(first.storageState.cookies.length).toBeGreaterThan(0)
    // The OLD flow had already deleted the session and closed the browser here
    // — BEFORE the DB import ran.
    expect(browser.close).not.toHaveBeenCalled()

    // The route's import failed → it releases the completion mark.
    expect(releaseCloudLoginCompletion(id)).toEqual({ ok: true })

    // The same live login is capturable again — no new login required.
    const retry = await captureCloudLoginState(id)
    expect(retry.ok).toBe(true)
    expect(retry.storageState.cookies.length).toBeGreaterThan(0)

    // Import succeeded on the retry → finalize tears everything down.
    await finalizeCloudLogin(id)
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(await captureCloudLoginState(id)).toMatchObject({ ok: false, reason: 'not_found_or_expired' })
    expect(await dispatchInput(id, { type: 'mousemove', x: 0.5, y: 0.5 })).toMatchObject({ ok: false, reason: 'not_found_or_expired' })
  })

  it('success finalizes: the session is gone and finalize is idempotent', async () => {
    const { launchBrowser, browser } = makeFakeLaunch()
    const id = await startLive(launchBrowser)

    const captured = await captureCloudLoginState(id)
    expect(captured.ok).toBe(true)
    expect(await finalizeCloudLogin(id)).toEqual({ ok: true })
    expect(await finalizeCloudLogin(id)).toEqual({ ok: true, already: true })
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  it('a DOUBLE complete is refused while the first capture is pending import', async () => {
    const { launchBrowser } = makeFakeLaunch()
    const id = await startLive(launchBrowser)

    const first = await captureCloudLoginState(id)
    expect(first.ok).toBe(true)
    const second = await captureCloudLoginState(id)
    expect(second).toMatchObject({ ok: false, reason: 'completion_in_progress' })
  })

  it('the empty_session guard survives the refactor AND leaves the session alive for retry', async () => {
    const { launchBrowser, browser } = makeFakeLaunch({ captureState: { cookies: [], origins: [] } })
    const id = await startLive(launchBrowser)

    const out = await captureCloudLoginState(id)
    expect(out).toMatchObject({ ok: false, reason: 'empty_session' })
    // Not torn down, and not left stuck in `completing`.
    expect(browser.close).not.toHaveBeenCalled()
    const again = await captureCloudLoginState(id)
    expect(again).toMatchObject({ ok: false, reason: 'empty_session' })
  })

  it('login_not_verified: a still-visible password field refuses the capture (heuristic)…', async () => {
    const { launchBrowser, browser } = makeFakeLaunch({ passwordFieldCount: 1 })
    const id = await startLive(launchBrowser)

    const out = await captureCloudLoginState(id)
    expect(out).toMatchObject({ ok: false, reason: 'login_not_verified' })
    expect(out.detail).toMatch(/password field/i)
    // Session stays alive AND retryable (not stuck completing).
    expect(browser.close).not.toHaveBeenCalled()
    expect(await captureCloudLoginState(id)).toMatchObject({ ok: false, reason: 'login_not_verified' })
  })

  it('…UNLESS the caller forces: { force: true } captures anyway', async () => {
    const { launchBrowser } = makeFakeLaunch({ passwordFieldCount: 1 })
    const id = await startLive(launchBrowser)

    const out = await captureCloudLoginState(id, { force: true })
    expect(out.ok).toBe(true)
    expect(out.storageState.cookies.length).toBeGreaterThan(0)
  })

  it('a page with NO password field (or an unreadable page) passes the heuristic', async () => {
    const withField0 = makeFakeLaunch({ passwordFieldCount: 0 })
    const id0 = await startLive(withField0.launchBrowser)
    expect((await captureCloudLoginState(id0)).ok).toBe(true)

    // No locator surface at all — "cannot tell" must never block.
    const noLocator = makeFakeLaunch({ passwordFieldCount: null })
    const id1 = await startLive(noLocator.launchBrowser)
    expect((await captureCloudLoginState(id1)).ok).toBe(true)
  })

  it('the back-compat one-shot completeCloudLogin still captures + finalizes', async () => {
    const { launchBrowser, browser } = makeFakeLaunch()
    const id = await startLive(launchBrowser)

    const captured = await completeCloudLogin(id)
    expect(captured.ok).toBe(true)
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(await captureCloudLoginState(id)).toMatchObject({ ok: false, reason: 'not_found_or_expired' })
  })

  it('the complete route wires capture → import → finalize with release-on-failure (source tripwire)', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = await readFile(path.join(here, '..', 'routes', 'hamiltonAutomation.js'), 'utf8')
    const startIdx = src.indexOf("'/sessions/cloud-login/:liveSessionId/complete'")
    const endIdx = src.indexOf("'/sessions/cloud-login/:liveSessionId/cancel'")
    expect(startIdx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(startIdx)
    const handler = src.slice(startIdx, endIdx)
    // Capture (browser alive) instead of the old capture-then-close one-shot.
    expect(handler).toContain('captureCloudLoginState(')
    expect(handler).not.toContain('completeCloudLogin(')
    // Teardown only AFTER the DB write, release + retryable 500 on failure.
    const importIdx = handler.indexOf('importSession(')
    const finalizeIdx = handler.indexOf('finalizeCloudLogin(')
    expect(importIdx).toBeGreaterThan(-1)
    expect(finalizeIdx).toBeGreaterThan(importIdx)
    expect(handler).toContain('releaseCloudLoginCompletion(')
    expect(handler).toContain('retryable: true')
    // The force escape hatch is plumbed from the request body.
    expect(handler).toContain('req.body?.force === true')
  })
})
