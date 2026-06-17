import React, { createContext, useCallback, useMemo, useState } from 'react'

/**
 * YanaSelectionContext
 *
 * Tracks which pipeline / GrantCard items the user has selected for the
 * "Automate selected with Yana" bulk action. Selection is keyed by a
 * tuple of (grant_id?, opportunity_id?). The context is intentionally
 * tiny so it can wrap the entire pipeline / search results / grant
 * details surfaces without forcing prop drilling.
 *
 * The provider is enabled with `enabled` so callers that don't want
 * selection (e.g. read-only views) can render children unaffected.
 */

const NoOpContext = {
  enabled: false,
  selected: new Map(),
  isSelected: () => false,
  toggle: () => {},
  clear: () => {},
  selectMany: () => {},
  getSelectedSources: () => [],
}

// Exported under a deliberately ugly name so the only hook accessor lives
// in `useYanaSelection.js` (react-refresh wants components-only files).
// eslint-disable-next-line react-refresh/only-export-components
export const YanaSelectionContextRaw = createContext(NoOpContext)
const Ctx = YanaSelectionContextRaw

function keyFor({ grant_id = null, opportunity_id = null } = {}) {
  return `${grant_id || ''}::${opportunity_id || ''}`
}

export function YanaSelectionProvider({ enabled = true, children }) {
  const [selected, setSelected] = useState(() => new Map())

  const toggle = useCallback((source) => {
    if (!source || (!source.grant_id && !source.opportunity_id)) return
    setSelected((prev) => {
      const next = new Map(prev)
      const k = keyFor(source)
      if (next.has(k)) next.delete(k)
      else next.set(k, source)
      return next
    })
  }, [])

  const clear = useCallback(() => setSelected(new Map()), [])

  const selectMany = useCallback((sources) => {
    setSelected((prev) => {
      const next = new Map(prev)
      for (const s of sources || []) {
        if (!s || (!s.grant_id && !s.opportunity_id)) continue
        next.set(keyFor(s), s)
      }
      return next
    })
  }, [])

  const isSelected = useCallback((source) => selected.has(keyFor(source || {})), [selected])

  const getSelectedSources = useCallback(() => Array.from(selected.values()), [selected])

  const value = useMemo(() => ({
    enabled,
    selected,
    toggle,
    clear,
    selectMany,
    isSelected,
    getSelectedSources,
  }), [enabled, selected, toggle, clear, selectMany, isSelected, getSelectedSources])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// The hook lives in `./useYanaSelection.js` to keep this file
// component-only for react-refresh.
// eslint-disable-next-line react-refresh/only-export-components
export { useYanaSelection } from './useYanaSelection.js'
