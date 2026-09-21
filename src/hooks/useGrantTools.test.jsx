// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ user: { id: 'one' } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select) => select(auth) }))
import { useSavedSearches, useViewHistory, useHiddenGrants } from './useGrantTools'

beforeEach(() => { localStorage.clear(); auth.user = { id: 'one' } })

it('isolates searches, history and hidden grants when accounts switch without unmounting', () => {
  const { result, rerender } = renderHook(() => ({
    searches: useSavedSearches(), history: useViewHistory(), hidden: useHiddenGrants(),
  }))
  act(() => {
    result.current.searches.saveSearch('Housing', { query: 'rent' })
    result.current.history.recordView({ id: 'grant-1', title: 'Housing' })
    result.current.hidden.hideGrant('grant-1')
  })
  auth.user = { id: 'two' }; rerender()
  expect(result.current.searches.savedSearches).toEqual([])
  expect(result.current.history.viewHistory).toEqual([])
  expect(result.current.hidden.isHidden('grant-1')).toBe(false)
  act(() => result.current.searches.saveSearch('Research', { query: 'science' }))
  auth.user = { id: 'one' }; rerender()
  expect(result.current.searches.savedSearches.map(s => s.name)).toEqual(['Housing'])
  expect(result.current.history.isViewed('grant-1')).toBe(true)
  expect(result.current.hidden.isHidden('grant-1')).toBe(true)
})

it('does not assign legacy unowned browser data to a signed-in account', () => {
  localStorage.setItem('grantflow:saved-searches', JSON.stringify([{ name: 'Private legacy search' }]))
  const { result } = renderHook(() => useSavedSearches())
  expect(result.current.savedSearches).toEqual([])
  expect(localStorage.getItem('grantflow:saved-searches')).toContain('Private legacy search')
})

it('handles malformed storage and does not persist signed-out edits', () => {
  localStorage.setItem('grantflow:saved-searches:one', '{}')
  const { result, rerender } = renderHook(() => useSavedSearches())
  expect(result.current.savedSearches).toEqual([])
  auth.user = null; rerender()
  act(() => result.current.saveSearch('Signed out', {}))
  expect(result.current.savedSearches).toEqual([])
})
