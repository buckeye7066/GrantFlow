const DEFAULT_VNEXT_STATE = 'DISCOVERED'

/**
 * API rows created before the canonical state contract can contain lowercase
 * lifecycle values. Normalize only the representation here; unknown non-empty
 * values stay unknown so the page fails closed instead of enabling a transition.
 */
export function normalizeVNextApplicationState(value) {
  const normalized = String(value ?? '').trim().toUpperCase()
  return normalized || DEFAULT_VNEXT_STATE
}
