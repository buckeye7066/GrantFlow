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
 * (saving a session) — or a vault password is added — Hamilton can resume draft
 * preparation without a manual "resume" click. Final submission remains human.
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
  // Account created but the portal still needs the email verified. This is NOT a
  // hard wall — it's the user's ONE step (click the link in the email that was
  // triggered to them). We defer on the same backoff so that once the link is
  // clicked (or Hamilton auto-confirms it from John's mailbox) the next retry
  // finds the account verified and continues. Never auto-enters 2FA codes.
  email_verification: 'waiting_for_email_verification',
  email_verification_required: 'waiting_for_email_verification',
  verification_pending: 'waiting_for_email_verification',
  verify_email: 'waiting_for_email_verification',
})

// Backoff schedule (minutes) indexed by prior retry count: 15m, 1h, 4h, 12h,
// 24h. Five attempts spread over ~1.7 days gives the user generous time to log
// in once while keeping Hamilton from hammering the portal.
export const AUTH_BACKOFF_MINUTES = Object.freeze([15, 60, 240, 720, 1440])
export const AUTH_MAX_ATTEMPTS = AUTH_BACKOFF_MINUTES.length

// CAPTCHA gets its OWN schedule (2026-08-30): a captcha wall does not clear
// itself on a 15-minute cadence — what clears it is the owner-configured
// solver on the next real run, or a human completing it once in co-browse and
// saving the session. Retries start at 4h. This does NOT delay recovery:
// importing a session / saving a credential now stamps the task due
// immediately (resumeAuthWaitingTasksForHost), so the timer is only the
// fallback cadence.
export const CAPTCHA_BACKOFF_MINUTES = Object.freeze([240, 720, 1440])

function normalizeKind(kind) {
  return String(kind || '').trim().toLowerCase()
}

export function isAuthBlocker(kind) {
  return Boolean(AUTH_STATUS_BY_KIND[normalizeKind(kind)])
}

// The stop must say WHAT wall it hit and WHERE, and what unblocks it. A
// CAPTCHA and a login are different problems with different fixes; prod
// 2026-08-31 showed four CAPTCHA tasks reading "retried this login several
// times" — a login instruction for a wall no login clears.
function exhaustedMessage(waitingStatus, { where, attempts, reasonNote }) {
  switch (waitingStatus) {
    case 'waiting_for_email_verification':
      return `The portal account at ${where} is still not verified after ${attempts} checks. Open the verification email yourself (or finish one sign-in side-by-side and save the session); Hamilton resumes on the next run.`
    case 'waiting_for_captcha':
      return `The portal at ${where} put up a CAPTCHA the solver could not clear on ${attempts} attempts${reasonNote}. Open it once side-by-side (Portals → Autopilot → Open with Hamilton watching), pass the CAPTCHA, and save the session; Hamilton resumes on the next run.`
    case 'waiting_for_2fa':
      return `The portal at ${where} asks for a one-time code that never reached Hamilton's mailbox on ${attempts} attempts${reasonNote}. Point the portal account's 2FA at Hamilton's email/phone, or complete one sign-in side-by-side and save the session; Hamilton resumes on the next run.`
    default:
      return `Hamilton retried the sign-in at ${where} ${attempts} times without success${reasonNote}. Sign in once side-by-side (Portals → Autopilot → Open with Hamilton watching) or add the login to the vault; Hamilton resumes on the next run.`
  }
}

function deferralMessage(waitingStatus, { where, mins, reasonNote }) {
  const when = humanizeMinutes(mins)
  switch (waitingStatus) {
    case 'waiting_for_email_verification':
      return `The portal account at ${where} is awaiting email verification. Hamilton re-checks his mailbox for the verification link in ~${when}; you can also open the message and click the verification link yourself. Hamilton resumes on his own once it is verified.`
    case 'waiting_for_captcha':
      return `The portal at ${where} put up a CAPTCHA Hamilton could not clear${reasonNote}. He retries with the solver in ~${when}; if you sign in there once side-by-side and save the session he resumes immediately.`
    case 'waiting_for_2fa':
      return `The portal at ${where} asked for a one-time code Hamilton could not read${reasonNote}. He retries in ~${when}; pointing the portal's 2FA at his email/phone, or one side-by-side sign-in with a saved session, lets him resume immediately.`
    default:
      return `Hamilton could not sign in at ${where}${reasonNote}. He keeps working other applications and retries in ~${when} (re-checking the vault and saved sessions); one side-by-side sign-in with a saved session lets him resume immediately.`
  }
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
export function planAuthBackup({ blockerKind, retryCount = 0, now = Date.now(), portalUrl = null, lastReason = null } = {}) {
  const waitingStatus = AUTH_STATUS_BY_KIND[normalizeKind(blockerKind)]
  if (!waitingStatus) {
    return { isAuth: false, status: 'blocked', exhausted: false, nextRetryAt: null, retryInMinutes: null, attempt: 0, maxAttempts: AUTH_MAX_ATTEMPTS, message: '' }
  }
  const schedule = waitingStatus === 'waiting_for_captcha' ? CAPTCHA_BACKOFF_MINUTES : AUTH_BACKOFF_MINUTES
  const maxAttempts = schedule.length
  const priorAttempts = Math.max(0, Math.floor(Number(retryCount) || 0))
  const where = portalUrl ? String(portalUrl) : 'this portal'
  const reasonNote = lastReason ? ` (last result: ${String(lastReason).slice(0, 120)})` : ''
  if (priorAttempts >= maxAttempts) {
    return {
      isAuth: true,
      status: 'blocked',
      exhausted: true,
      nextRetryAt: null,
      retryInMinutes: null,
      attempt: priorAttempts,
      maxAttempts,
      message: exhaustedMessage(waitingStatus, { where, attempts: priorAttempts, reasonNote }),
    }
  }
  const mins = schedule[priorAttempts]
  const message = deferralMessage(waitingStatus, { where, mins, reasonNote })
  return {
    isAuth: true,
    status: waitingStatus,
    exhausted: false,
    nextRetryAt: new Date(now + mins * 60_000).toISOString(),
    retryInMinutes: mins,
    attempt: priorAttempts + 1,
    maxAttempts,
    message,
  }
}
