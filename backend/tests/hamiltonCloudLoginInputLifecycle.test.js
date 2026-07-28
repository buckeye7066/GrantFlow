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
function makeFakeLaunch({ cdpSessions = [makeFakeCdp()] } = {}) {
  let cdpIndex = 0
  const newCDPSession = vi.fn(async () => {
    const entry = cdpSessions[Math.min(cdpIndex, cdpSessions.length - 1)]
    cdpIndex += 1
    if (typeof entry === 'function') return entry()
    return entry
  })
  const newContext = vi.fn(async (opts = {}) => {
    const ctx = {
      opts,
      newCDPSession,
      newPage: async () => ({
        goto: vi.fn(async () => {}),
        url: () => 'https://mtsu.edu/landing',
        viewportSize: () => ({ width: 1280, height: 900 }),
        context: () => ctx,
      }),
      storageState: async () => opts.storageState || { cookies: [{ name: 'csrf', value: 'x', domain: 'mtsu.edu', path: '/' }], origins: [] },
    }
    return ctx
  })
  const browser = { newContext, close: vi.fn(async () => {}) }
  const launchBrowser = vi.fn(async () => ({ browser, engine: 'fake' }))
  return { launchBrowser, newCDPSession }
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
})
