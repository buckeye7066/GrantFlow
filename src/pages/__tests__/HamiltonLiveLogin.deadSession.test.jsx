// @vitest-environment jsdom
/**
 * HamiltonLiveLogin — the "portal looks alive but nothing I click works"
 * regression (owner report 2026-07-27).
 *
 * Reproduced end-to-end before the fix: once one frame has PAINTED, a live
 * session that dies server-side (redeploy / TTL sweep / cancel) leaves the
 * last frame on the canvas looking like a real login page while:
 *   - every input POST fails with 404 not_found_or_expired, swallowed by
 *     post()'s `.catch(() => {})` — clicks silently do nothing, forever;
 *   - the failure UI was gated on `!painted`, so NO error, NO reconnect, NO
 *     "start a new login" was ever shown.
 *
 * These tests drive the REAL page with mocked transport and FAIL on the old
 * behavior (mutation-verified by reverting the page fix).
 */
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  streamCloudLogin: vi.fn(),
  sendCloudLoginInput: vi.fn(),
  completeCloudLogin: vi.fn(),
  cancelCloudLogin: vi.fn(),
}))

vi.mock('@/api/hamilton', () => apiMocks)

const HamiltonLiveLogin = (await import('../HamiltonLiveLogin.jsx')).default

/** Image stub that fires onload as soon as src is set (jsdom never loads). */
class InstantImage {
  set src(_v) {
    queueMicrotask(() => { this.onload?.() })
  }
}

function renderLivePage() {
  return render(
    <MemoryRouter initialEntries={["/HamiltonLiveLogin?session=cl_test_1&host=mtsu.edu"]}>
      <HamiltonLiveLogin />
    </MemoryRouter>,
  )
}

/** Paint one frame through the page's real draw path and wait for "Live". */
async function paintFrame(handlers) {
  await act(async () => {
    handlers.onOpen?.()
    handlers.onFrame?.({ data: 'FRAME', metadata: { deviceWidth: 1280, deviceHeight: 900 } })
    // let the InstantImage onload microtask run
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(await screen.findByText('Live')).toBeTruthy()
}

function clickCanvas(container) {
  const canvas = container.querySelector('canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 900, right: 1280, bottom: 900, x: 0, y: 0 })
  fireEvent.mouseDown(canvas, { clientX: 300, clientY: 330, button: 0 })
  fireEvent.mouseUp(canvas, { clientX: 300, clientY: 330, button: 0 })
  fireEvent.click(canvas, { clientX: 300, clientY: 330, button: 0 })
}

let streamHandlers
beforeEach(() => {
  vi.stubGlobal('Image', InstantImage)
  // jsdom has no canvas backend; give the draw path a working-enough context.
  vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} })
  streamHandlers = null
  apiMocks.streamCloudLogin.mockImplementation((_id, handlers) => {
    streamHandlers = handlers
    return { close: vi.fn() }
  })
  apiMocks.sendCloudLoginInput.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('HamiltonLiveLogin — dead session must not masquerade as a live portal', () => {
  it('a 404 (not_found_or_expired) on input SURFACES the expired-session message even though a frame painted', async () => {
    const gone = Object.assign(new Error('not_found_or_expired'), {
      status: 404,
      errorCode: 'not_found_or_expired',
    })
    apiMocks.sendCloudLoginInput.mockRejectedValue(gone)

    const { container } = renderLivePage()
    await paintFrame(streamHandlers)

    clickCanvas(container)

    // OLD behavior: the rejection was swallowed and the page kept showing a
    // live-looking portal with zero feedback — this findByText timed out.
    expect(
      await screen.findByText(/secure login session expired or was closed/i),
    ).toBeTruthy()
    // Terminal: no Reconnect offered for a session the server says is gone.
    expect(screen.queryByRole('button', { name: /reconnect/i })).toBeNull()
  })

  it('once the session is known-gone, further mouse activity stops posting to the dead id', async () => {
    const gone = Object.assign(new Error('not_found_or_expired'), {
      status: 404,
      errorCode: 'not_found_or_expired',
    })
    apiMocks.sendCloudLoginInput.mockRejectedValue(gone)

    const { container } = renderLivePage()
    await paintFrame(streamHandlers)

    clickCanvas(container)
    await screen.findByText(/secure login session expired or was closed/i)

    const callsAfterSurfaced = apiMocks.sendCloudLoginInput.mock.calls.length
    clickCanvas(container)
    clickCanvas(container)
    await new Promise((r) => setTimeout(r, 0))
    // OLD behavior: every click kept spamming the dead session forever.
    expect(apiMocks.sendCloudLoginInput.mock.calls.length).toBe(callsAfterSurfaced)
  })

  it('a stream drop AFTER painting shows the failure overlay with Reconnect (was: only a tiny label change)', async () => {
    renderLivePage()
    await paintFrame(streamHandlers)

    await act(async () => {
      streamHandlers.onError?.('stream_ended')
    })

    // OLD behavior: the overlay was gated on `!painted`, so a dropped stream
    // left a frozen, live-looking frame with no visible recovery path.
    expect(await screen.findByText(/live connection ended/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeTruthy()
  })

  it("the server's teardown announcement (session_closed) is terminal: honest message, no Reconnect", async () => {
    renderLivePage()
    await paintFrame(streamHandlers)

    await act(async () => {
      streamHandlers.onError?.('session_closed')
    })

    expect(
      await screen.findByText(/secure login session expired or was closed/i),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /reconnect/i })).toBeNull()
  })

  it('a healthy session still forwards the full click sequence (guard against over-correcting)', async () => {
    const { container } = renderLivePage()
    await paintFrame(streamHandlers)

    clickCanvas(container)
    await waitFor(() => {
      const types = apiMocks.sendCloudLoginInput.mock.calls.map(([, ev]) => ev.type)
      expect(types).toContain('mousedown')
      expect(types).toContain('mouseup')
      expect(types).toContain('click')
    })
    // Coordinates are normalized 0..1 against the displayed canvas.
    const [, ev] = apiMocks.sendCloudLoginInput.mock.calls[0]
    expect(ev.x).toBeCloseTo(300 / 1280, 5)
    expect(ev.y).toBeCloseTo(330 / 900, 5)
    // And no failure overlay appears.
    expect(screen.queryByText(/expired or was closed|live connection ended/i)).toBeNull()
  })
})
