import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { NAV_GROUPS, getGroupIdForRoute } from './navConfig'
import { readScopedNav, writeScopedNav } from './scopedNavPreferences'

export function useNavGroupsOpen(defaultOpenIds = null, scope = null, groups = NAV_GROUPS) {
  const location = useLocation()
  const activeGroupId = groups.find((group) => group.items.some((item) => item.url === location.pathname))?.groupId || getGroupIdForRoute(location.pathname)
  const defaultsKey = (defaultOpenIds || groups.map((group) => group.groupId)).join(',')
  const read = () => readScopedNav(scope, defaultsKey.split(','), activeGroupId)
  const [state, setState] = useState(() => ({ scope, open: read() }))
  // Never render another account's preferences during the effect transition.
  const openSet = state.scope === scope ? state.open : read()
  useEffect(() => {
    const next = readScopedNav(scope, defaultsKey.split(','), activeGroupId)
    setState({ scope, open: next })
    writeScopedNav(scope, next)
  }, [scope, defaultsKey, activeGroupId])
  const toggleGroup = useCallback((groupId) => {
    setState((previous) => {
      const next = new Set(previous.scope === scope ? previous.open : readScopedNav(scope, defaultsKey.split(','), activeGroupId))
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      writeScopedNav(scope, next)
      return { scope, open: next }
    })
  }, [scope, defaultsKey, activeGroupId])
  return [openSet, toggleGroup]
}
const ADVANCED_TOOLS_KEY = 'grantflow:show-advanced-tools'
export function getShowAdvancedTools() {
  try { return globalThis.localStorage?.getItem(ADVANCED_TOOLS_KEY) === 'true' } catch { return false }
}
export function setShowAdvancedTools(value) {
  try {
    if (value) globalThis.localStorage?.setItem(ADVANCED_TOOLS_KEY, 'true')
    else globalThis.localStorage?.removeItem(ADVANCED_TOOLS_KEY)
  } catch { /* Browser storage is optional. */ }
}
