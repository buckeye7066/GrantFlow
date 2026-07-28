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

  it('a healthy session forwards mousedown+mouseup — and NO duplicate synthetic click (one physical click = ONE portal click)', async () => {
    const { container } = renderLivePage()
    await paintFrame(streamHandlers)

    clickCanvas(container)
    await waitFor(() => {
      const types = apiMocks.sendCloudLoginInput.mock.calls.map(([, ev]) => ev.type)
      expect(types).toContain('mousedown')
      expect(types).toContain('mouseup')
    })
    // OLD behavior: the canvas ALSO relayed the browser's click event, which
    // the backend expands into move+press+release — so one physical click
    // became two full click sequences at the portal (checkboxes toggled back
    // off, double submits).
    const types = apiMocks.sendCloudLoginInput.mock.calls.map(([, ev]) => ev.type)
    expect(types).not.toContain('click')
    // Coordinates are normalized 0..1 against the displayed canvas.
    const [, ev] = apiMocks.sendCloudLoginInput.mock.calls[0]
    expect(ev.x).toBeCloseTo(300 / 1280, 5)
    expect(ev.y).toBeCloseTo(330 / 900, 5)
    // And no failure overlay appears.
    expect(screen.queryByText(/expired or was closed|live connection ended/i)).toBeNull()
  })

  it('a phone TAP still posts the synthetic click (the touch path must keep working)', async () => {
    const { container } = renderLivePage()
    await paintFrame(streamHandlers)

    const canvas = container.querySelector('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 900, right: 1280, bottom: 900, x: 0, y: 0 })
    fireEvent.touchStart(canvas, { touches: [{ clientX: 640, clientY: 450 }] })

    await waitFor(() => {
      const clickEv = apiMocks.sendCloudLoginInput.mock.calls.map(([, ev]) => ev).find((ev) => ev.type === 'click')
      expect(clickEv).toBeTruthy()
      expect(clickEv.x).toBeCloseTo(0.5, 5)
      expect(clickEv.y).toBeCloseTo(0.5, 5)
    })
  })
})

describe('HamiltonLiveLogin — CDP modifiers ride along with input', () => {
  it('shift-click posts modifiers=8; ctrl+key posts keydown modifiers=2 and suppresses the char event', async () => {
    const { container } = renderLivePage()
    await paintFrame(streamHandlers)

    const canvas = container.querySelector('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 900, right: 1280, bottom: 900, x: 0, y: 0 })

    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0, shiftKey: true })
    await waitFor(() => {
      const down = apiMocks.sendCloudLoginInput.mock.calls.map(([, ev]) => ev).find((ev) => ev.type === 'mousedown')
      expect(down).toBeTruthy()
      expect(down.modifiers).toBe(8) // Shift
    })

    fireEvent.focus(canvas)
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true })
    await waitFor(() => {
      const kd = apiMocks.sendCloudLoginInput.mock.calls.map(([, ev]) => ev).find((ev) => ev.type === 'keydown')
      expect(kd).toBeTruthy()
      expect(kd.modifiers).toBe(2) // Ctrl
    })
    // Ctrl suppresses the printable 'char' companion (a shortcut, not typing).
    const types = apiMocks.sendCloudLoginInput.mock.calls.map(([, ev]) => ev.type)
    expect(types).not.toContain('char')

    // Plain typing still sends keydown+char, unmodified.
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', keyCode: 66 })
    await waitFor(() => {
      const ch = apiMocks.sendCloudLoginInput.mock.calls.map(([, ev]) => ev).find((ev) => ev.type === 'char')
      expect(ch).toBeTruthy()
      expect(ch.modifiers).toBe(0)
    })
  })
})

describe('HamiltonLiveLogin — Done button gating + lossless completion', () => {
  it('Done is DISABLED until the view is genuinely live (connected + painted), with an explanatory tooltip', async () => {
    renderLivePage()
    const done = screen.getByRole('button', { name: /done — i.ve finished logging in/i })
    expect(done.disabled).toBe(true)
    expect(done.closest('span')?.getAttribute('title')).toMatch(/live portal view/i)

    await paintFrame(streamHandlers)
    expect(screen.getByRole('button', { name: /done — i.ve finished logging in/i }).disabled).toBe(false)
  })

  it('login_not_verified shows the message and "Force save anyway" retries with { force: true }', async () => {
    const refusal = Object.assign(new Error('cloud_login_complete_failed'), {
      status: 400,
      errorCode: 'cloud_login_complete_failed',
      details: { reason: 'login_not_verified', detail: 'The portal still shows a password field — finish logging in first.' },
    })
    apiMocks.completeCloudLogin.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ ok: true })

    renderLivePage()
    await paintFrame(streamHandlers)

    fireEvent.click(screen.getByRole('button', { name: /done — i.ve finished logging in/i }))
    expect(await screen.findByText(/still shows a password field/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /force save anyway/i }))
    await waitFor(() => {
      expect(apiMocks.completeCloudLogin).toHaveBeenLastCalledWith('cl_test_1', { force: true })
    })
    expect(await screen.findByText(/session captured/i)).toBeTruthy()
  })

  it('a retryable import failure keeps the window alive and Done can simply be retried (no new login)', async () => {
    const importFailed = Object.assign(new Error('import_failed'), {
      status: 500,
      errorCode: 'import_failed',
      details: { error: 'import_failed', retryable: true },
    })
    apiMocks.completeCloudLogin.mockRejectedValueOnce(importFailed).mockResolvedValueOnce({ ok: true })

    renderLivePage()
    await paintFrame(streamHandlers)

    const doneName = /done — i.ve finished logging in/i
    fireEvent.click(screen.getByRole('button', { name: doneName }))
    expect(await screen.findByText(/your login is still live/i)).toBeTruthy()

    // NOT the dead-stream overlay, and Done is still available.
    expect(screen.queryByText(/live connection ended|expired or was closed/i)).toBeNull()
    const done = screen.getByRole('button', { name: doneName })
    expect(done.disabled).toBe(false)

    fireEvent.click(done)
    expect(await screen.findByText(/session captured/i)).toBeTruthy()
    expect(apiMocks.completeCloudLogin).toHaveBeenCalledTimes(2)
    expect(apiMocks.completeCloudLogin).toHaveBeenLastCalledWith('cl_test_1', { force: false })
  })
})
