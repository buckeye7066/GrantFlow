// @vitest-environment jsdom
/**
 * Lane R4 finding (HIGH): the standing preflight-block banner keyed off
 * `highlights.last_blocked` compared only against `highlights.last_success` —
 * so a LATER run that failed, was cancelled, or was stopped (neither a
 * success nor another block) left the stale "blocked" banner up, showing the
 * operator a resolved prerequisite as if it were still the standing state.
 *
 * The fix: the banner shows only when the block IS the most recent terminal
 * run (`highlights.last_terminal`); otherwise it collapses to a one-line
 * "last block was <time ago>, latest run <status>" note.
 */
import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('./AgentControlAgentCard.jsx', () => ({ default: () => null }))
vi.mock('./AnyaAutonomyToggle.jsx', () => ({ default: () => null }))
vi.mock('./AdversarialRepairToggle.jsx', () => ({ default: () => null }))
vi.mock('./AgentControlRunDetails.jsx', () => ({ default: () => null }))
vi.mock('./AgentControlEventsTimeline.jsx', () => ({ default: () => null }))

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector) => selector({ user: { id: 'admin-1', is_admin: true } }),
}))

const statusMock = vi.fn()
vi.mock('@/api/agentControl', () => ({
  default: {
    capability: vi.fn().mockResolvedValue({ can_control_agents: true }),
    status: (...args) => statusMock(...args),
    getEvents: vi.fn().mockResolvedValue({ events: [] }),
  },
}))

const { default: AgentControlCenter } = await import('./AgentControlCenter.jsx')

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    status: 'completed',
    completed_at: null,
    started_at: null,
    created_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  statusMock.mockReset()
})

describe('AgentControlCenter — standing preflight-block banner', () => {
  it('shows the full block panel when the block IS the latest terminal run', async () => {
    const blockedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago
    const blocked = makeRun({
      id: 'blocked-1',
      status: 'blocked',
      completed_at: blockedAt,
      summary: {
        blocked_by: {
          blocked_reason: 'release gate red',
          blocked_detail: { critical_findings: [], prerequisites: [], skipped_critical_checks: [] },
        },
      },
    })
    statusMock.mockResolvedValue({
      active_run: null,
      agents: {},
      highlights: {
        last: blocked,
        last_full_cycle: blocked,
        last_success: null,
        last_failure: null,
        last_blocked: blocked,
        last_terminal: blocked,
      },
    })

    render(<AgentControlCenter />)

    await waitFor(() => expect(screen.getByText(/Last cycle blocked by Sam preflight/i)).toBeTruthy())
    expect(screen.queryByText(/latest run since then/i)).toBeNull()
  })

  it('collapses to a superseded one-liner once a LATER non-success terminal run has happened', async () => {
    const blockedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() // 6h ago — the 10:00 block
    const failedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago — the 16:00 failure
    const blocked = makeRun({
      id: 'blocked-1',
      status: 'blocked',
      completed_at: blockedAt,
      summary: {
        blocked_by: {
          blocked_reason: 'release gate red',
          blocked_detail: { critical_findings: [], prerequisites: [], skipped_critical_checks: [] },
        },
      },
    })
    const failed = makeRun({ id: 'failed-1', status: 'failed', completed_at: failedAt, error_message: 'robert error' })
    statusMock.mockResolvedValue({
      active_run: null,
      agents: {},
      highlights: {
        last: failed,
        last_full_cycle: failed,
        last_success: null,
        last_failure: failed,
        last_blocked: blocked,
        last_terminal: failed,
      },
    })

    render(<AgentControlCenter />)

    // The stale, standing-blocked banner (with its now-resolved prerequisites)
    // must NOT be shown — this is the defect: it stayed up because the check
    // only compared against last_success, and this later run is a FAILURE.
    await waitFor(() => expect(screen.getByText(/latest run since then failed/i)).toBeTruthy())
    expect(screen.queryByText(/Last cycle blocked by Sam preflight/i)).toBeNull()
  })
})
