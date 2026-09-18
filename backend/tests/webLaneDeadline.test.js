import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runWebDiscoveryLane } from '../crawler-os/webLane.js'
import { createMemoryStore, storage } from '../crawler-os/index.js'
const thesis = { profile_id: 'deadline-fixture', applicant_types: ['nonprofit'], needs: ['youth'], location: { state: 'TN' }, loan_allowed: false }
const urls = ['https://fixture.invalid/grant-a', 'https://fixture.invalid/grant-b']
const html = '<main>A source page for a youth funding program.</main>'
let store, deps
beforeEach(() => {
  vi.useFakeTimers()
  store = createMemoryStore()
  deps = { store, searchWeb: vi.fn(async () => []), fetcher: { fetch: vi.fn(async url => ({ ok: true, body: html, finalUrl: url })) }, extractOpportunities: vi.fn(async () => []) }
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
const options = () => ({ thesis, maxQueries: 1, seedPages: urls.map(url => ({ url })), deadlineMs: Date.now() + 100 })
it('does no search, fetch or extraction after a pre-aborted caller', async () => {
  const result = await runWebDiscoveryLane(deps, { ...options(), signal: AbortSignal.abort() })
  expect(result).toMatchObject({ ok: false, reason: 'aborted' })
  expect(deps.searchWeb).not.toHaveBeenCalled()
  expect(deps.fetcher.fetch).not.toHaveBeenCalled()
  expect(deps.extractOpportunities).not.toHaveBeenCalled()
})
it.each(['search', 'fetch', 'extract'])('bounds an uncooperative %s dependency and starts no later page', async phase => {
  let passedSignal
  const hang = vi.fn((...args) => { passedSignal = args[1]?.signal; return new Promise(() => {}) })
  if (phase === 'search') deps.searchWeb = hang
  if (phase === 'fetch') deps.fetcher.fetch = hang
  if (phase === 'extract') deps.extractOpportunities = hang
  let result
  runWebDiscoveryLane(deps, options()).then(value => { result = value })
  await vi.advanceTimersByTimeAsync(101)
  expect(result).toMatchObject({ ok: false, reason: 'time_budget_exhausted' })
  expect(passedSignal?.aborted).toBe(true)
  expect(hang).toHaveBeenCalledTimes(1)
  expect(storage.listCatalog(store)).toHaveLength(0)
})
it('passes the remaining whole deadline, not a new full budget, to extraction', async () => {
  deps.searchWeb.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return [] })
  deps.fetcher.fetch.mockImplementation(async url => { await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true, body: html, finalUrl: url } })
  const pending = runWebDiscoveryLane(deps, { ...options(), seedPages: [{ url: urls[0] }] })
  await vi.advanceTimersByTimeAsync(41)
  await pending
  expect(deps.extractOpportunities.mock.calls[0][1].timeoutMs).toBe(60)
  expect(deps.extractOpportunities.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
})
it('discards late extraction output instead of storing it after cancellation', async () => {
  const controller = new AbortController()
  let resolveExtraction
  deps.extractOpportunities.mockImplementation(() => new Promise(resolve => { resolveExtraction = resolve }))
  let result
  runWebDiscoveryLane(deps, { ...options(), signal: controller.signal }).then(value => { result = value })
  await vi.advanceTimersByTimeAsync(1)
  controller.abort()
  await vi.advanceTimersByTimeAsync(1)
  expect(result).toMatchObject({ ok: false, reason: 'aborted' })
  resolveExtraction([{ title: 'Youth Foundation Grant', funder: 'Youth Foundation', summary: 'Grants for nonprofits serving youth', apply_url: urls[0], state: 'TN' }])
  await vi.advanceTimersByTimeAsync(1)
  expect(storage.listCatalog(store)).toHaveLength(0)
  expect(deps.fetcher.fetch).toHaveBeenCalledTimes(1)
})
