import { create } from 'zustand'

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

  saveGrant(id) {
    const current = get().savedIds
    if (current.includes(id)) return
    const next = [...current, id]
    saveToStorage(next)
    set({ savedIds: next })
  },

  removeGrant(id) {
    const next = get().savedIds.filter((s) => s !== id)
    saveToStorage(next)
    set({ savedIds: next })
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
}))
