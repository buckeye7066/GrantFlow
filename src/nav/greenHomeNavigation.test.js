import { describe, expect, it } from 'vitest'
import {
  NAV_GROUPS,
  ROUTE_LABELS,
  getBreadcrumbSegments,
  getGroupIdForRoute,
} from './navConfig.js'
import { END_USER_NAV_GROUPS } from './endUserNavConfig.js'
import { ROUTE_NAMES } from '../pages/routeNames.js'

function routeItems(groups, routeName) {
  return groups.flatMap((group) => group.items || []).filter((item) => item.routeName === routeName)
}

describe('No-Cost Green Home navigation', () => {
  it('appears once in the full/admin Find Funding menu', () => {
    const items = routeItems(NAV_GROUPS, 'GreenHomePrograms')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'No-Cost Green Home Upgrades',
      i18nKey: 'nav.greenHomePrograms',
      url: '/GreenHomePrograms',
    })
    expect(getGroupIdForRoute('/GreenHomePrograms')).toBe('find')
    expect(ROUTE_LABELS.GreenHomePrograms).toBe('No-Cost Green Home Upgrades')
  })

  it('appears once in the end-user My Funding menu', () => {
    const items = routeItems(END_USER_NAV_GROUPS, 'GreenHomePrograms')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'No-Cost Green Home Upgrades',
      i18nKey: 'nav.greenHomePrograms',
      url: '/GreenHomePrograms',
    })
  })

  it('builds a truthful Find Funding breadcrumb', () => {
    const crumbs = getBreadcrumbSegments('/GreenHomePrograms')
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      'Home',
      'Find Funding',
      'No-Cost Green Home Upgrades',
    ])
    expect(crumbs.at(-1)).toMatchObject({
      path: '/GreenHomePrograms',
      labelI18nKey: 'nav.greenHomePrograms',
      isCurrent: true,
    })
  })

  it('registers and labels every route exposed by either sidebar', () => {
    const routeNames = [...NAV_GROUPS, ...END_USER_NAV_GROUPS]
      .flatMap((group) => group.items || [])
      .map((item) => item.routeName)
    for (const routeName of new Set(routeNames)) {
      expect(ROUTE_LABELS[routeName], 'missing label for ' + routeName).toBeTruthy()
      expect(ROUTE_NAMES.has(routeName), 'missing route registration for ' + routeName).toBe(true)
    }
  })
})
