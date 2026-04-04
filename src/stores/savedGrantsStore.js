import { create } from 'zustand'
import { apiFetch } from '@/api/client'

const STORAGE_KEY = 'grantflow:saved-grants'

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveToStorage(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch { /* ignore */ }
}

export const useSavedGrantsStore = create((set, get) => ({
  savedIds: loadFromStorage(),
  /** Map of opportunity_id → notes string (populated after sync) */
  notesMap: {},
  synced: false,

  /** Fetch saved IDs from backend and merge with localStorage cache */
  async sync() {
    try {
      const res = await apiFetch('/api/saved-grants')
      const backendIds = res?.ids ?? []
      const localIds = get().savedIds

      // Merge: anything in local but not backend gets pushed up
      const toUpload = localIds.filter((id) => !backendIds.includes(id))
      await Promise.all(
        toUpload.map((id) =>
          apiFetch('/api/saved-grants', {
            method: 'POST',
            body: JSON.stringify({ opportunity_id: id }),
          }).catch(() => {})
        )
      )

      // Final set = union of both
      const merged = [...new Set([...backendIds, ...localIds])]
      saveToStorage(merged)
      // Build notes map from backend response
      const notes = {}
      for (const row of (res?.saved ?? [])) {
        if (row.notes) notes[row.opportunity_id] = row.notes
      }
      set({ savedIds: merged, notesMap: notes, synced: true })
    } catch {
      // Offline or not logged in — keep localStorage only
      set({ synced: false })
    }
  },

  saveGrant(id) {
    const current = get().savedIds
    if (current.includes(id)) return
    const next = [...current, id]
    saveToStorage(next)
    set({ savedIds: next })
    // Fire-and-forget backend save
    apiFetch('/api/saved-grants', {
      method: 'POST',
      body: JSON.stringify({ opportunity_id: id }),
    }).catch(() => {})
  },

  removeGrant(id) {
    const next = get().savedIds.filter((s) => s !== id)
    saveToStorage(next)
    set({ savedIds: next })
    // Fire-and-forget backend delete
    apiFetch(`/api/saved-grants/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).catch(() => {})
  },

  toggleGrant(id) {
    if (get().savedIds.includes(id)) {
      get().removeGrant(id)
    } else {
      get().saveGrant(id)
    }
  },

  isSaved(id) {
    return get().savedIds.includes(id)
  },

  getNote(id) {
    return get().notesMap[id] ?? ''
  },

  async updateNote(id, notes) {
    set((state) => ({ notesMap: { ...state.notesMap, [id]: notes } }))
    apiFetch(`/api/saved-grants/${encodeURIComponent(id)}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    }).catch(() => {})
  },
}))
