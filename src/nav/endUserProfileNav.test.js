/**
 * An end user can reach their OWN profile page (owner order 2026-09-07:
 * "he can't see his profile to finish filling it out / building it").
 *
 * The end-user shell listed Dashboard / Calendar / Pipeline / Item Requests /
 * Green Home / Ask Anya and nothing else, and the dashboard's "finish your
 * profile" step sent the person to Anya. Neither reached the profile editor.
 */
import { describe, expect, it } from 'vitest'
import { END_USER_NAV_GROUPS } from './endUserNavConfig.js'
import { pickDashboardNextAction, HIDDEN_END_USER_ROUTES } from '../lib/dashboardNextAction.js'

const items = END_USER_NAV_GROUPS.flatMap((g) => g.items || [])

describe('end-user navigation reaches the profile', () => {
  it('lists My Profile, keyed to the active profile', () => {
    const profile = items.filter((i) => i.routeName === 'ProfileDetail')
    expect(profile).toHaveLength(1)
    expect(profile[0]).toMatchObject({ title: 'My Profile', usesActiveProfile: true })
    expect(profile[0].url).toMatch(/ProfileDetail/)
  })

  it('the thin-profile next step lands on the profile page, not on Anya', () => {
    const action = pickDashboardNextAction({ completionPct: 20, isSimplified: true })
    expect(action).toMatchObject({ key: 'finish_profile', route: 'ProfileDetail', usesActiveProfile: true })
    expect(HIDDEN_END_USER_ROUTES).not.toContain('ProfileDetail')
    expect(HIDDEN_END_USER_ROUTES).toContain('MyProfiles')
  })
})
