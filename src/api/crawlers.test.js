import { describe, it, expect, vi, beforeEach } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
vi.mock('@/api/client', () => ({ apiFetch: (...args) => apiFetchMock(...args) }))

import { runRealCrawler } from './crawlers'

describe('runRealCrawler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiFetchMock.mockResolvedValue({ success: true, opportunities: [] })
  })

  it('throws when profile_id is missing', async () => {
    // Pass object with no profileId key at all
    await expect(runRealCrawler({ crawlerType: 'local_funding' })).rejects.toThrow(
      /profile_id is required|Select a profile/
    )
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('throws when profileId key is explicitly undefined', async () => {
    await expect(runRealCrawler({ profileId: undefined, crawlerType: 'local_funding' })).rejects.toThrow(
      /profile_id is required|Select a profile/
    )
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('throws when profile_id is empty string', async () => {
    await expect(
      runRealCrawler({ profileId: '', crawlerType: 'local_funding' })
    ).rejects.toThrow(/profile_id is required|Select a profile/)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('throws when profile_id is whitespace only', async () => {
    await expect(
      runRealCrawler({ profileId: '   ', crawlerType: 'local_funding' })
    ).rejects.toThrow(/profile_id is required|Select a profile/)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('includes profile_id in request body and returns opportunities', async () => {
    const fakeOpportunities = [{ id: 'opp-1', title: 'Test Grant' }]
    apiFetchMock.mockResolvedValueOnce({ success: true, opportunities: fakeOpportunities })

    const result = await runRealCrawler({
      profileId: 'profile-123',
      crawlerType: 'local_funding',
      minMatchScore: 60,
    })

    // Verify correct endpoint
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/real-crawlers/run',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      })
    )

    // Verify request body fields
    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body)
    expect(body.profile_id).toBe('profile-123')
    expect(body.crawler_type).toBe('local_funding')
    expect(body.min_match_score).toBe(60)

    // Verify opportunities are returned to caller (pipeline feed)
    expect(result.opportunities).toEqual(fakeOpportunities)
    expect(result.success).toBe(true)
  })

  it('propagates error response from API', async () => {
    apiFetchMock.mockResolvedValueOnce({ success: false, error: 'Crawler failed' })
    await expect(
      runRealCrawler({ profileId: 'profile-123', crawlerType: 'local_funding' })
    ).rejects.toThrow(/Crawler failed/)
  })
})
