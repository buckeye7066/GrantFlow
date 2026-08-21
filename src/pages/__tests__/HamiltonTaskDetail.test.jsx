// @vitest-environment jsdom
/**
 * The detail view is what a finished card now opens.
 *
 * Before it existed there was no URL that opened a Hamilton task at all, so a
 * terminal card ended in "Hamilton is finished with this one." — one sentence
 * shown identically for a real submission and for a task a boot sweep killed.
 *
 * These assertions cover one card of EACH terminal state, plus the honesty
 * rule that matters most here: a reason the system never recorded is reported
 * as unrecorded, never invented.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/api/client', () => ({ default: { get: (...a) => getMock(...a) } }))

const HamiltonTaskDetail = (await import('../HamiltonTaskDetail.jsx')).default

function renderTask(task, events = []) {
  getMock.mockResolvedValue({ ok: true, task, events, missing: [] })
  return render(
    <MemoryRouter initialEntries={[`/HamiltonTask/${task.id}`]}>
      <Routes>
        <Route path="/HamiltonTask/:taskId" element={<HamiltonTaskDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

const base = {
  id: 't-1',
  display_title: 'QuestBridge National College Match',
  title_source: 'source_record',
  funder_name: 'National Program',
  apply_url: 'https://www.questbridge.org/',
  automation_type: 'portal',
  updated_at: '2026-08-03T05:29:00Z',
}

describe('HamiltonTaskDetail — one card of each terminal state', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('SUBMITTED names the funder, the destination, the time and who submitted', async () => {
    renderTask({
      ...base,
      status: 'submitted',
      submitted_at: '2026-08-03T05:29:48Z',
      submitted_by: 'hamilton',
      outcome_reason: 'Hamilton Autopilot submitted: reference captured in run record',
    })
    expect(await screen.findByText('QuestBridge National College Match')).toBeTruthy()
    expect(screen.getByText(/hamilton submitted this itself/i)).toBeTruthy()
    expect(screen.getByText(/reference captured in run record/i)).toBeTruthy()
    // The destination, as a real link.
    expect(screen.getByRole('link', { name: /questbridge\.org/ }).getAttribute('href'))
      .toBe('https://www.questbridge.org/')
  })

  it('SUBMITTED by a person is not reported as Hamilton having submitted it', async () => {
    renderTask({ ...base, status: 'submitted', submitted_at: '2026-08-03T05:29:48Z', submitted_by: 'owner' })
    expect(await screen.findByText(/a person marked this submitted in the application tracker/i)).toBeTruthy()
    expect(screen.getByText(/grantflow did not transmit anything/i)).toBeTruthy()
  })

  it('CANCELLED shows the reason the sweep actually recorded', async () => {
    renderTask({
      ...base,
      status: 'cancelled',
      cancelled_at: '2026-08-03T06:18:34Z',
      outcome_reason: 'Cancelled by the 2026-08-03 eligibility/junk audit (dangling or profile-ineligible source).',
      terminal_actor_role: 'system',
    })
    expect(await screen.findByText(/cancelled before it was applied for/i)).toBeTruthy()
    expect(screen.getByText(/2026-08-03 eligibility\/junk audit/)).toBeTruthy()
  })

  it('CANCELLED with no recorded reason SAYS SO instead of inventing one', async () => {
    renderTask({ ...base, status: 'cancelled', outcome_reason: null })
    expect(await screen.findByText(/no reason was recorded for this cancellation/i)).toBeTruthy()
    expect(screen.getByText(/will not guess/i)).toBeTruthy()
  })

  it('FAILED shows the real error, or admits none was recorded', async () => {
    renderTask({ ...base, status: 'failed', outcome_reason: 'portal_unreachable after 3 attempts' })
    expect(await screen.findByText('Failed')).toBeTruthy()
    expect(screen.getByText(/portal_unreachable after 3 attempts/)).toBeTruthy()
  })

  it('COMPLETED is not dressed up as a submission', async () => {
    renderTask({
      ...base,
      status: 'completed',
      completed_at: '2026-08-03T04:09:12Z',
      outcome_reason: 'Hamilton prepared a funder-contact packet under profile Documents.',
      output_document_id: 'doc-9',
    })
    expect(await screen.findByText(/prepared a funder-contact packet/i)).toBeTruthy()
    // The outcome heading says Completed; the substatus line says the raw
    // status. Neither may imply a submission happened.
    expect(screen.queryByText(/submitted by/i)).toBeNull()
    expect(screen.queryByText(/hamilton submitted this itself/i)).toBeNull()
    // The artifact is offered, and honestly labelled as not being proof.
    expect(screen.getByRole('link', { name: /document/i }).getAttribute('href'))
      .toBe('/api/documents/doc-9/download')
    expect(screen.getByText(/a drafted packet is not proof of submission/i)).toBeTruthy()
  })

  it('renders the run timeline the dashboard used to drop for finished tasks', async () => {
    renderTask({ ...base, status: 'cancelled' }, [
      { id: 'e1', step: 'classification', status: 'analyzing', actor_role: 'agent', message: 'Hamilton GUESSED "portal"', created_at: '2026-08-03T04:00:00Z' },
      { id: 'e2', event_type: 'cancelled', status: 'cancelled', actor_role: 'system', message: 'Closed by the junk audit', created_at: '2026-08-03T06:18:34Z' },
    ])
    expect(await screen.findByText(/step-by-step \(2 events\)/i)).toBeTruthy()
    expect(screen.getByText(/Hamilton GUESSED "portal"/)).toBeTruthy()
    expect(screen.getByText(/Closed by the junk audit/)).toBeTruthy()
  })

  it('a BLOCKED task names the wall, what is needed, and where to finish it', async () => {
    renderTask({
      ...base,
      status: 'waiting_for_captcha',
      outcome_reason: 'Auth gate (captcha); deferring.',
      missing_fields: ['first name'],
      required_user_actions: ['solve the captcha'],
    })
    expect(await screen.findByText(/hamilton stopped here/i)).toBeTruthy()
    expect(screen.getByText('first name')).toBeTruthy()
    expect(screen.getByText('solve the captcha')).toBeTruthy()
    expect(screen.getByRole('link', { name: /finish it yourself/i })).toBeTruthy()
  })

  it('is honest when a task has no identity left at all', async () => {
    renderTask({ id: 't-x', status: 'cancelled', display_title: 'Unnamed source (t-x)', title_source: 'none', apply_url: null })
    expect(await screen.findByText(/neither a stored funder name nor a usable application URL/i)).toBeTruthy()
    expect(screen.getByText(/no application or portal URL is recorded/i)).toBeTruthy()
  })
})
