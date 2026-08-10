/**
 * Augmented navigation source.
 *
 * `navConfigBase.js` is the pre-green-home configuration copied byte-for-byte
 * from the prior authoritative module. This wrapper adds the real no-cost home
 * upgrade route while keeping every existing export and behavior intact.
 */
import { Leaf } from 'lucide-react'
import { createPageUrl } from '@/utils'
import * as base from './navConfigBase.js'

export * from './navConfigBase.js'

const GREEN_HOME_ITEM = Object.freeze({
  title: 'No-Cost Green Home Upgrades',
  i18nKey: 'nav.greenHomePrograms',
  routeName: 'GreenHomePrograms',
  url: createPageUrl('GreenHomePrograms'),
  icon: Leaf,
})

export const NAV_GROUPS = base.NAV_GROUPS.map((group) => {
  if (group.groupId !== 'find') return group
  const items = [...group.items]
  const insertAfter = items.findIndex((item) => item.routeName === 'DiscoverGrants')
  items.splice(insertAfter >= 0 ? insertAfter + 1 : 0, 0, GREEN_HOME_ITEM)
  return { ...group, items }
})

export const ROUTE_LABELS = Object.freeze({
  ...base.ROUTE_LABELS,
  GreenHomePrograms: 'No-Cost Green Home Upgrades',
})

export const ROUTE_LABEL_I18N = Object.freeze({
  ...base.ROUTE_LABEL_I18N,
  GreenHomePrograms: 'nav.greenHomePrograms',
})

export function getGroupIdForRoute(pathname) {
  const segment = String(pathname || '').replace(/^\//, '').split('/')[0] || 'Dashboard'
  const routeName = segment.split('?')[0]
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => item.routeName === routeName)) return group.groupId
  }
  return 'home'
}

export function getBreadcrumbSegments(pathname, search = '') {
  const segment = String(pathname || '').replace(/^\//, '').split('/')[0] || 'Dashboard'
  const routeName = segment.split('?')[0]
  const groupId = getGroupIdForRoute(pathname)
  const group = NAV_GROUPS.find((candidate) => candidate.groupId === groupId)
  const pageLabel = ROUTE_LABELS[routeName] ?? routeName
  const pageLabelI18nKey = ROUTE_LABEL_I18N[routeName]
  const home = {
    path: createPageUrl('Dashboard'),
    label: 'Home',
    labelI18nKey: 'breadcrumb.home',
  }
  if (routeName === 'Dashboard' || routeName === '') return [home]

  const currentPath = String(pathname || '') + (search ? `?${search}` : '')
  const isSingleItemGroup = group?.items?.length === 1
  const isHomeGroup = groupId === 'home'
  if (isSingleItemGroup || isHomeGroup) {
    return [
      home,
      {
        path: currentPath,
        label: pageLabel,
        labelI18nKey: pageLabelI18nKey,
        isCurrent: true,
      },
    ]
  }

  return [
    home,
    {
      path: group?.items?.[0]?.url ?? createPageUrl('Dashboard'),
      label: group?.label ?? 'App',
      labelI18nKey: group?.groupI18nKey,
    },
    {
      path: currentPath,
      label: pageLabel,
      labelI18nKey: pageLabelI18nKey,
      isCurrent: true,
    },
  ]
}
