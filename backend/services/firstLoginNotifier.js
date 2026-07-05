/**
 * firstLoginNotifier.js — one-time "a new user just signed in for the first
 * time" owner notification.
 *
 * Called (fire-and-forget) from the SINGLE session-mint choke point
 * (createSessionAndTokens in routes/auth.js) — the same place the durable
 * client_sign_in audit is recorded, so every fresh login of every method
 * (password, email/phone OTP, OAuth, registration auto-login) is covered and
 * token refresh is structurally excluded.
 *
 * It stamps users.last_login_at on EVERY sign-in; the atomic NULL→set
 * transition (UPDATE ... WHERE last_login_at IS NULL) is the first-login
 * signal that emails the owner — race-safe with no read-then-write window.
 * Existing users were backfilled when the column was introduced (migration
 * 0132 / ensureUsersLastLoginAtColumn), so only accounts created after this
 * feature can transition.
 *
 * Mirrors errorReporter.js conventions: never throws, never blocks the login,
 * admin/owner sign-ins never notify, recipient defaults to the owner.
 *
 * Env:
 *   FIRST_LOGIN_REPORT_EMAIL — recipient override
 *   ERROR_REPORT_EMAIL       — shared owner-notification fallback
 */

import { sendEmail as sendEmailReal } from './email.js'
import { isAdminEmail } from '../config/constants.js'

const OWNER_EMAIL = 'dr.johnwhite@axiombiolabs.org'
const CANONICAL_ADMIN = 'buckeye7066@gmail.com'
const APP_NAME = 'GrantFlow'

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/**
 * Stamp last_login_at and, when this was the user's FIRST sign-in, email the
 * owner. Returns a promise (awaitable in tests); the auth choke point invokes
 * it fire-and-forget (`void recordSuccessfulLogin(...)`) so login latency and
 * outcome are never affected — all failures are swallowed after a warning.
 *
 * @param {object} args
 * @param {object} args.db          live DB handle
 * @param {object} args.user        the just-authenticated users row
 * @param {string} [args.method]    sign-in method ('password', 'email', 'phone', 'oauth:google', …)
 * @param {string} [args.identifier] the identifier used to sign in (email/phone)
 * @param {object} [args.deps]      injectable { sendEmail } for tests
 */
export async function recordSuccessfulLogin({ db, user, method = 'session', identifier = null, deps = {} } = {}) {
  const sendEmail = deps.sendEmail || sendEmailReal
  try {
    if (!db?.prepare || !user?.id) return { skipped: true }

    // Atomic first-login detection: only ONE caller can ever win the
    // NULL→set transition, so the owner is notified exactly once per user.
    const res = await db
      .prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ? AND last_login_at IS NULL')
      .run(user.id)
    const firstLogin = Number(res?.changes ?? res?.rowCount ?? 0) === 1
    if (!firstLogin) {
      await db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id)
      return { ok: true, firstLogin: false }
    }

    const email = String(user.primary_email || '').trim().toLowerCase()
    if (email && (isAdminEmail(email) || email === CANONICAL_ADMIN)) {
      return { ok: true, firstLogin: true, notified: false }
    }

    const to = process.env.FIRST_LOGIN_REPORT_EMAIL
      || process.env.ERROR_REPORT_EMAIL
      || OWNER_EMAIL
    const when = new Date().toISOString()
    const who = email || identifier || '(no email on file)'
    const name = user.display_name || '(no name)'
    const subject = `[${APP_NAME}] New user first login: ${who}`
    const text = [
      `A new user just signed in to ${APP_NAME} for the first time.`,
      '',
      `Identifier: ${who}`,
      `Name:       ${name}`,
      `Via:        ${method}`,
      `When:       ${when}`,
      `UserId:     ${user.id}`,
    ].join('\n')
    const html = `
      <h2 style="margin:0 0 12px">New ${APP_NAME} user — first login</h2>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Identifier</td><td>${escapeHtml(who)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Name</td><td>${escapeHtml(name)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Via</td><td>${escapeHtml(method)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">When</td><td>${escapeHtml(when)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">User id</td><td>${escapeHtml(user.id)}</td></tr>
      </table>`

    const result = await sendEmail({ to, subject, html, text })
    return { ok: true, firstLogin: true, notified: Boolean(result?.ok || result?.id) }
  } catch (err) {
    console.warn('[firstLoginNotifier] failed (non-fatal):', err?.message || err)
    return { ok: false, error: err?.message }
  }
}

export default { recordSuccessfulLogin }
