// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/api/client'
import { persistGapAnswers } from '../gapInterviewPersistence.js'

/**
 * A section store that can be told to ERASE a field on write — the shape the
 * field mirrors actually produced on 2026-09-08 (a 200, an empty `rejected`,
 * and demographics.veteran_status back to '' on the way out).
 */
function mockSections({ initial = {}, eraseOnWrite = [] } = {}) {
  const store = new Map(Object.entries(initial))
  apiFetch.mockImplementation((url, opts) => {
    if (/\/sections$/.test(url) && !opts) {
      return Promise.resolve(
        [...store.entries()].map(([section_key, data]) => ({ section_key, data })),
      )
    }
    const put = url.match(/^\/api\/profiles\/[^/]+\/sections\/([^/]+)$/)
    if (put && opts?.method === 'PUT') {
      const key = decodeURIComponent(put[1])
      const data = { ...JSON.parse(opts.body).data }
      for (const field of eraseOnWrite) {
        if (field in data) data[field] = ''
      }
      store.set(key, data)
      return Promise.resolve({ ok: true, rejected: [] })
    }
    return Promise.resolve({})
  })
  return store
}

beforeEach(() => { apiFetch.mockReset() })

describe('persistGapAnswers verifies what the row ACTUALLY holds', () => {
  it('reports an answer the save silently erased, even though the PUT said 200 with no rejection', async () => {
    mockSections({ initial: { demographics: {} }, eraseOnWrite: ['veteran_status'] })
    await expect(
      persistGapAnswers('p1', { demographics: { veteran_status: 'Not a veteran' } }),
    ).rejects.toMatchObject({
      code: 'gap_answer_not_persisted',
      dropped: ['demographics.veteran_status'],
    })
  })

  it('accepts an answer that really landed', async () => {
    const store = mockSections({ initial: { military_service: {} } })
    await expect(
      persistGapAnswers('p1', { military_service: { veteran: false } }),
    ).resolves.toBeUndefined()
    expect(store.get('military_service')).toEqual({ veteran: false })
  })

  it('treats an unreadable read-back as UNVERIFIED, not as loss', async () => {
    // No sections come back at all — we could not check, which is not evidence
    // that the answer was lost.
    apiFetch.mockImplementation((url, opts) =>
      opts?.method === 'PUT' ? Promise.resolve({ ok: true }) : Promise.resolve([]),
    )
    await expect(
      persistGapAnswers('p1', { military_service: { veteran: true } }),
    ).resolves.toBeUndefined()
  })

  it('does not false-alarm when long text is merged into what the user already had', async () => {
    const store = new Map([['narrative', { mission: 'We serve Bradley County.' }]])
    apiFetch.mockImplementation((url, opts) => {
      if (/\/sections$/.test(url) && !opts) {
        return Promise.resolve([...store.entries()].map(([section_key, data]) => ({ section_key, data })))
      }
      if (opts?.method === 'PUT') {
        // dedupeLongText splices the new sentence onto the existing prose.
        store.set('narrative', { mission: 'We serve Bradley County. Food and housing help.' })
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve({})
    })
    await expect(
      persistGapAnswers('p1', { narrative: { mission: 'Food and housing help.' } }),
    ).resolves.toBeUndefined()
  })
})
