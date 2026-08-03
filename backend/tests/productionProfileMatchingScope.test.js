import { describe, expect, it, vi } from 'vitest'

import {
  classifyProductionProfile,
  isProductionMatchingProfile,
} from '../config/productionProfileScope.js'
import {
  assessProfileConfiguration,
  describeUnconfiguredProfile,
} from '../services/profile/profileConfiguration.js'
import {
  searchLocalWebByProfile,
  searchNeedWebLeads,
} from '../services/shared/liveWebSearch.js'
import { loadCrawlerOsProfileResults } from '../services/crawlerOsCompatibility.js'

describe('production matching profile scope', () => {
  it.each([
    'Admin Vault',
    ' admin-vault ',
    'PLAY REVIEW',
  ])('excludes the registered internal profile name %s', (displayName) => {
    const verdict = classifyProductionProfile({ profile: { display_name: displayName } })
    expect(verdict).toMatchObject({ production: false })
    expect(verdict.reason).toMatch(/^registered_internal_profile:/)
    expect(isProductionMatchingProfile({ display_name: displayName })).toBe(false)
  })

  it('keeps legitimate names that only contain generic admin/review words', () => {
    expect(classifyProductionProfile({ display_name: 'Administrative Review Foundation' })).toEqual({
      production: true,
      reason: null,
    })
    expect(classifyProductionProfile({ display_name: 'Play Review Arts Council' }).production).toBe(true)
  })

  it.each([
    [{ is_test: true }, 'explicit_internal_or_test_flag'],
    [{ test_profile: true }, 'explicit_internal_or_test_flag'],
    [{ is_internal: true }, 'explicit_internal_or_test_flag'],
    [{ environment: 'sandbox' }, 'profile_environment:sandbox'],
    [{ profile_environment: 'fixture' }, 'profile_environment:fixture'],
  ])('honors explicit scope metadata %#', (profile, reason) => {
    expect(classifyProductionProfile(profile)).toEqual({ production: false, reason })
  })

  it('blocks internal records at the profile-configuration choke point', () => {
    const verdict = assessProfileConfiguration({
      profile: { id: 'internal-1', display_name: 'Admin Vault' },
      sections: {},
    })

    expect(verdict).toMatchObject({
      unconfigured: true,
      excluded_from_matching: true,
      reason: 'profile_non_production',
    })
    expect(describeUnconfiguredProfile(verdict)).toContain('excluded from production funding matching')
  })

  it('does no local or item web search for an internal profile', async () => {
    const profileContext = { profile: { id: 'internal-2', display_name: 'Play Review' } }

    const local = await searchLocalWebByProfile(profileContext)
    const item = await searchNeedWebLeads({
      needText: 'wheelchair ramp',
      profileContext,
    })

    expect(local.opportunities).toEqual([])
    expect(item.opportunities).toEqual([])
    expect(local.debug).toMatchObject({ skipped: true, raw: 0, queries: [] })
    expect(item.debug).toMatchObject({ skipped: true, raw: 0, queries: [] })
  })

  it('does not replay historical stored matches for an internal profile', async () => {
    const all = vi.fn(() => {
      throw new Error('match rows must not be queried for an internal profile')
    })
    const get = vi.fn(async () => ({ id: 'internal-3', display_name: 'Admin Vault' }))
    const db = {
      dialect: 'postgres',
      prepare(sql) {
        if (/FROM profiles/i.test(sql)) return { get }
        return { all }
      },
    }

    await expect(loadCrawlerOsProfileResults(db, 'internal-3')).resolves.toEqual([])
    expect(get).toHaveBeenCalledOnce()
    expect(all).not.toHaveBeenCalled()
  })
})
