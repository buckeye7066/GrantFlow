// @vitest-environment jsdom
/**
 * Bug #2 — "Add to Pipeline" silently failed ~4 of 5 clicks (live walkthrough
 * 2026-08-03): card keys embedded the list INDEX, so any score re-sort of the
 * discovery list (staleTime 0 + poll refetches) remounted every card and wiped
 * the button's local "Added" state; and a `{ status: 'failed' }` return from
 * the page handler matched no toast branch — no feedback, no state change.
 *
 * Bug #5 (card surface) — a server-flagged `already_in_pipeline` result must
 * render as "Already in pipeline", never as an addable button whose only
 * possible answer is "already".
 */
import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

const { default: SearchResults, AddToPipelineButton } = await import('./SearchResults.jsx')

function wrap(ui) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function makeOpp(overrides = {}) {
  return {
    id: overrides.id ?? 'opp-1',
    title: overrides.title ?? 'TN Promise Scholarship',
    sponsor: overrides.sponsor ?? 'Tennessee Promise',
    application_url: overrides.application_url ?? 'https://www.tnpromise.gov/',
    source_url: overrides.source_url ?? 'https://www.tnpromise.gov/',
    match_score: overrides.match_score ?? 51,
    match_decision: overrides.match_decision ?? 'accept',
    ...overrides,
  }
}

beforeEach(() => {
  toastMock.mockReset()
})

describe('AddToPipelineButton', () => {
  it('a successful add shows "Added" and stays added', async () => {
    const onAdd = vi.fn().mockResolvedValue({ status: 'added' })
    render(wrap(<AddToPipelineButton opportunity={makeOpp()} onAddToPipeline={onAdd} organizationName="Org" />))
    fireEvent.click(screen.getByRole('button', { name: /Add to Pipeline/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Added/i })).toBeTruthy())
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('a swallowed-error `{status:"failed"}` result gives FEEDBACK: destructive toast + Retry add', async () => {
    const onAdd = vi.fn().mockResolvedValue({ status: 'failed', error: 'missing_application_url' })
    render(wrap(<AddToPipelineButton opportunity={makeOpp()} onAddToPipeline={onAdd} organizationName="Org" />))
    fireEvent.click(screen.getByRole('button', { name: /Add to Pipeline/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry add/i })).toBeTruthy())
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive', title: 'Could not add to pipeline' }),
    )
    // Retry is live, idempotent against the same stable opportunity id.
    fireEvent.click(screen.getByRole('button', { name: /Retry add/i }))
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2))
    expect(onAdd.mock.calls.every(([opp]) => opp.id === 'opp-1')).toBe(true)
  })

  it('a server-flagged already_in_pipeline result renders disabled "Already in pipeline" from first paint (#5)', () => {
    const onAdd = vi.fn()
    render(wrap(
      <AddToPipelineButton opportunity={makeOpp({ already_in_pipeline: true })} onAddToPipeline={onAdd} organizationName="Org" />,
    ))
    const btn = screen.getByRole('button', { name: /Already in pipeline/i })
    expect(btn).toBeTruthy()
    expect(btn.disabled).toBe(true)
    expect(onAdd).not.toHaveBeenCalled()
  })
})

describe('SearchResults list keying (the re-render state wipe)', () => {
  it('the "Added" state SURVIVES a list re-sort — keys are stable opportunity identity, not index', async () => {
    const oppA = makeOpp({ id: 'opp-a', title: 'Alpha Grant', application_url: 'https://a.example/apply' })
    const oppB = makeOpp({ id: 'opp-b', title: 'Beta Grant', application_url: 'https://b.example/apply' })
    const onAdd = vi.fn().mockResolvedValue({ status: 'added' })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <SearchResults results={[oppA, oppB]} profileId="p-1" onAddToPipeline={onAdd} organizationName="Org" />
      </QueryClientProvider>,
    )

    const addButtons = screen.getAllByRole('button', { name: /Add to Pipeline/i })
    fireEvent.click(addButtons[0])
    await waitFor(() => expect(screen.getByRole('button', { name: /^Added$/i })).toBeTruthy())

    // Simulate the poll-refetch re-sort: same opportunities, NEW order, NEW
    // object identities (the merge produces fresh objects each time).
    view.rerender(
      <QueryClientProvider client={client}>
        <SearchResults results={[{ ...oppB }, { ...oppA }]} profileId="p-1" onAddToPipeline={onAdd} organizationName="Org" />
      </QueryClientProvider>,
    )

    // The added card must still read "Added" — with index-embedded keys this
    // remounted and silently reverted to an addable "Add to Pipeline".
    expect(screen.getByRole('button', { name: /^Added$/i })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Add to Pipeline/i }).length).toBe(1)
  })

  it('multiple sequential adds each land on their own card and stick', async () => {
    const opps = ['opp-1', 'opp-2', 'opp-3'].map((id, i) =>
      makeOpp({ id, title: `Grant ${i}`, application_url: `https://x${i}.example/apply` }),
    )
    const onAdd = vi.fn().mockResolvedValue({ status: 'added' })
    render(wrap(<SearchResults results={opps} profileId="p-1" onAddToPipeline={onAdd} organizationName="Org" />))

    // Click each card's add in sequence — every click must fire (no dead
    // clicks) and each card must independently reach "Added".
    for (let i = 0; i < 3; i++) {
      const buttons = screen.getAllByRole('button', { name: /Add to Pipeline/i })
      fireEvent.click(buttons[0])
      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Added$/i }).length).toBe(i + 1))
    }
    expect(onAdd).toHaveBeenCalledTimes(3)
    const addedIds = onAdd.mock.calls.map(([opp]) => opp.id).sort()
    expect(addedIds).toEqual(['opp-1', 'opp-2', 'opp-3'])
  })

  it('an already_in_pipeline row is visible with the badge — surfaced, not hidden (#5)', () => {
    const inPipeline = makeOpp({ id: 'opp-tn', already_in_pipeline: true })
    const fresh = makeOpp({ id: 'opp-new', title: 'Fresh Grant', application_url: 'https://fresh.example/apply' })
    render(wrap(<SearchResults results={[inPipeline, fresh]} profileId="p-1" onAddToPipeline={vi.fn()} organizationName="Org" />))

    expect(screen.getByText('TN Promise Scholarship')).toBeTruthy()
    expect(screen.getAllByText(/Already in pipeline/i).length).toBeGreaterThan(0)
    // Only the fresh card is addable.
    expect(screen.getAllByRole('button', { name: /Add to Pipeline/i }).length).toBe(1)
  })
})
