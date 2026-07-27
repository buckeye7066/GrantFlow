/**
 * Default-open policy for sidebar nav groups.
 *
 * The collapsible sidebar persists open groups in localStorage, and the
 * route-change effect auto-persists the active group on every navigation —
 * so "storage has a value" never distinguishes a deliberate user choice from
 * bootstrap noise. A logout also wipes profile-scoped storage. Net effect:
 * after any re-login every group except the active one rendered collapsed,
 * and an admin's Setup/Find/Work/Admin tabs (My Profiles included) all
 * "disappeared" behind closed group headers.
 *
 * Policy: the FIRST time a browser renders a nav that declares default-open
 * groups (the admin workspace declares all of them), open those groups once
 * and stamp a marker. From then on the user's own expand/collapse choices are
 * authoritative — collapsing a group sticks across sessions until storage is
 * cleared, at which point the defaults apply once again.
 */
export const NAV_DEFAULTS_APPLIED_KEY = 'grantflow:nav-groups-default-applied'

/**
 * Pure decision: given the currently-open set and the declared defaults,
 * return the Set to use, or null when nothing needs to change (no defaults
 * declared, marker already seen, or every default is already open).
 */
export function applyDefaultOpenGroups(openSet, markerSeen, defaultIds) {
  if (markerSeen) return null
  if (!Array.isArray(defaultIds) || defaultIds.length === 0) return null
  const next = new Set(openSet ?? [])
  let changed = false
  for (const id of defaultIds) {
    if (id && !next.has(id)) {
      next.add(id)
      changed = true
    }
  }
  return changed ? next : null
}

export function getNavDefaultsMarkerSeen() {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(NAV_DEFAULTS_APPLIED_KEY) === 'true'
  } catch {
    return true
  }
}

export function setNavDefaultsMarkerSeen() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(NAV_DEFAULTS_APPLIED_KEY, 'true')
  } catch {
    /* best-effort: a blocked localStorage just means defaults may re-apply */
  }
}
