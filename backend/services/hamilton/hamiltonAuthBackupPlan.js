/**
 * hamiltonAuthBackupPlan.js
 *
 * "Automation is king" backup plan for login/authentication blockers.
 *
 * When Hamilton hits an authentication gate she cannot clear unattended
 * (a login form with no usable saved credential, 2FA, or CAPTCHA), the old
 * behaviour was to mark the task `blocked` and stop forever until a human
 * manually resumed it. That stalls automation.
 *
 * Instead we DEFER: move the task into a `waiting_for_login|2fa|captcha`
 * state with a `next_retry_at` timestamp and let the periodic Hamilton runner
 * re-attempt it on an exponential-backoff schedule. Every retry re-checks the
 * credential vault and saved-session store, so the moment the user logs in once
 * (saving a session) — or a vault password is added — Hamilton resumes and
 * finishes on her own, no manual "resume" click required.
 *
 * After MAX_ATTEMPTS the backoff is exhausted and we fall back to a hard
 * `blocked` so a human is unambiguously asked to step in.
 *
 * This module is pure (no db, no I/O) so the schedule is trivially testable.
 */

// engine blocker_kind / classifier category → the waiting status the task
// should sit in while Hamilton retries. Both the raw engine kinds ('login',
// '2fa', 'captcha', 'sso') and the classifier categories ('login_required',
// 'two_factor_required', 'captcha_required', 'sso_required') are accepted.
const AUTH_STATUS_BY_KIND = Object.freeze({
  login: 'waiting_for_login',
  login_required: 'waiting_for_login',
  sso: 'waiting_for_login',
  sso_required: 'waiting_for_login',
  '2fa': 'waiting_for_2fa',
  two_factor_required: 'waiting_for_2fa',
  mfa: 'waiting_for_2fa',
  captcha: 'waiting_for_captcha',
  captcha_required: 'waiting_for_captcha',
})

// Backoff schedule (minutes) indexed by prior retry count: 15m, 1h, 4h, 12h,
// 24h. Five attempts spread over ~1.7 days gives the user generous time to log
// in once while keeping Hamilton from hammering the portal.
export const AUTH_BACKOFF_MINUTES = Object.freeze([15, 60, 240, 720, 1440])
export const AUTH_MAX_ATTEMPTS = AUTH_BACKOFF_MINUTES.length

function normalizeKind(kind) {
  return String(kind || '').trim().toLowerCase()
}

export function isAuthBlocker(kind) {
  return Boolean(AUTH_STATUS_BY_KIND[normalizeKind(kind)])
}

function humanizeMinutes(mins) {
  if (mins < 60) return `${mins} min`
  if (mins < 1440) return `${Math.round(mins / 60)} hr`
  return `${Math.round(mins / 1440)} day${mins >= 2880 ? 's' : ''}`
}

/**
 * Decide what to do with an auth-blocked task.
 *
 * @param {object} args
 * @param {string} args.blockerKind   engine blocker_kind or classifier category
 * @param {number} [args.retryCount]  how many times this task has already been deferred
 * @param {number} [args.now]         epoch ms (injectable for tests)
 * @returns {{
 *   isAuth: boolean,            // false → not an auth blocker; caller uses normal blocked path
 *   status: string,            // task status to set ('waiting_for_*' or 'blocked' when exhausted)
 *   exhausted: boolean,        // backoff used up → hand to a human
 *   nextRetryAt: string|null,  // ISO timestamp Hamilton should retry at (null when exhausted)
 *   retryInMinutes: number|null,
 *   attempt: number,           // 1-based attempt number this defer represents
 *   maxAttempts: number,
 *   message: string,
 * }}
 */
export function planAuthBackup({ blockerKind, retryCount = 0, now = Date.now() } = {}) {
  const waitingStatus = AUTH_STATUS_BY_KIND[normalizeKind(blockerKind)]
  if (!waitingStatus) {
    return { isAuth: false, status: 'blocked', exhausted: false, nextRetryAt: null, retryInMinutes: null, attempt: 0, maxAttempts: AUTH_MAX_ATTEMPTS, message: '' }
  }
  const priorAttempts = Math.max(0, Math.floor(Number(retryCount) || 0))
  if (priorAttempts >= AUTH_MAX_ATTEMPTS) {
    return {
      isAuth: true,
      status: 'blocked',
      exhausted: true,
      nextRetryAt: null,
      retryInMinutes: null,
      attempt: priorAttempts,
      maxAttempts: AUTH_MAX_ATTEMPTS,
      message: 'Hamilton retried this login several times without success and needs you to complete the sign-in (and save the session) before she can continue.',
    }
  }
  const mins = AUTH_BACKOFF_MINUTES[priorAttempts]
  return {
    isAuth: true,
    status: waitingStatus,
    exhausted: false,
    nextRetryAt: new Date(now + mins * 60_000).toISOString(),
    retryInMinutes: mins,
    attempt: priorAttempts + 1,
    maxAttempts: AUTH_MAX_ATTEMPTS,
    message: `Hamilton needs you to sign in to this portal once. She'll keep working other applications and automatically retry in ~${humanizeMinutes(mins)} — log in (and save the session) whenever you can and she'll resume on her own.`,
  }
}
