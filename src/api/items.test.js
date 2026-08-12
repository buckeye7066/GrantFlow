import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()

vi.mock('@/api/client', () => ({
  apiFetch: apiFetchMock,
}))

const { searchGreenHomePrograms } = await import('./items.js')

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
