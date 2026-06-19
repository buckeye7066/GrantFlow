/**
 * hamiltonAuthWatchService.js
 *
 * Summarises the authentication help Hamilton currently needs from a given
 * user, so the frontend can show a priming toast right after login:
 * "Hamilton may need you to approve a portal sign-in — watch for verification
 * requests." It also surfaces how many logins are actively waiting so the toast
 * can deep-link the user straight to them.
 *
 * Read-only and never returns secrets — only counts, hosts, and task ids.
 */

// Notification types that mean "Hamilton is waiting on you to authenticate".
const AUTH_NOTIFICATION_TYPES = Object.freeze([
  'hamilton_login_required',
  'hamilton_2fa_required',
  'hamilton_captcha_required',
  // A portal needs a saved login the owner hasn't added yet — surfaced at the
  // next login of the student and the admin so either can add it.
  'hamilton_missing_credential',
  // admin recipient variants
  'hamilton_admin_login_required',
])

const WAITING_STATUSES = Object.freeze(['waiting_for_login', 'waiting_for_2fa', 'waiting_for_captcha'])

function hostFromUrl(u) {
  if (!u) return null
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname } catch { return String(u).slice(0, 60) }
}

/**
 * @returns {Promise<{
 *   has_any: boolean,
 *   pending_notifications: number,
 *   waiting_tasks: number,
 *   items: Array<{task_id:string, profile_id:string, host:string|null, status:string, next_retry_at:string|null}>,
 * }>}
 */
export async function getAuthWatchSummary(db, { userId } = {}) {
  const empty = { has_any: false, pending_notifications: 0, waiting_tasks: 0, items: [] }
  if (!db || !userId) return empty

  let notifCount = 0
  try {
    const placeholders = AUTH_NOTIFICATION_TYPES.map(() => '?').join(',')
    const row = await db.prepare(
      `SELECT COUNT(*) AS c FROM notifications
        WHERE user_id = ? AND read = 0 AND type IN (${placeholders})`,
    ).get(String(userId), ...AUTH_NOTIFICATION_TYPES)
    notifCount = Number(row?.c) || 0
  } catch { /* notifications table absent on bare db */ }

  let tasks = []
  try {
    const placeholders = WAITING_STATUSES.map(() => '?').join(',')
    tasks = await db.prepare(
      `SELECT t.id, t.profile_id, t.portal_url, t.status, t.next_retry_at
         FROM application_tasks t
         JOIN profiles p ON p.id = t.profile_id
        WHERE p.user_id = ? AND t.status IN (${placeholders})
        ORDER BY t.next_retry_at ASC
        LIMIT 25`,
    ).all(String(userId), ...WAITING_STATUSES)
    if (!Array.isArray(tasks)) tasks = []
  } catch { /* tables absent on bare db */ }

  const items = tasks.slice(0, 10).map((t) => ({
    task_id: t.id,
    profile_id: t.profile_id,
    host: hostFromUrl(t.portal_url),
    status: t.status,
    next_retry_at: t.next_retry_at || null,
  }))

  return {
    has_any: notifCount > 0 || tasks.length > 0,
    pending_notifications: notifCount,
    waiting_tasks: tasks.length,
    items,
  }
}
