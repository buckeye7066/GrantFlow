/**
 * Entity list/filter reads must never fall into the backend's silent default
 * page. GET /api/grants (and organizations, profiles, programs, ai) apply
 * validatePagination: no `limit` -> 100 rows, returned as a bare array with no
 * pagination metadata. Production 2026-09-11: callers that omitted a limit
 * analyzed 91 of 125 grants (Reports: 0 awarded, 1 submitted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import client from '@/api/client'
import { GRANT_LIST_FULL_LIMIT } from '@/api/grantListLimits'

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: vi.fn((key) => (store.has(key) ? store.get(key) : null)),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
    removeItem: vi.fn((key) => store.delete(key)),
  }
}

function requestedUrl() {
  const [url] = global.fetch.mock.calls.at(-1)
  return new URL(String(url), 'https://app.example.test')
}

describe('entity client default limit', () => {
  beforeEach(() => {
    const storage = makeLocalStorage()
    global.localStorage = storage
    global.window = { localStorage: storage }
    client.setToken('AT_TEST')
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => [],
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete global.fetch
    delete global.window
    delete global.localStorage
    client.token = null
  })

  it('filter() asks for the full set', async () => {
    await client.entities.Grant.filter({ organization_id: 'org-1' })
    const url = requestedUrl()
    expect(url.pathname).toBe('/api/grants')
    expect(url.searchParams.get('organization_id')).toBe('org-1')
    expect(url.searchParams.get('limit')).toBe(String(GRANT_LIST_FULL_LIMIT))
  })

  it('list() without a limit asks for the full set', async () => {
    await client.entities.Organization.list('name')
    expect(requestedUrl().searchParams.get('limit')).toBe(String(GRANT_LIST_FULL_LIMIT))
  })

  it('leaves resources that do not page by default unchanged', async () => {
    await client.entities.Budget.list()
    expect(requestedUrl().searchParams.get('limit')).toBeNull()
  })

  it('an explicit limit is respected', async () => {
    await client.entities.Grant.list('-created_date', 25)
    expect(requestedUrl().searchParams.get('limit')).toBe('25')
  })
})
