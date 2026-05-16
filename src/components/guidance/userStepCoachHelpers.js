/**
 * userStepCoachHelpers
 * --------------------
 * Pure helpers used by `UserStepCoach.jsx`. Extracted so they can be unit-
 * tested under plain `node --test` without spinning up a JSX transform or
 * a DOM.
 *
 * No React imports allowed in this file.
 */

const SEEN_PREFIX = 'grantflow:guidance:seen:'
const GUIDE_VERSION = 'v1'

/**
 * Page key for a given pathname. The coach looks up
 * `messages.guidance[pageKey]` with this.
 *
 *   "/"               → "Dashboard"  (default landing — always coach there)
 *   "/MyProfiles"     → "MyProfiles"
 *   "/Pipeline/abc"   → "Pipeline"
 *   ""/null/undefined → "Dashboard"  (fail-safe)
 */
export function getPageKey(pathname) {
  if (!pathname || typeof pathname !== 'string') return 'Dashboard'
  const stripped = pathname.replace(/^\/+/, '')
  if (!stripped) return 'Dashboard'
  const first = stripped.split('/')[0]
  return first || 'Dashboard'
}

/**
 * localStorage key for "user has seen the coach for (page, profile)".
 *
 * The admin sentinel `__admin__` and any falsy profile id collapse to
 * "none" so admins don't get a re-trigger storm when they switch between
 * the virtual admin profile and real ones.
 */
export function buildSeenKey(page, activeProfileId) {
  const profilePart =
    activeProfileId && activeProfileId !== '__admin__' ? activeProfileId : 'none'
  return `${SEEN_PREFIX}${page}:${profilePart}:${GUIDE_VERSION}`
}

/**
 * Resolve a guidance entry into a renderable object.
 *
 * Entries are either:
 *   - { title, description, nextRoute? }                       (static)
 *   - (ctx) => { title, description, nextRoute? } | null       (dynamic)
 *
 * Returns:
 *   - the resolved object if it has at least a title or description
 *   - `null` otherwise (the coach silently skips null)
 *
 * Never throws — a buggy guide entry must NOT block page render.
 */
export function resolveGuide(rawGuide, ctx) {
  if (!rawGuide) return null
  try {
    const resolved = typeof rawGuide === 'function' ? rawGuide(ctx) : rawGuide
    if (!resolved || typeof resolved !== 'object') return null
    if (!resolved.title && !resolved.description) return null
    return resolved
  } catch {
    return null
  }
}

export const SEEN_KEY_PREFIX = SEEN_PREFIX
export const SEEN_KEY_VERSION = GUIDE_VERSION
