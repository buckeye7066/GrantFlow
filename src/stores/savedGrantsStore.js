import { create } from 'zustand'
import { apiFetch } from '@/api/client'
import client from '@/api/client'

// localStorage cache key. Note: per-user/per-profile partitioning is enforced
// SERVER-side now (RC-14). We keep a single client cache but namespace it by
// the active profile id so reload-while-switched doesn't show another
// profile's saved IDs for a frame.
const STORAGE_KEY_BASE = 'grantflow:saved-grants'

function activeProfileId() {
  try {
    return client?.getActiveProfileId?.() || null
  } catch {
    return null
  }
}

function storageKey() {
  const pid = activeProfileId()
  return pid ? `${STORAGE_KEY_BASE}:profile:${pid}` : STORAGE_KEY_BASE
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(storageKey())
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveToStorage(ids) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(ids))
  } catch { /* ignore */ }
}

export const useSavedGrantsStore = create((set, get) => ({
  savedIds: loadFromStorage(),
  /** Map of opportunity_id → notes string (populated after sync) */
  notesMap: {},
  /**
   * Map of opportunity_id → full opportunity row (populated after sync).
   * The GET /api/saved-grants response LEFT JOINs funding_opportunities, so
   * each saved row already carries title/sponsor/amount/deadline/urls. We keep
   * it here so SavedGrants can render directly — the saved id is a
   * funding_opportunities id, NOT a grants (pipeline) id, so fetching
   * /api/grants/{id} with it always 404'd.
   */
  opportunitiesMap: {},
  synced: false,

  /** Fetch saved IDs from backend (scoped server-side by active profile) and merge with localStorage cache */
  async sync() {
    try {
      // apiFetch automatically attaches the X-Profile-Id header from the
      // shared client. The backend uses that to filter saved_grants by
      // (user, profile-or-NULL), so no extra param is needed here.
      const res = await apiFetch('/api/saved-grants')
      const backendIds = res?.ids ?? []
      const localIds = get().savedIds

      // Merge: anything in local but not backend gets pushed up.
      // POSTs only succeed when an active profile is set; if not, the
      // backend returns 400 and we just keep the local cache. We never
      // silently overwrite another profile's data.
      const pid = activeProfileId()
      const toUpload = pid ? localIds.filter((id) => !backendIds.includes(id)) : []
      await Promise.all(
        toUpload.map((id) =>
          apiFetch('/api/saved-grants', {
            method: 'POST',
            body: JSON.stringify({ opportunity_id: id }),
          }).catch(() => {})
        )
      )

      // Final set = union of both (only if we successfully sent uploads or
      // we already had backend rows — avoids accidentally promoting a stale
      // local cache built under a different profile).
      const merged = pid
        ? [...new Set([...backendIds, ...localIds])]
        : backendIds
      saveToStorage(merged)
      // Build notes + opportunity maps from backend response. The saved rows
      // are LEFT JOINed with funding_opportunities, so they hold the full
      // opportunity payload SavedGrants needs to render each card.
      const notes = {}
      const opportunities = {}
      for (const row of (res?.saved ?? [])) {
        if (row.notes) notes[row.opportunity_id] = row.notes
        if (row.opportunity_id) opportunities[row.opportunity_id] = row
      }
      set({ savedIds: merged, notesMap: notes, opportunitiesMap: opportunities, synced: true })
    } catch {
      // Offline or not logged in — keep localStorage only
      set({ synced: false })
    }
  },

  /**
   * Reload from backend after the active profile changes. Clears the in-memory
   * cache so we never display the previous profile's saved set for a frame.
   */
  async resyncForProfile() {
    set({ savedIds: loadFromStorage(), notesMap: {}, opportunitiesMap: {}, synced: false })
    await get().sync()
  },

  saveGrant(id) {
    const current = get().savedIds
    if (current.includes(id)) return
    const next = [...current, id]
    saveToStorage(next)
    set({ savedIds: next })
    // Fire-and-forget backend save (X-Profile-Id auto-attached by client).
    // The backend rejects with 400 if no active profile is set, in which case
    // the local cache still tracks the intent and the next sync will retry.
    apiFetch('/api/saved-grants', {
      method: 'POST',
      body: JSON.stringify({ opportunity_id: id }),
    }).catch(() => {})
  },

  removeGrant(id) {
    const next = get().savedIds.filter((s) => s !== id)
    saveToStorage(next)
    set({ savedIds: next })
    // Fire-and-forget backend delete (server scopes to the active profile +
    // any legacy NULL row, leaving other profiles' explicit saves intact).
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
