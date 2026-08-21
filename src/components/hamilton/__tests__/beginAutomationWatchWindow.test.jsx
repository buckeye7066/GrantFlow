// @vitest-environment jsdom
/**
 * "Begin automation" must pop the work open in its own window.
 *
 * OWNER ORDER 2026-08-21. Before this, the button's only feedback was a toast
 * reading "Watch the Automation tab for progress" — the run was real, but
 * seeing it was homework on a surface the user had to go find.
 *
 * The three things that make this real rather than decorative, each asserted
 * below because each has a specific way of silently not working:
 *
 *  1. The window is claimed BEFORE the async start. `beginHamiltonAutomation`
 *     awaits a POST that launches real browser work; a window.open afterwards is
 *     no longer user-initiated and browsers block it. liveLoginWindow.js already
 *     shipped that bug once — the popup was blocked and the code toasted
 *     "opened" anyway. The test pins the ORDER, not just the call.
 *
 *  2. Watching is optional; the run is not. A blocked popup must still start
 *     Hamilton. Anything else turns a courtesy window into a gate.
 *
 *  3. The window is never a dead end. If the start fails, that same window says
 *     why instead of spinning on "Starting…" forever.
 */
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAuthorizationsMock,
  getVaultStatusMock,
  beginAutomationMock,
  listReadySourcesMock,
  toastMock,
  openWatchMock,
  calls,
} = vi.hoisted(() => ({
  getAuthorizationsMock: vi.fn(),
  getVaultStatusMock: vi.fn(),
  beginAutomationMock: vi.fn(),
  listReadySourcesMock: vi.fn(),
  toastMock: vi.fn(),
  openWatchMock: vi.fn(),
  calls: [],
}))

vi.mock('@/api/hamilton', () => ({
  getHamiltonAuthorizations: (...a) => getAuthorizationsMock(...a),
  grantHamiltonAuthorization: vi.fn(),
  revokeHamiltonAuthorization: vi.fn(),
  getPortalVaultStatus: (...a) => getVaultStatusMock(...a),
  enableAutonomousUnlock: vi.fn(),
  disableAutonomousUnlock: vi.fn(),
  beginHamiltonAutomation: (...a) => beginAutomationMock(...a),
  listReadyHamiltonSources: (...a) => listReadySourcesMock(...a),
}))

vi.mock('@/components/hamilton/automationWatchWindow', () => ({
  openAutomationWatchWindow: (...a) => openWatchMock(...a),
  resolveAutomationWatchUrl: (id) => `https://app.test/HamiltonAutomationWatch?profile=${id}`,
}))

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }))

import HamiltonAutopilotConsentCard from '../HamiltonAutopilotConsentCard.jsx'

function makeWatch(blocked = false) {
  return {
    blocked,
    navigate: vi.fn((url) => calls.push(`navigate:${url}`)),
    fail: vi.fn((m) => calls.push(`fail:${m}`)),
    close: vi.fn(() => calls.push('close')),
  }
}

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <HamiltonAutopilotConsentCard profileId="profile-1" />
    </QueryClientProvider>,
  )
}

async function clickBegin() {
  renderCard()
  // The button only exists while full automation is on (see the fixture above).
  const btn = await screen.findByRole('button', { name: /begin automation/i })
  fireEvent.click(btn)
  return btn
}

describe('Begin automation opens a watch window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    // Full automation must ALREADY be on, or the Begin button is not rendered:
    // the card requires a profile-scoped, non-revoked submit grant carrying
    // allow_auto_submit, with no standing human-review veto.
    getAuthorizationsMock.mockResolvedValue({
      active: [{
        id: 'auth-1',
        authorization_type: 'submit_applications',
        scope: 'profile',
        revoked_at: null,
        options: { allow_auto_submit: true, require_human_review: false },
      }],
    })
    getVaultStatusMock.mockResolvedValue({ vault: { has_passphrase: false, autonomous_unlock: false } })
    listReadySourcesMock.mockResolvedValue({ ok: true, count: 2, sources: [] })
  })

  it('claims the window BEFORE the start request, then navigates it to the watch page', async () => {
    const watch = makeWatch(false)
    openWatchMock.mockImplementation(() => { calls.push('open'); return watch })
    beginAutomationMock.mockImplementation(async () => {
      calls.push('start')
      return { ok: true, queued: true, queued_count: 2 }
    })

    await clickBegin()

    await waitFor(() => expect(watch.navigate).toHaveBeenCalled())
    // ORDER is the assertion. "open" after "start" is the popup-blocked bug.
    expect(calls[0]).toBe('open')
    expect(calls[1]).toBe('start')
    expect(watch.navigate).toHaveBeenCalledWith(
      'https://app.test/HamiltonAutomationWatch?profile=profile-1',
    )
    expect(watch.fail).not.toHaveBeenCalled()
  })

  it('still starts the run when the browser BLOCKS the pop-up', async () => {
    openWatchMock.mockReturnValue(makeWatch(true))
    beginAutomationMock.mockResolvedValue({ ok: true, queued: true, queued_count: 1 })

    await clickBegin()

    // The work is the point; the window is a courtesy.
    await waitFor(() => expect(beginAutomationMock).toHaveBeenCalledWith('profile-1'))
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/without the watch window/i),
    }))
  })

  it('never leaves a dead window: a failed start renders the reason in it', async () => {
    const watch = makeWatch(false)
    openWatchMock.mockReturnValue(watch)
    beginAutomationMock.mockRejectedValue(new Error('no_ready_sources'))

    await clickBegin()

    await waitFor(() => expect(watch.fail).toHaveBeenCalled())
    expect(String(watch.fail.mock.calls[0][0])).toMatch(/no funding sources/i)
    expect(watch.navigate).not.toHaveBeenCalled()
  })
})
