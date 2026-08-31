// @vitest-environment jsdom
/**
 * The watch window has to show the WORK, and it has to be honest about it.
 *
 * The failure mode this page exists to avoid is the one the owner has called
 * out repeatedly: a surface that looks like progress while measuring nothing.
 *
 * The assertions below are written against the defects the owner found in
 * production on 2026-08-21, each of which this test file previously could not
 * have caught — the old version hand-mocked a `title` field the API has never
 * returned, which is exactly why "every card reads Untitled funding source"
 * was invisible to it.
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

/** The shape the API really returns, after hamiltonTaskPresentation. */
function task(overrides = {}) {
  return {
    id: 't-1',
    status: 'ready_to_start',
    automation_type: 'portal',
    display_title: 'A Real Funder Scholarship',
    title_source: 'source_record',
    funder_name: 'A Real Funder',
    apply_url: null,
    outcome_reason: null,
    submitted_by: null,
    updated_at: '2026-08-21T10:00:00Z',
    ...overrides,
  }
}

describe('HamiltonAutomationWatch', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('says the run is empty instead of implying work that is not happening', async () => {
    getMock.mockResolvedValue({ ok: true, tasks: [] })
    renderAt()
    expect(await screen.findByText(/no automation tasks on this profile yet/i)).toBeTruthy()
    expect(screen.getByText(/hamilton is not working right now/i)).toBeTruthy()
  })

  it('counts EVERY task, and the buckets sum to the list', async () => {
    // The production defect: `ready_to_start`, `waiting_for_review`,
    // `completed`, `waiting_for_captcha`, `waiting_for_login` and
    // `filling_portal` were in no counter at all — 523 of 931 tasks.
    getMock.mockResolvedValue({
      ok: true,
      tasks: [
        task({ id: 'a', status: 'filling_portal' }),
        task({ id: 'b', status: 'waiting_for_captcha' }),
        task({ id: 'c', status: 'waiting_for_login' }),
        task({ id: 'd', status: 'ready_to_start' }),
        task({ id: 'e', status: 'completed' }),
        task({ id: 'f', status: 'cancelled' }),
      ],
    })
    renderAt()
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(6))
    // 1 working + 2 need you + 1 waiting + 2 finished = 6 total.
    expect(screen.getByText(/1 working · 2 need you · 1 waiting · 2 finished · 6 in total/)).toBeTruthy()
  })

  it('says Hamilton IS working when a task is filling a portal', async () => {
    getMock.mockResolvedValue({ ok: true, tasks: [task({ status: 'filling_portal' })] })
    renderAt()
    expect(await screen.findByText(/hamilton is working/i)).toBeTruthy()
  })

  it('shows the funder name the API resolved, never a shared placeholder', async () => {
    getMock.mockResolvedValue({
      ok: true,
      tasks: [
        task({ id: 'a', display_title: 'Tennessee HOPE Aspire Award' }),
        task({ id: 'b', display_title: 'studentaid.gov', title_source: 'host' }),
      ],
    })
    renderAt()
    expect(await screen.findByText('Tennessee HOPE Aspire Award')).toBeTruthy()
    expect(screen.getByText('studentaid.gov')).toBeTruthy()
    expect(screen.queryByText(/untitled funding source/i)).toBeNull()
    // A host stand-in is LABELLED as one rather than passed off as a name.
    expect(screen.getByText(/no stored name — showing the site/i)).toBeTruthy()
  })

  it('names the actual wall on a blocked card instead of "open this task"', async () => {
    getMock.mockResolvedValue({
      ok: true,
      tasks: [task({ status: 'waiting_for_captcha', apply_url: 'https://funder.org/apply' })],
    })
    renderAt()
    expect(await screen.findByText(/captcha hamilton's solver could not clear yet/i)).toBeTruthy()
    // And it links somewhere the owner can actually finish it.
    const link = screen.getByRole('link', { name: /open the funder/i })
    expect(link.getAttribute('href')).toBe('https://funder.org/apply')
  })

  it('prefers the reason Hamilton actually recorded over a generic sentence', async () => {
    getMock.mockResolvedValue({
      ok: true,
      tasks: [task({
        status: 'blocked',
        outcome_reason: 'Portal URL is missing',
      })],
    })
    renderAt()
    expect(await screen.findByText('Portal URL is missing')).toBeTruthy()
  })

  it('tells submitted and cancelled apart instead of "finished with this one"', async () => {
    getMock.mockResolvedValue({
      ok: true,
      tasks: [
        task({
          id: 'sub',
          status: 'submitted',
          submitted_at: '2026-08-03T05:29:00Z',
          submitted_by: 'hamilton',
        }),
        task({
          id: 'can',
          status: 'cancelled',
          outcome_reason: 'Cancelled by the 2026-08-03 eligibility/junk audit (dangling or profile-ineligible source).',
        }),
      ],
    })
    renderAt()
    expect(await screen.findByText(/submitted by hamilton, with a captured portal confirmation/i)).toBeTruthy()
    expect(screen.getByText(/cancelled before it was applied for/i)).toBeTruthy()
    expect(screen.getByText(/2026-08-03 eligibility\/junk audit/)).toBeTruthy()
    expect(screen.queryByText(/hamilton is finished with this one/i)).toBeNull()
  })

  it('says who submitted it — Hamilton, a person, or nobody recorded', async () => {
    getMock.mockResolvedValue({
      ok: true,
      tasks: [
        task({ id: 'x', status: 'submitted', submitted_at: '2026-08-03T05:29:00Z', submitted_by: 'owner' }),
        task({ id: 'y', status: 'submitted', submitted_at: '2026-08-03T05:29:00Z', submitted_by: 'unrecorded' }),
      ],
    })
    renderAt()
    expect(await screen.findByText(/marked submitted by a person/i)).toBeTruthy()
    expect(screen.getByText(/nothing recorded who submitted this/i)).toBeTruthy()
  })

  it('never claims a reason that was not recorded', async () => {
    getMock.mockResolvedValue({
      ok: true,
      tasks: [task({ status: 'cancelled', outcome_reason: null })],
    })
    renderAt()
    expect(await screen.findByText(/no reason was recorded for this cancellation/i)).toBeTruthy()
  })

  it('renders a DATE for anything that is not from today', async () => {
    // Without this, a sweep from 2026-08-03 read as if it happened overnight.
    getMock.mockResolvedValue({
      ok: true,
      tasks: [task({ status: 'cancelled', updated_at: '2020-08-03T06:18:34Z' })],
    })
    renderAt()
    const row = await screen.findByRole('listitem')
    expect(row.textContent).toMatch(/2020/)
  })

  it('sorts needs-you first, then most recent inside the bucket', async () => {
    getMock.mockResolvedValue({
      ok: true,
      tasks: [
        task({ id: 'old-block', status: 'blocked', display_title: 'Older wall', updated_at: '2026-08-01T00:00:00Z' }),
        task({ id: 'live', status: 'filling_portal', display_title: 'Live one' }),
        task({ id: 'new-block', status: 'blocked', display_title: 'Newer wall', updated_at: '2026-08-20T00:00:00Z' }),
      ],
    })
    renderAt()
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(rows[0]).toContain('Newer wall')
    expect(rows[1]).toContain('Older wall')
    expect(rows[2]).toContain('Live one')
  })

  it('makes every card — finished ones included — open its own detail view', async () => {
    getMock.mockResolvedValue({
      ok: true,
      tasks: [task({ id: 'done-1', status: 'cancelled', display_title: 'A closed one' })],
    })
    renderAt()
    const link = await screen.findByRole('link', { name: /a closed one/i })
    expect(link.getAttribute('href')).toBe('/HamiltonTask/done-1')
  })

  it('is loud about a status it does not recognise rather than hiding it', async () => {
    getMock.mockResolvedValue({ ok: true, tasks: [task({ status: 'some_new_state' })] })
    renderAt()
    expect(await screen.findByText(/does not recognise/i)).toBeTruthy()
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
