import { create } from 'zustand'
import client, { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'

function activeScope() {
  const user = useAuthStore.getState().user
  const profileId = client.getActiveProfileId?.() || null
  return { userId: user?.id || null, profileId, key: user?.id && profileId ? String(user.id) + ':' + String(profileId) : null }
}
const storageKey = (scope) => 'grantflow:saved-work:v2:' + encodeURIComponent(scope.key || '')
function readPending(scope) {
  try {
    const parsed = scope.key ? JSON.parse(localStorage.getItem(storageKey(scope)) || '{}') : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}
function persistPending(scope, pending) {
  try { if (scope.key) localStorage.setItem(storageKey(scope), JSON.stringify(pending)) } catch { /* Keep failed intent in memory when storage is unavailable. */ }
}
const empty = () => ({ savedIds: [], notesMap: {}, opportunitiesMap: {}, synced: false, syncing: false, syncError: null, writing: {}, pending: {} })
let generation = 0
let readRevision = 0
let syncingPromise = null

/** Confirm writes before claiming success; never resurrect server-deleted bookmarks from a cache. */
export const useSavedGrantsStore = create((set, get) => ({
  ...empty(), scopeKey: null,
  resetForScope() {
    const scope = activeScope()
    generation += 1
    syncingPromise = null
    set({ ...empty(), scopeKey: scope.key, pending: readPending(scope) })
  },
  async sync() {
    const scope = activeScope()
    if (get().scopeKey !== scope.key) get().resetForScope()
    if (!scope.key) { set({ syncError: 'Select an available funding profile to see saved opportunities.' }); return false }
    if (syncingPromise) return syncingPromise
    const ticket = generation
    const revision = readRevision
    const valid = () => ticket === generation && revision === readRevision && activeScope().key === scope.key
    set({ syncing: true, syncError: null })
    syncingPromise = (async () => {
      try {
        const response = await apiFetch('/api/saved-grants?profile_id=' + encodeURIComponent(scope.profileId))
        if (!Array.isArray(response?.ids) || !Array.isArray(response?.saved)) throw new Error('Invalid saved-work response')
        if (!valid()) return false
        const opportunitiesMap = {}, notesMap = {}
        for (const row of response.saved) {
          if (!row?.opportunity_id) continue
          opportunitiesMap[row.opportunity_id] = row
          notesMap[row.opportunity_id] = row.notes || ''
        }
        set({ savedIds: response.ids, opportunitiesMap, notesMap, synced: true, syncing: false, syncError: null })
        return true
      } catch {
        if (valid()) set({ synced: false, syncing: false, syncError: 'Your saved opportunities could not be checked. Your previous work has not been erased. Try again.' })
        return false
      } finally { if (valid()) syncingPromise = null }
    })()
    return syncingPromise
  },
  async resyncForProfile() {
    if (get().scopeKey !== activeScope().key) get().resetForScope()
    return get().sync()
  },
  async writeOperation(id, operation) {
    const scope = activeScope()
    if (get().scopeKey !== scope.key) get().resetForScope()
    if (!scope.key || !id) { set({ syncError: 'Select an available funding profile before saving.' }); return false }
    if (get().writing[id]) return false
    const ticket = generation
    const valid = () => ticket === generation && activeScope().key === scope.key
    readRevision += 1
    syncingPromise = null
    set({ syncing: false })
    const pending = { ...get().pending, [id]: operation }
    persistPending(scope, pending)
    set({ pending, writing: { ...get().writing, [id]: true } })
    try {
      const suffix = '?profile_id=' + encodeURIComponent(scope.profileId)
      if (operation.kind === 'save') {
        await apiFetch('/api/saved-grants' + suffix, { method: 'POST', body: JSON.stringify({ opportunity_id: id }) })
      } else if (operation.kind === 'remove') {
        await apiFetch('/api/saved-grants/' + encodeURIComponent(id) + suffix, { method: 'DELETE' })
      } else if (operation.kind === 'note' && typeof operation.notes === 'string') {
        await apiFetch('/api/saved-grants/' + encodeURIComponent(id) + '/notes' + suffix, { method: 'PATCH', body: JSON.stringify({ notes: operation.notes }) })
      } else throw new Error('Unsupported saved-work operation')
      if (!valid()) return false
      const remaining = { ...get().pending }; delete remaining[id]
      persistPending(scope, remaining)
      set((state) => ({
        pending: remaining,
        savedIds: operation.kind === 'save' ? [...new Set([...state.savedIds, id])] : operation.kind === 'remove' ? state.savedIds.filter((value) => value !== id) : state.savedIds,
        notesMap: operation.kind === 'note' ? { ...state.notesMap, [id]: operation.notes } : state.notesMap,
      }))
      // A refresh that began before this write must not replace the confirmed result.
      readRevision += 1
      syncingPromise = null
      set({ syncing: false })
      return true
    } catch {
      return false
    } finally {
      // Scope, rather than generation, owns per-item feedback when two different writes finish.
      if (activeScope().key === scope.key && get().scopeKey === scope.key) {
        set((state) => { const writing = { ...state.writing }; delete writing[id]; return { writing } })
      }
    }
  },
  saveGrant(id) { return get().writeOperation(id, { kind: 'save' }) },
  removeGrant(id) { return get().writeOperation(id, { kind: 'remove' }) },
  toggleGrant(id) { return get().savedIds.includes(id) ? get().removeGrant(id) : get().saveGrant(id) },
  isSaved(id) { return get().savedIds.includes(id) },
  getNote(id) { return get().notesMap[id] ?? '' },
  updateNote(id, notes) { return get().writeOperation(id, { kind: 'note', notes }) },
  async retryPending() {
    for (const [id, operation] of Object.entries(get().pending)) {
      if (activeScope().key !== get().scopeKey) return false
      if (!(await get().writeOperation(id, operation))) return false
    }
    return get().sync()
  },
}))
// Clear in-memory private records synchronously at an account/profile transition.
useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id || state.activeProfileId !== previous.activeProfileId) useSavedGrantsStore.getState().resetForScope()
})
