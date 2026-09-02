import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()

vi.mock('@/api/client', () => ({
  apiFetch: apiFetchMock,
}))

const { searchGreenHomePrograms, searchProfileItemNeeds } = await import('./items.js')

describe('searchGreenHomePrograms client', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValue({ success: true, programs: [] })
  })

  it('posts to the profile-scoped strict green-home endpoint', async () => {
    await searchGreenHomePrograms({ profileId: 'profile / one' })

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/item-needs/profile%20%2F%20one/green-home',
      { method: 'POST' },
    )
  })

  it.each([undefined, null, '', 'all', '__admin__'])('rejects invalid profile id %s before calling the API', async (profileId) => {
    await expect(searchGreenHomePrograms({ profileId })).rejects.toThrow(/select a profile/i)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})

describe('searchProfileItemNeeds client', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValue({ success: true, items: [] })
  })

  it('posts verbatim free text to the canonical profile-scoped item engine', async () => {
    await searchProfileItemNeeds({
      profileId: 'profile / one',
      items: ['15 passenger bus for reservation trips'],
      variant: 'gift',
      maxResults: 40,
    })

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/item-needs/profile%20%2F%20one/search',
      {
        method: 'POST',
        body: JSON.stringify({
          items: ['15 passenger bus for reservation trips'],
          variant: 'gift',
          max_results: 40,
        }),
      },
    )
  })

  it('omits items to request the profile-derived whole-item-list search', async () => {
    await searchProfileItemNeeds({ profileId: 'profile-1' })
    const [, options] = apiFetchMock.mock.calls[0]
    expect(JSON.parse(options.body)).toEqual({ variant: 'funding' })
  })

  it.each([undefined, null, '', 'all', '__admin__'])('rejects invalid profile id %s before calling the API', async (profileId) => {
    await expect(searchProfileItemNeeds({ profileId, items: ['DME'] })).rejects.toThrow(/select a profile/i)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
