import { afterEach, describe, expect, it } from 'vitest'
import { __resetAxiosForTests, __setAxiosForTests, requestJson } from '../src/integrations/httpClient.js'
import { searchOrganizations } from '../src/integrations/propublica990.js'
import { makePropublica990Source } from '../services/yana/yanaProspectSources.js'

afterEach(() => __resetAxiosForTests())

const payload = (page, total = 84, organizations = []) => ({
  total_results: total, num_pages: Math.ceil(total / 25), cur_page: page,
  per_page: 25, page_offset: page * 25, organizations,
})
const org = (id) => ({ ein: String(100000000 + id), name: `Foundation ${id}`, ntee_code: 'B82', state: 'TN' })

describe('HTTP errors retain status without being retried as network failures', () => {
  it.each([400, 401, 403, 404])('does not retry HTTP %i and preserves structured response', async (status) => {
    let calls = 0
    const data = { error: 'upstream-secret-sentinel' }
    __setAxiosForTests(async () => { calls++; return { status, data, headers: {} } })
    const error = await requestJson({ url: 'https://example.org/search', maxRetries: 2 }).catch(e => e)
    expect(calls).toBe(1)
    expect(error.response).toEqual({ status, data })
    expect(error.message).toContain(`status=${status}`)
    expect(error.message).not.toContain('upstream-secret-sentinel')
    expect(JSON.stringify(error)).not.toContain('upstream-secret-sentinel')
  })

  it('still retries a 429 using Retry-After and keeps the last real status', async () => {
    let calls = 0
    __setAxiosForTests(async () => { calls++; return { status: 429, data: {}, headers: { 'retry-after': '0' } } })
    const error = await requestJson({ url: 'https://example.org/search', maxRetries: 2 }).catch(e => e)
    expect(calls).toBe(3)
    expect(error.response.status).toBe(429)
  })

  it('still retries transient 503 responses and accepts the recovered result', async () => {
    let calls = 0
    __setAxiosForTests(async () => ++calls === 1
      ? { status: 503, data: {}, headers: {} }
      : { status: 200, data: { recovered: true }, headers: {} })
    await expect(requestJson({ url: 'https://example.org/search', maxRetries: 1 })).resolves.toEqual({ recovered: true })
    expect(calls).toBe(2)
  })
})

describe('official ProPublica search pagination contract', () => {
  it('retains an validated page exhaustion receipt from HTTP 404', async () => {
    let calls = 0
    __setAxiosForTests(async () => { calls++; return { status: 404, data: payload(15), headers: {} } })
    await expect(searchOrganizations({ q: 'education foundation', state: 'TN', page: 15 })).resolves.toMatchObject({
      total_results: 84, num_pages: 4, cur_page: 15, per_page: 25,
      page_exhausted: true, organizations: [],
    })
    expect(calls).toBe(1)
  })

  it('preserves page metadata with normalized real organizations on a successful search', async () => {
    __setAxiosForTests(async () => ({ status: 200, data: payload(2, 84, [org(2)]), headers: {} }))
    const result = await searchOrganizations({ q: 'education foundation', page: 2 })
    expect(result).toMatchObject({ total_results: 84, num_pages: 4, cur_page: 2, page_exhausted: false })
    expect(result.organizations[0]).toMatchObject({ ein: '100000002', name: 'Foundation 2' })
  })

  it.each([
    '<html>Not found</html>',
    { error: 'missing' },
    { ...payload(15), cur_page: 1 },
    { ...payload(15), num_pages: 20 },
    { ...payload(15), organizations: [org(1)] },
    { ...payload(15), total_results: 10000 },
    { ...payload(15), per_page: 0 },
  ])('does not reinterpret an unrelated or malformed 404 as zero results: %j', async (data) => {
    __setAxiosForTests(async () => ({ status: 404, data, headers: {} }))
    await expect(searchOrganizations({ q: 'education foundation', page: 15 })).rejects.toThrow('404')
  })

  it('does not reinterpret a successful but malformed payload as an empty search', async () => {
    __setAxiosForTests(async () => ({ status: 200, data: { maintenance: true }, headers: {} }))
    await expect(searchOrganizations({ q: 'education foundation' })).rejects.toThrow(/organizations|schema/i)
  })
})

describe('Yana recovers persisted cursors within each actual query result set', () => {
  it('replays the observed page-15 failure through the real HTTP, integration, and discovery modules', async () => {
    const calls = []
    __setAxiosForTests(async ({ params }) => {
      calls.push(params.page)
      return { status: params.page >= 4 ? 404 : 200,
        data: payload(params.page, 84, params.page < 4 ? [org(params.page)] : []), headers: {} }
    })
    const source = makePropublica990Source()
    const first = await source.discover({ page: 15, queries: [{ q: 'education foundation', ntee: 'B' }], states: ['TN'] })
    expect(first.map(v => v.ein)).toEqual(['100000003'])
    expect(calls).toEqual([15, 3])
    const second = await source.discover({ page: 16, queries: [{ q: 'education foundation', ntee: 'B' }], states: ['TN'] })
    expect(second.map(v => v.ein)).toEqual(['100000000'])
    expect(calls).toEqual([15, 3, 0])
  })

  it('keeps bounds separate by query and state, retaining deep pages for larger result sets', async () => {
    const calls = []
    __setAxiosForTests(async ({ params }) => {
      const total = params['state[id]'] === 'TN' ? 84 : 500
      const pages = Math.ceil(total / 25)
      calls.push([params['state[id]'], params.page])
      return { status: params.page >= pages ? 404 : 200,
        data: payload(params.page, total, params.page < pages ? [org(total + params.page)] : []), headers: {} }
    })
    const found = await makePropublica990Source().discover({ page: 15, states: ['TN', 'OH'], queries: [{ q: 'education foundation' }] })
    expect(found).toHaveLength(2)
    expect(calls).toEqual([['TN', 15], ['TN', 3], ['OH', 15]])
  })

  it('never fabricates page zero results for an empty query and retries it after the bounded cache expires', async () => {
    let now = 0
    const calls = []
    __setAxiosForTests(async ({ params }) => {
      calls.push(params.page)
      return { status: 404, data: payload(params.page, 0), headers: {} }
    })
    const source = makePropublica990Source({ clock: () => now })
    const options = { page: 15, queries: [{ q: 'empty' }] }
    expect(await source.discover(options)).toEqual([])
    expect(await source.discover(options)).toEqual([])
    expect(calls).toEqual([15])
    now += 16 * 60_000
    expect(await source.discover(options)).toEqual([])
    expect(calls).toEqual([15, 15])
  })

  it('allows cached result counts to grow after expiry instead of freezing the discovery universe', async () => {
    let now = 0
    let total = 84
    const calls = []
    __setAxiosForTests(async ({ params }) => {
      calls.push(params.page)
      const pages = Math.ceil(total / 25)
      return { status: params.page >= pages ? 404 : 200,
        data: payload(params.page, total, params.page < pages ? [org(params.page)] : []), headers: {} }
    })
    const source = makePropublica990Source({ clock: () => now })
    const options = { page: 15, queries: [{ q: 'education foundation' }] }
    await source.discover(options)
    now += 16 * 60_000
    total = 500
    expect((await source.discover(options))[0].ein).toBe('100000015')
    expect(calls).toEqual([15, 3, 15])
  })
})
