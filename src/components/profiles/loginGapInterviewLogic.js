import { isRealProfileId } from '@/api/profileIdGuards'

/**
 * Decision logic for LoginGapInterviewLauncher (Anya's login-time gap
 * interview). Kept in its own module (no component exports) so it is
 * unit-testable and fast-refresh friendly.
 */

export const MAX_PROFILES_PER_LOGIN = 5
export const SNOOZE_KEY_PREFIX = 'gap-interview-snooze:'

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

/** Has this profile's interview been dismissed for the current browser session? */
export function isProfileSnoozed(profileId, storage = defaultStorage()) {
  if (!storage || !profileId) return false
  try {
    return Boolean(storage.getItem(`${SNOOZE_KEY_PREFIX}${profileId}`))
  } catch {
    return false
  }
}

/** Snooze a profile's interview for the rest of the browser session. */
export function snoozeProfile(profileId, storage = defaultStorage()) {
  if (!storage || !profileId) return
  try {
    storage.setItem(`${SNOOZE_KEY_PREFIX}${profileId}`, String(Date.now()))
  } catch {
    /* sessionStorage unavailable — worst case we re-ask on reload */
  }
}

/**
 * Snooze EVERY listed profile at once. Used when the user closes the login
 * interview dialog (Escape / X / outside-click): a close gesture must end the
 * whole interview for the session — it must never surface the next profile's
 * dialog, or the user is trapped walking the entire queue to get out.
 */
export function snoozeProfiles(profileIds, storage = defaultStorage()) {
  for (const id of Array.isArray(profileIds) ? profileIds : []) {
    snoozeProfile(id, storage)
  }
}

/**
 * Which profile-list endpoint to probe for the login interview.
 *
 * ADMIN CAP (deliberate): an admin's plain GET /api/profiles returns EVERY
 * profile in the system, so the owner-admin would be interviewed for 20 client
 * profiles at every login. `scope=mine` (backend/routes/profiles.js) restricts
 * the list — even for admins — to profiles directly linked to the user:
 * owned (profiles.user_id), created_by, or email-linked via profile_emails /
 * basic_information.email. Client profiles still get their interview when
 * their own linked user logs in.
 */
export function profilesEndpointFor(isAdmin) {
  return isAdmin ? '/api/profiles?scope=mine' : '/api/profiles'
}

/**
 * Decide which profiles are eligible for a login-time interview.
 * Pure + injectable so the decision logic is unit-testable.
 */
export function selectInterviewCandidates(profiles, { storage = defaultStorage() } = {}) {
  const list = Array.isArray(profiles) ? profiles : []
  return list
    .filter((p) => p && isRealProfileId(p.id))
    // Backend already hides agent:amy synthetic training profiles from the
    // list endpoint; keep a defensive filter in case they leak through.
    .filter((p) => String(p.created_by || '') !== 'agent:amy')
    .filter((p) => String(p.status || '') !== 'deleted')
    .filter((p) => !isProfileSnoozed(p.id, storage))
    .slice(0, MAX_PROFILES_PER_LOGIN)
}

/** Does this gap plan actually have questions worth interrupting login for? */
export function planNeedsInterview(plan) {
  return Boolean(
    plan &&
      !plan.complete &&
      plan.needs_questions &&
      Array.isArray(plan.questions) &&
      plan.questions.length > 0,
  )
}
