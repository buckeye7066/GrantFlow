/**
 * Anya `web.search` tool — owner-gated live web search for funding.
 *
 * Verifies: the tool is owner-only (hidden from non-owner admins, rejected at
 * invoke), a direct `query` returns normalized web results, and `profileId`
 * mode returns profile-driven funding leads. The underlying web engine and
 * profile-web search are mocked so the test never touches the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const searchWebMock = vi.fn()
const searchLocalWebByProfileMock = vi.fn()
const loadProfileContextMock = vi.fn()

vi.mock('../services/crawlers/webSearchEngine.js', () => ({
  searchWeb: (...a) => searchWebMock(...a),
}))
vi.mock('../services/crawlers/liveWebSearch.js', () => ({
  searchLocalWebByProfile: (...a) => searchLocalWebByProfileMock(...a),
}))
vi.mock('../services/profileHelpers.js', () => ({
  loadProfileContext: (...a) => loadProfileContextMock(...a),
}))

const { invokeTool, listToolMetadata } = await import('../services/anyaToolRegistry.js')

const OWNER = 'buckeye7066@gmail.com'
const ownerCtx = { ctx: { email: OWNER, isAdmin: true, userId: 'owner-1' }, user: { email: OWNER } }

beforeEach(() => {
  searchWebMock.mockReset()
  searchLocalWebByProfileMock.mockReset()
  loadProfileContextMock.mockReset()
})

describe('web.search tool registration + gating', () => {
  it('is owner-only: hidden from a non-owner admin, visible to the owner', () => {
    const adminTools = listToolMetadata({ isAdmin: true, email: 'other-admin@example.com' }).map((t) => t.name)
    const ownerTools = listToolMetadata({ isAdmin: true, email: OWNER }).map((t) => t.name)
    expect(adminTools).not.toContain('web.search')
    expect(ownerTools).toContain('web.search')
  })

  it('rejects a non-owner admin at invoke time', async () => {
    await expect(
      invokeTool('web.search', { query: 'grants' }, {
        ctx: { isAdmin: true, email: 'other-admin@example.com', userId: 'u2' },
        user: { role: 'admin', email: 'other-admin@example.com' },
      }),
    ).rejects.toThrow(/owner account/i)
    expect(searchWebMock).not.toHaveBeenCalled()
  })
})

describe('web.search behavior', () => {
  it('runs a direct query and returns normalized web results', async () => {
    searchWebMock.mockResolvedValue([
      { url: 'https://bradleyfoundation.org/grants', title: 'Bradley Grants', snippet: 'apply' },
    ])
    const res = await invokeTool('web.search', { query: 'Bradley County TN EMS scholarship', limit: 5 }, ownerCtx)
    expect(searchWebMock).toHaveBeenCalledWith('Bradley County TN EMS scholarship', { count: 5 })
    expect(res.output.results).toHaveLength(1)
    expect(res.output.count).toBe(1)
  })

  it('runs profile-driven lead discovery when given a profileId', async () => {
    loadProfileContextMock.mockResolvedValue({ profile: { id: 'p1' }, signals: {} })
    searchLocalWebByProfileMock.mockResolvedValue({
      opportunities: [
        { title: 'County Scholarship', url: 'https://x.org', sponsor: 'x.org', description: 'd', matched_terms: ['ems grant'] },
      ],
      debug: { queries: ['"Bradley County" scholarship'] },
    })
    const res = await invokeTool('web.search', { profileId: 'p1' }, { ...ownerCtx, db: { prepare: () => ({ run: () => {} }) } })
    expect(loadProfileContextMock).toHaveBeenCalledWith(expect.anything(), 'p1')
    expect(res.output.profile_leads).toHaveLength(1)
    expect(res.output.profile_queries).toEqual(['"Bradley County" scholarship'])
    expect(res.output.count).toBe(1)
  })

  it('reports a helpful note when nothing is found', async () => {
    searchWebMock.mockResolvedValue([])
    const res = await invokeTool('web.search', { query: 'zzz nothing' }, ownerCtx)
    expect(res.output.count).toBe(0)
    expect(res.output.note).toMatch(/best-effort/i)
  })
})
