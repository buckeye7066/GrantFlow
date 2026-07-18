/**
 * Regression: the Hamilton live-login viewer must PAINT frames onto its canvas,
 * not just open a "connected" stream over a blank white box.
 *
 * Root cause this guards: CDP Page.startScreencast only emits a frame when the
 * compositor REPAINTS. A fully-loaded, static login page produces no repaint, so
 * the viewer used to wait forever for a first frame it could never receive — a
 * connected-but-blank canvas (and, seeing nothing, the user never interacts to
 * trigger a repaint: a deadlock). attachScreencast now delivers an immediate
 * keyframe screenshot plus an idle-keyframe net, so the canvas receives real
 * pixels even when Page.screencastFrame never fires.
 *
 * These tests drive attachScreencast/captureKeyframe with a FAKE CDP + page (no
 * real browser), asserting a paintable frame is delivered with no screencast
 * frame event at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { attachScreencast, captureKeyframe } from '../services/hamilton/hamiltonCloudLogin.js'

function makeFakeCdp({ screenshotData = 'JPEGKEYFRAMEDATA', failScreenshot = false } = {}) {
  const handlers = {}
  const sent = []
  const cdp = {
    sent,
    on: (evt, fn) => { handlers[evt] = fn },
    emit: (evt, payload) => handlers[evt]?.(payload),
    send: vi.fn(async (method) => {
      sent.push(method)
      if (method === 'Page.captureScreenshot') {
        if (failScreenshot) throw new Error('screenshot boom')
        return { data: screenshotData }
      }
      return {}
    }),
    detach: vi.fn(async () => {}),
  }
  return cdp
}

function makeFakePage(cdp, viewport = { width: 1280, height: 900 }) {
  return {
    viewportSize: () => viewport,
    context: () => ({ newCDPSession: async () => cdp }),
  }
}

function makeSession(cdp) {
  return {
    __id: 'cl_test_session',
    page: makeFakePage(cdp),
    screencastCdp: null,
    inputCdp: null,
    keyframeTimer: null,
    lastFrameMeta: null,
  }
}

afterEach(() => { vi.useRealTimers() })

describe('attachScreencast — the blank-canvas fix', () => {
  it('delivers a paintable initial frame WITHOUT any Page.screencastFrame event', async () => {
    const cdp = makeFakeCdp({ screenshotData: 'REALPIXELS' })
    const s = makeSession(cdp)
    const frames = []

    const stop = await attachScreencast(s, (f) => frames.push(f), { quality: 60 })
    expect(typeof stop).toBe('function')

    // The compositor NEVER repainted (no screencastFrame emitted), yet the
    // viewer still got a frame with real image bytes it can draw.
    expect(frames.length).toBeGreaterThanOrEqual(1)
    expect(frames[0].data).toBe('REALPIXELS')
    expect(frames[0].data.length).toBeGreaterThan(0)
    expect(frames[0].metadata.deviceWidth).toBe(1280)
    expect(frames[0].metadata.deviceHeight).toBe(900)

    // The screencast was still started (live repaints stream on top of the
    // keyframe), and the keyframe came from an explicit screenshot.
    expect(cdp.sent).toContain('Page.enable')
    expect(cdp.sent).toContain('Page.startScreencast')
    expect(cdp.sent).toContain('Page.captureScreenshot')

    // Input coordinate scaling depends on lastFrameMeta — the keyframe seeds it.
    expect(s.lastFrameMeta.deviceWidth).toBe(1280)

    await stop()
    expect(cdp.sent).toContain('Page.stopScreencast')
    expect(s.keyframeTimer).toBe(null)
  })

  it('still streams live screencast frames and acks them', async () => {
    const cdp = makeFakeCdp()
    const s = makeSession(cdp)
    const frames = []
    const stop = await attachScreencast(s, (f) => frames.push(f))

    cdp.emit('Page.screencastFrame', {
      data: 'LIVEFRAME',
      sessionId: 42,
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    })
    // Let the async ack settle.
    await new Promise((r) => setTimeout(r, 0))

    expect(frames.some((f) => f.data === 'LIVEFRAME')).toBe(true)
    expect(s.lastFrameMeta.deviceWidth).toBe(800)
    expect(cdp.sent).toContain('Page.screencastFrameAck')
    await stop()
  })

  it('refreshes an idle page via the keyframe timer, and stops cleanly', async () => {
    vi.useFakeTimers()
    const cdp = makeFakeCdp({ screenshotData: 'IDLEKF' })
    const s = makeSession(cdp)
    const frames = []

    const stop = await attachScreencast(s, (f) => frames.push(f))
    const afterInitial = frames.length
    expect(afterInitial).toBeGreaterThanOrEqual(1)
    expect(s.keyframeTimer).toBeTruthy()

    // No live frames arrive; after the idle window the timer must push a fresh
    // keyframe so the mirror never goes stale/blank.
    await vi.advanceTimersByTimeAsync(1100)
    expect(frames.length).toBeGreaterThan(afterInitial)

    await stop()
    expect(s.keyframeTimer).toBe(null)
    const afterStop = frames.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(frames.length).toBe(afterStop) // no frames after stop
  })

  it('re-attaching tears down the previous screencast first', async () => {
    const cdp1 = makeFakeCdp()
    const s = makeSession(cdp1)
    const stop1 = await attachScreencast(s, () => {})
    expect(s.screencastCdp).toBe(cdp1)

    // New CDP for the re-attach.
    const cdp2 = makeFakeCdp()
    s.page = makeFakePage(cdp2)
    const stop2 = await attachScreencast(s, () => {})

    expect(cdp1.sent).toContain('Page.stopScreencast')
    expect(cdp1.detach).toHaveBeenCalled()
    expect(s.screencastCdp).toBe(cdp2)
    await stop1()
    await stop2()
  })
})

describe('captureKeyframe — never throws, shapes a screencast-like frame', () => {
  it('returns { data, metadata } sized to the viewport', async () => {
    const cdp = makeFakeCdp({ screenshotData: 'ABC' })
    const page = makeFakePage(cdp, { width: 1024, height: 768 })
    const kf = await captureKeyframe(cdp, page, 55)
    expect(kf.data).toBe('ABC')
    expect(kf.metadata.deviceWidth).toBe(1024)
    expect(kf.metadata.deviceHeight).toBe(768)
    expect(kf.metadata.keyframe).toBe(true)
    expect(cdp.send).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
  })

  it('returns null (never throws) when the screenshot fails or args are missing', async () => {
    const cdp = makeFakeCdp({ failScreenshot: true })
    const page = makeFakePage(cdp)
    await expect(captureKeyframe(cdp, page)).resolves.toBe(null)
    await expect(captureKeyframe(null, null)).resolves.toBe(null)
  })

  it('falls back to a 1280x900 viewport when the page cannot report one', async () => {
    const cdp = makeFakeCdp({ screenshotData: 'X' })
    const page = { context: () => ({}) } // no viewportSize()
    const kf = await captureKeyframe(cdp, page)
    expect(kf.metadata.deviceWidth).toBe(1280)
    expect(kf.metadata.deviceHeight).toBe(900)
  })
})
