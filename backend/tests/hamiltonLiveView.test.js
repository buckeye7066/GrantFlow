/**
 * The live-view channel: an ephemeral in-memory store for the run's latest
 * screencast FRAME and STEP, plus the CDP screencast pump that fills it.
 *
 * Contract pinned here:
 *  - a FRAME goes stale fast (the run navigates away) so a frozen picture is
 *    never served as live; a STEP outlives it (it is the "what is Hamilton
 *    doing" text) — both from ONE store entry, ONE endpoint;
 *  - reportLiveStep / putLiveFrame are guarded no-ops on missing inputs;
 *  - the store never grows past MAX_RUNS (a leaked run cannot grow memory);
 *  - startLiveScreencast pumps CDP frames into the store, ACKS each one (or
 *    Chrome stops sending), stop() halts it, and — critically — it NEVER throws,
 *    so a screencast failure can never break an autopilot run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  putLiveFrame,
  getLiveFrame,
  reportLiveStep,
  clearLiveRun,
  startLiveScreencast,
  isLiveViewEnabled,
  _resetLiveView,
  _liveViewSize,
} from '../services/hamilton/hamiltonLiveView.js'

beforeEach(() => _resetLiveView())

describe('the frame + step store', () => {
  it('serves a fresh frame and hides a stale one, keeping the step', () => {
    let t = 1_000_000
    const now = () => t
    putLiveFrame('run1', 'AAAA', { now })
    reportLiveStep('run1', 'Filling the application', { detail: { fields_filled: 4 }, now })

    // fresh
    let live = getLiveFrame('run1', { now })
    expect(live.frame).toBe('AAAA')
    expect(live.step).toBe('Filling the application')
    expect(live.step_detail).toEqual({ fields_filled: 4 })

    // 20s later: the FRAME is stale (>15s), the STEP is still live (<5min)
    t += 20_000
    live = getLiveFrame('run1', { now })
    expect(live.frame).toBeNull()
    expect(live.step).toBe('Filling the application')
  })

  it('returns null for an unknown run', () => {
    expect(getLiveFrame('nope')).toBeNull()
  })

  it('reportLiveStep and putLiveFrame are no-ops on missing inputs', () => {
    reportLiveStep('', 'x')
    reportLiveStep('r', '')
    putLiveFrame('r', '')
    expect(_liveViewSize()).toBe(0)
  })

  it('clearLiveRun drops the entry (run end)', () => {
    putLiveFrame('run1', 'AAAA')
    expect(getLiveFrame('run1')).not.toBeNull()
    clearLiveRun('run1')
    expect(getLiveFrame('run1')).toBeNull()
  })

  it('never grows past the run cap', () => {
    let t = 0
    const now = () => (t += 1)
    for (let i = 0; i < 60; i += 1) putLiveFrame(`run${i}`, 'X', { now })
    expect(_liveViewSize()).toBeLessThanOrEqual(25)
  })
})

describe('isLiveViewEnabled — default on, only explicit off disables', () => {
  it('is on by default and off only for false/0/off/no', () => {
    expect(isLiveViewEnabled({})).toBe(true)
    expect(isLiveViewEnabled({ HAMILTON_LIVE_VIEW: '' })).toBe(true)
    expect(isLiveViewEnabled({ HAMILTON_LIVE_VIEW: 'false' })).toBe(false)
    expect(isLiveViewEnabled({ HAMILTON_LIVE_VIEW: '0' })).toBe(false)
    expect(isLiveViewEnabled({ HAMILTON_LIVE_VIEW: 'off' })).toBe(false)
    expect(isLiveViewEnabled({ HAMILTON_LIVE_VIEW: 'yes-please' })).toBe(true)
  })
})

// A fake CDP session that records sends and lets the test emit a frame.
function fakeCdp() {
  const handlers = {}
  const sends = []
  return {
    session: {
      on: (evt, fn) => { handlers[evt] = fn },
      send: vi.fn(async (method, params) => { sends.push({ method, params }) }),
      removeAllListeners: () => { delete handlers['Page.screencastFrame'] },
      detach: vi.fn(async () => {}),
    },
    emitFrame: (data, sessionId = 7) => handlers['Page.screencastFrame']?.({ data, sessionId }),
    sends,
  }
}

describe('startLiveScreencast — the CDP pump', () => {
  it('starts the screencast, stores an emitted frame, and ACKS it', async () => {
    const cdp = fakeCdp()
    const handle = await startLiveScreencast({}, 'runX', { createCdpSession: async () => cdp.session })
    expect(cdp.sends.some((s) => s.method === 'Page.startScreencast')).toBe(true)

    cdp.emitFrame('ZZZZ')
    await Promise.resolve()
    expect(getLiveFrame('runX')?.frame).toBe('ZZZZ')
    expect(cdp.sends.some((s) => s.method === 'Page.screencastAck' && s.params?.sessionId === 7)).toBe(true)

    await handle.stop()
    expect(cdp.sends.some((s) => s.method === 'Page.stopScreencast')).toBe(true)
    expect(getLiveFrame('runX')).toBeNull() // stop clears the run
  })

  it('NEVER throws when the CDP session cannot be created — the run is unaffected', async () => {
    const handle = await startLiveScreencast({}, 'runBad', {
      createCdpSession: async () => { throw new Error('no CDP in this browser') },
    })
    expect(typeof handle.stop).toBe('function')
    await handle.stop() // also must not throw
    expect(getLiveFrame('runBad')).toBeNull()
  })

  it('is a no-op (no throw) with no page or no runId', async () => {
    const h1 = await startLiveScreencast(null, 'r')
    const h2 = await startLiveScreencast({}, null)
    await h1.stop()
    await h2.stop()
    expect(_liveViewSize()).toBe(0)
  })
})
