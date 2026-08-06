// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }))

// Selector-style Zustand mock: the launcher reads isAuthenticated + user.
const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  user: { id: 'u1', email: 'me@example.com', is_admin: false },
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector) => selector(authState),
  normalizeUserAdmin: (u) =>
    Boolean(u && (u.is_admin === true || u.is_admin === 1 || u.isAdmin === true)),
}))

import { apiFetch } from '@/api/client'
import LoginGapInterviewLauncher from '../LoginGapInterviewLauncher.jsx'
import {
  MAX_PROFILES_PER_LOGIN,
  SNOOZE_KEY_PREFIX,
  isProfileSnoozed,
  planNeedsInterview,
  profilesEndpointFor,
  selectInterviewCandidates,
  snoozeProfile,
  snoozeProfiles,
} from '../loginGapInterviewLogic.js'
import { isGapGateEnabled } from '@/lib/gapGateFlag'

const GAPPED_PLAN = (field = 'state') => ({
  complete: false,
  needs_questions: true,
  questions: [
    {
      id: field,
      type: 'text',
      prompt: `Which ${field} do you live in?`,
      writes: { section: 'location_focus', field },
    },
  ],
})
const COMPLETE_PLAN = { complete: true, needs_questions: false, questions: [] }

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

function renderLauncher(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <LoginGapInterviewLauncher {...props} />
    </QueryClientProvider>,
  )
}

/** apiFetch mock covering profile list, gap plans, and section persistence. */
function mockApi({ profiles = [], plans = {}, puts = [] } = {}) {
  apiFetch.mockImplementation((url, opts) => {
    if (url === '/api/profiles' || url.startsWith('/api/profiles?')) {
      return Promise.resolve(profiles)
    }
    const gap = url.match(/^\/api\/profiles\/([^/]+)\/gap-plan$/)
    if (gap) return Promise.resolve(plans[gap[1]] ?? COMPLETE_PLAN)
    if (/\/sections$/.test(url) && !opts) return Promise.resolve([])
    if (/\/sections\//.test(url) && opts?.method === 'PUT') {
      puts.push({ url, body: JSON.parse(opts.body) })
      return Promise.resolve({ ok: true })
    }
    return Promise.resolve({})
  })
  return puts
}

beforeEach(() => {
  apiFetch.mockReset()
  window.sessionStorage.clear()
  authState.isAuthenticated = true
  authState.user = { id: 'u1', email: 'me@example.com', is_admin: false }
})

describe('gap gate flag (single source of truth)', () => {
  it('is ON by default and only OFF when explicitly set to "false"', () => {
    expect(isGapGateEnabled({})).toBe(true)
    expect(isGapGateEnabled({ VITE_GAP_GATE_ENABLED: 'true' })).toBe(true)
    expect(isGapGateEnabled({ VITE_GAP_GATE_ENABLED: 'false' })).toBe(false)
  })
})

describe('LoginGapInterviewLauncher decision logic', () => {
  it('caps admins to directly-linked profiles via scope=mine', () => {
    expect(profilesEndpointFor(true)).toBe('/api/profiles?scope=mine')
    expect(profilesEndpointFor(false)).toBe('/api/profiles')
  })

  it('selects real, non-synthetic, non-snoozed profiles, bounded per login', () => {
    const storage = fakeStorage({ [`${SNOOZE_KEY_PREFIX}p2`]: '1' })
    const profiles = [
      { id: 'p1' },
      { id: 'p2' }, // snoozed
      { id: '__admin__' }, // admin sentinel, not a real profile
      { id: 'p3', created_by: 'agent:amy' }, // synthetic
      { id: 'p4', status: 'deleted' },
      null,
      ...Array.from({ length: 10 }, (_, i) => ({ id: `x${i}` })),
    ]
    const picked = selectInterviewCandidates(profiles, { storage })
    expect(picked.length).toBe(MAX_PROFILES_PER_LOGIN)
    expect(picked.map((p) => p.id)).toEqual(['p1', 'x0', 'x1', 'x2', 'x3'])
  })

  it('snooze round-trips through storage', () => {
    const storage = fakeStorage()
    expect(isProfileSnoozed('p1', storage)).toBe(false)
    snoozeProfile('p1', storage)
    expect(isProfileSnoozed('p1', storage)).toBe(true)
    expect(isProfileSnoozed('p2', storage)).toBe(false)
  })

  it('snoozeProfiles snoozes every id at once (queue-wide close)', () => {
    const storage = fakeStorage()
    snoozeProfiles(['p1', 'p2', undefined, null], storage)
    expect(isProfileSnoozed('p1', storage)).toBe(true)
    expect(isProfileSnoozed('p2', storage)).toBe(true)
  })

  it('only interviews plans that actually have questions', () => {
    expect(planNeedsInterview(GAPPED_PLAN())).toBe(true)
    expect(planNeedsInterview(COMPLETE_PLAN)).toBe(false)
    expect(planNeedsInterview({ complete: false, needs_questions: true, questions: [] })).toBe(false)
    expect(planNeedsInterview(null)).toBe(false)
  })
})

