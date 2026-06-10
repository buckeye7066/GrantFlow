import { create } from 'zustand'
import { apiFetch } from '@/api/client'
import { scopedKey } from '@/utils/profileScopedStorage'

// Profile-scoped saved-grants store (RC-14, see docs/PROFILE_SCOPING.md).
//
// Saves belong to the *active profile*, not just the user, so starring a grant
// under one profile never makes it appear under another. We read the canonical
// active profile id straight out of localStorage (the same key authStore
// persists) to avoid an import cycle with authStore — mirroring the approach in
// fundingResultsStore. Persistence uses scopedKey(profileId, 'saved-grants') so
// each profile keeps its own list across switches; clearAllProfileScopedStorage
// already knows the 'grantflow:saved-grants:' prefix.

// localStorage key for a profile. When no profile is active we fall back to the
// legacy flat key, which maps to the backend's empty-string ("no profile") rows.
const LEGACY_KEY = 'grantflow:saved-grants'
function storageKeyFor(profileId) {
  return profileId ? scopedKey(profileId, 'saved-grants') : LEGACY_KEY
}

function getActiveProfileId() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem('grantflow:active-profile-id')
    return raw ? String(raw) : null
  } catch {
    return null
  }
}

function loadIdsFor(profileId) {
  if (typeof window === 'undefined') return []
  const key = storageKeyFor(profileId)
  if (!key) return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveIdsFor(profileId, ids) {
  if (typeof window === 'undefined') return
  const key = storageKeyFor(profileId)
  if (!key) return
  try {
    window.localStorage.setItem(key, JSON.stringify(ids))
  } catch { /* ignore */ }
}

// Build the request suffix / body fragment carrying the profile scope.
function profileQuery(profileId) {
  return profileId ? `?profile_id=${encodeURIComponent(profileId)}` : ''
}

const initialProfileId = getActiveProfileId()

export const useSavedGrantsStore = create((set, get) => ({
  profileId: initialProfileId,
  savedIds: loadIdsFor(initialProfileId),
  /** Map of opportunity_id → notes string (populated after sync) */
  notesMap: {},
  synced: false,

  /** Wipe in-memory saved state (called on logout / session expiry). */
  clear() {
    set({ profileId: null, savedIds: [], notesMap: {}, synced: false })
  },

  /**
   * Re-point the store at `nextProfileId` (called on profile switch). Loads that
   * profile's saved ids from its own localStorage bucket and forces a re-sync.
   * No-op when the profile hasn't actually changed.
   */
  loadForProfile(nextProfileId) {
    const normalized = nextProfileId ? String(nextProfileId) : null
    if (normalized === get().profileId) return
    set({
      profileId: normalized,
      savedIds: loadIdsFor(normalized),
      notesMap: {},
      synced: false,
    })
  },

  /** Fetch saved IDs from backend for the active profile and merge with cache */
  async sync() {
    // Always reconcile against the live active profile first.
    get().loadForProfile(getActiveProfileId())
    const profileId = get().profileId
    try {
      const res = await apiFetch(`/api/saved-grants${profileQuery(profileId)}`)
      const backendIds = res?.ids ?? []
      const localIds = get().savedIds

      // Merge: anything in local but not backend gets pushed up (scoped).
      const toUpload = localIds.filter((id) => !backendIds.includes(id))
      await Promise.all(
        toUpload.map((id) =>
          apiFetch('/api/saved-grants', {
            method: 'POST',
            body: JSON.stringify({ opportunity_id: id, profile_id: profileId || undefined }),
          }).catch(() => {})
        )
      )

      // Final set = union of both
      const merged = [...new Set([...backendIds, ...localIds])]
      saveIdsFor(profileId, merged)
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
    const profileId = get().profileId
    const current = get().savedIds
    if (current.includes(id)) return
    const next = [...current, id]
    saveIdsFor(profileId, next)
    set({ savedIds: next })
    // Fire-and-forget backend save
    apiFetch('/api/saved-grants', {
      method: 'POST',
      body: JSON.stringify({ opportunity_id: id, profile_id: profileId || undefined }),
    }).catch(() => {})
  },

  removeGrant(id) {
    const profileId = get().profileId
    const next = get().savedIds.filter((s) => s !== id)
    saveIdsFor(profileId, next)
    set({ savedIds: next })
    // Fire-and-forget backend delete
    apiFetch(`/api/saved-grants/${encodeURIComponent(id)}${profileQuery(profileId)}`, {
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
    const profileId = get().profileId
    set((state) => ({ notesMap: { ...state.notesMap, [id]: notes } }))
    apiFetch(`/api/saved-grants/${encodeURIComponent(id)}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes, profile_id: profileId || undefined }),
    }).catch(() => {})
  },
}))
