// @vitest-environment jsdom
/**
 * The watch window has to show the WORK, and it has to be honest about it.
 *
 * The failure mode this page exists to avoid is the one the owner has called
 * out repeatedly: a surface that looks like progress while measuring nothing.
 * So the assertions here are about honesty, not decoration —
 *
 *  - an empty run says it is empty instead of spinning forever,
 *  - "needs you" sorts above "working", because a blocked task is the only
 *    thing on the page the user can actually act on,
 *  - the steps rendered are the task events the orchestrator really wrote,
 *  - and the page says out loud that closing it does not stop the run.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/api/client', () => ({ default: { get: (...a) => getMock(...a) } }))

const HamiltonAutomationWatch = (await import('../HamiltonAutomationWatch.jsx')).default

function renderAt(search = '?profile=profile-1') {
  return render(
    <MemoryRouter initialEntries={[`/HamiltonAutomationWatch${search}`]}>
      <HamiltonAutomationWatch />
    </MemoryRouter>,
  )
}

describe('HamiltonAutomationWatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('says the run is empty instead of implying work that is not happening', async () => {
    getMock.mockResolvedValue({ ok: true, tasks: [] })
    renderAt()
    expect(await screen.findByText(/no automation tasks on this profile yet/i)).toBeTruthy()
    expect(screen.getByText(/hamilton is not working right now/i)).toBeTruthy()
  })

  it('shows the steps Hamilton actually wrote, and puts "needs you" first', async () => {
    getMock.mockImplementation(async (url) => {
      if (url.includes('/tasks?')) {
        return {
          ok: true,
          tasks: [
            { id: 't-live', title: 'Working source', status: 'in_progress' },
            { id: 't-blocked', title: 'Stuck source', status: 'blocked_captcha' },
          ],
        }
      }
      if (url.includes('t-blocked')) {
        return { ok: true, events: [{ id: 'e1', step: 'open_portal', status: 'blocked', message: 'CAPTCHA wall', created_at: '2026-08-21T10:00:00Z' }] }
      }
      return { ok: true, events: [{ id: 'e2', step: 'fill_form', status: 'ok', message: 'Filled 12 fields', created_at: '2026-08-21T10:01:00Z' }] }
    })
    renderAt()

    await waitFor(() => expect(screen.getByText('Stuck source')).toBeTruthy())
    // Needs-you before working: the blocked row is the actionable one.
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(rows[0]).toContain('Stuck source')
    expect(rows.join(' ')).toContain('Working source')
    // Real event text, not a placeholder.
    await waitFor(() => expect(screen.getByText(/CAPTCHA wall/)).toBeTruthy())
    expect(screen.getByText(/Filled 12 fields/)).toBeTruthy()
    expect(screen.getByText(/hamilton is working/i)).toBeTruthy()
  })

  it('tells the user that closing the window does not stop the run', async () => {
    getMock.mockResolvedValue({ ok: true, tasks: [] })
    renderAt()
    expect(await screen.findByText(/the run keeps going without it/i)).toBeTruthy()
  })

  it('refuses to pretend when it was opened with no profile', async () => {
    renderAt('')
    expect(await screen.findByText(/nothing to watch/i)).toBeTruthy()
    expect(getMock).not.toHaveBeenCalled()
  })
})