describe('LoginGapInterviewLauncher component', () => {
  it('does nothing when not authenticated', () => {
    authState.isAuthenticated = false
    mockApi()
    renderLauncher()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('interviews gapped profiles one at a time; dismiss snoozes for the session', async () => {
    mockApi({
      profiles: [
        { id: 'p1', display_name: 'Robert' },
        { id: 'p2', display_name: 'Demo Student' },
        { id: 'p3', display_name: 'Done Profile' },
      ],
      plans: { p1: GAPPED_PLAN('state'), p2: GAPPED_PLAN('county'), p3: COMPLETE_PLAN },
    })
    renderLauncher()

    // First gapped profile's interview appears in a dialog.
    expect(await screen.findByText('Which state do you live in?')).toBeTruthy()
    expect(screen.getByText(/Anya has a few questions about Robert/)).toBeTruthy()

    // Dismiss ("Skip for now") snoozes p1 for the session and advances to p2.
    fireEvent.click(screen.getByText('Skip for now'))
    expect(window.sessionStorage.getItem(`${SNOOZE_KEY_PREFIX}p1`)).toBeTruthy()
    expect(await screen.findByText('Which county do you live in?')).toBeTruthy()

    // Dismissing the last gapped profile closes the dialog entirely (never blocks).
    fireEvent.click(screen.getByText('Skip for now'))
    await waitFor(() =>
      expect(screen.queryByTestId('login-gap-interview-dialog')).toBeNull(),
    )
    // p3 was complete — no interview for it.
    expect(screen.queryByText(/Done Profile/)).toBeNull()
  })

  it('persists answers via the shared merge+PUT path, then advances', async () => {
    const puts = mockApi({
      profiles: [{ id: 'p1', display_name: 'Robert' }],
      plans: { p1: GAPPED_PLAN('state') },
    })
    renderLauncher()

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'TN' } })
    fireEvent.click(screen.getByText('Save & continue'))

    await waitFor(() => expect(puts.length).toBe(1))
    expect(puts[0].url).toContain('/api/profiles/p1/sections/location_focus')
    expect(puts[0].body).toEqual({ data: { state: 'TN' } })
    // Queue exhausted → dialog closes.
    await waitFor(() =>
      expect(screen.queryByTestId('login-gap-interview-dialog')).toBeNull(),
    )
  })

  it('a close GESTURE (Escape) ends the whole interview — it never opens the next profile', async () => {
    mockApi({
      profiles: [
        { id: 'p1', display_name: 'Robert' },
        { id: 'p2', display_name: 'Demo Student' },
      ],
      plans: { p1: GAPPED_PLAN('state'), p2: GAPPED_PLAN('county') },
    })
    renderLauncher()

    expect(await screen.findByText('Which state do you live in?')).toBeTruthy()

    // Escape must END the interview session — the trapped-in-modal-cycles bug
    // was close gestures advancing to the next profile's dialog instead.
    fireEvent.keyDown(screen.getByTestId('login-gap-interview-dialog'), { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByTestId('login-gap-interview-dialog')).toBeNull(),
    )
    expect(screen.queryByText('Which county do you live in?')).toBeNull()
    // Every queued profile is snoozed for the session, not just the visible one.
    expect(window.sessionStorage.getItem(`${SNOOZE_KEY_PREFIX}p1`)).toBeTruthy()
    expect(window.sessionStorage.getItem(`${SNOOZE_KEY_PREFIX}p2`)).toBeTruthy()
  })

  it('ADMIN GATE: the global login-time mount never interviews an admin (secondary logins must not re-ask)', async () => {
    authState.user = { id: 'u1', email: 'owner@example.com', is_admin: true }
    mockApi({
      profiles: [{ id: 'p1', display_name: 'Owner Profile' }],
      plans: { p1: GAPPED_PLAN('state') },
    })
    renderLauncher() // global App.jsx mount — no onFinished
    // Give any (incorrect) probe a tick to fire, then assert total silence.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(apiFetch).not.toHaveBeenCalled()
    expect(screen.queryByTestId('login-gap-interview-dialog')).toBeNull()
  })

  it('ADMIN GATE exception: the sequenced ResetOnboardingFlow pass (onFinished) still runs, capped to scope=mine', async () => {
    authState.user = { id: 'u1', email: 'owner@example.com', is_admin: true }
    mockApi({ profiles: [] })
    renderLauncher({ onFinished: () => {} })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/profiles?scope=mine'))
  })

  it('does not probe gap plans for session-snoozed profiles', async () => {
    window.sessionStorage.setItem(`${SNOOZE_KEY_PREFIX}p1`, '1')
    mockApi({
      profiles: [{ id: 'p1' }, { id: 'p2', display_name: 'Second' }],
      plans: { p1: GAPPED_PLAN('state'), p2: GAPPED_PLAN('county') },
    })
    renderLauncher()

    expect(await screen.findByText('Which county do you live in?')).toBeTruthy()
    const gapPlanCalls = apiFetch.mock.calls
      .map(([url]) => url)
      .filter((url) => url.endsWith('/gap-plan'))
    expect(gapPlanCalls).toEqual(['/api/profiles/p2/gap-plan'])
  })
})
