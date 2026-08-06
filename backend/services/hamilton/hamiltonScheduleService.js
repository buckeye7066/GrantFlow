/**
 * hamiltonScheduleService.js
 *
 * Surfaces Hamilton's APPLICATION SCHEDULE on the calendar and the LOGIN
 * READINESS the owner needs to act on — the two halves of the "Hamilton prepares
 * work in your real portal; stand by if 2FA is needed" flow.
 *
 *   - getHamiltonReadiness(): which portals need a fresh login session captured
 *     (so Hamilton can prepare work inside the real account), whether a schedule is set,
 *     and the next run time. Powers the login-time reminder banner.
 *   - computeHamiltonCalendarEvents(): Hamilton's scheduled access windows as
 *     calendar events, each flagged `requires_presence` when a portal it would
 *     touch has no valid saved session (you'll need to be available for 2FA).
 *
 * Generic across every profile + portal — nothing school-specific.
 */

import { normalizeSchedule, nextWindowStart, windowStartsBetween } from './portalAccessSchedule.js'
import { deriveProfilePortalHosts } from './hamiltonAutomationOrchestrator.js'
import { listCredentialedDomains } from './hamiltonPortalCredentialService.js'
import { findValidSession } from './hamiltonCredentialSessionService.js'
import { emitHamiltonNotificationToProfileAndAdmins } from './hamiltonNotifications.js'
import { resolveProfileSyncNeeds, SYNC_NEED_ACTION } from './portalSyncStaleness.js'

const SESSION_REMINDER_TYPE = 'hamilton_session_capture_needed'
const SYNC_REMINDER_TYPE = 'hamilton_portal_sync_needed'

// Tasks that still have work for Hamilton to do (not terminal / not waiting on
// the owner for something other than a scheduled run).
const ACTIVE_TASK_STATUSES = [
  'queued', 'analyzing', 'ready_to_start', 'filling_portal',
  'generating_application', 'waiting_for_window', 'waiting_for_review',
]

// Count active tasks with a plain read — deliberately NOT via listApplicationTasks,
// which would trigger the store's schema-ensuring write path on a read-only
// calendar/readiness call. Returns 0 if the table is absent.
async function countActiveTasks(db, profileId) {
  try {
    const placeholders = ACTIVE_TASK_STATUSES.map(() => '?').join(', ')
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM application_tasks WHERE profile_id = ? AND status IN (${placeholders})`)
      .get(String(profileId), ...ACTIVE_TASK_STATUSES)
    return Number(row?.n || 0)
  } catch { return 0 }
}

async function loadProfileSections(db, profileId) {
  const out = {}
  try {
    const rows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
    for (const r of rows || []) {
      try { out[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data } catch { /* ignore */ }
    }
  } catch { /* table may be absent in tests */ }
  return out
}

/**
 * Portals this profile will need an authenticated session for: every host the
 * owner saved a login for (those require sign-in), unioned with committed-college
 * application portals.
 */
async function portalsNeedingSession(db, profileId, sections) {
  const hosts = new Set()
  try {
    for (const h of await listCredentialedDomains(db, profileId)) if (h) hosts.add(String(h).toLowerCase())
  } catch { /* ignore */ }
  try {
    for (const h of deriveProfilePortalHosts({ profile: { university_applications: sections.university_applications } })) {
      if (h) hosts.add(String(h).toLowerCase())
    }
  } catch { /* ignore */ }
  return [...hosts]
}

/**
 * Readiness for the login reminder: schedule status, next run, and which portals
 * still need a captured session (so the banner can prompt a re-capture).
 */
export async function getHamiltonReadiness(db, { profileId } = {}) {
  if (!db || !profileId) return null
  const sections = await loadProfileSections(db, profileId)
  const schedule = normalizeSchedule(sections.automation_preferences || {})
  const hosts = await portalsNeedingSession(db, profileId, sections)

  const portals = []
  for (const host of hosts) {
    const sess = await findValidSession(db, { profileId, portalHost: host })
    portals.push({
      host,
      session_status: sess ? 'valid' : 'missing',
      has_session: !!sess,
      expires_at: sess?.expires_at || null,
      // A captured session is what lets Hamilton clear the login/2FA gate; a host
      // with a saved login but no valid session is the thing to (re)capture.
      needs_capture: !sess,
    })
  }

  const pendingCount = await countActiveTasks(db, profileId)

  // WHICH PORTALS NEED A SYNC (owner rule, 2026-08-01). Computed for THIS
  // profile only — `resolveProfileSyncNeeds` has no aggregate mode, so an admin
  // reading this endpoint sees exactly what the profile's owner would see for
  // the profile they are working in, and nothing about the other 38.
  // Best-effort: a failure here degrades the banner, it never fails readiness.
  let syncNeeds = null
  try {
    syncNeeds = await resolveProfileSyncNeeds(db, { profileId })
  } catch { syncNeeds = null }

  const portalsNeedingCapture = portals.filter((p) => p.needs_capture)
  return {
    profile_id: String(profileId),
    has_schedule: schedule.enabled,
    schedule: { enabled: schedule.enabled, timezone: schedule.timezone, windows: schedule.windows.map((w) => ({ start: w.start, end: w.end })) },
    next_run_at: nextWindowStart(schedule), // null when disabled => runs anytime
    pending_task_count: pendingCount,
    portals,
    portals_needing_capture: portalsNeedingCapture.map((p) => p.host),
    // Login-time sync prompt: which portals are stale / changed-since-sync, why,
    // and whether the ask is "sync now" or "sign in once".
    sync_needs: syncNeeds,
    // The banner should prompt setup when there is work to do AND either no
    // schedule is set, or a portal needs a session captured — OR, independently
    // of Hamilton's task queue, when a portal has drifted out of sync. A stale
    // portal is actionable even when there is no pending application work.
    needs_attention: (pendingCount > 0 && (!schedule.enabled || portalsNeedingCapture.length > 0))
      || Boolean(syncNeeds?.needs_attention),
  }
}

/**
 * Hamilton's scheduled access windows as calendar events for [rangeStart,
 * rangeEnd]. Empty when the profile has no active work. Each event carries
 * `requires_presence` (a portal it would touch lacks a valid session, so the
 * owner should stand by for 2FA) so the calendar can flag it.
 */
export async function computeHamiltonCalendarEvents(db, { profileId, rangeStart, rangeEnd } = {}) {
  if (!db || !profileId || !rangeStart || !rangeEnd) return []
  const sections = await loadProfileSections(db, profileId)
  const schedule = normalizeSchedule(sections.automation_preferences || {})

  const pendingCount = await countActiveTasks(db, profileId)
  if (pendingCount === 0) return [] // nothing to run → nothing to plot

  // Does any portal Hamilton would touch lack a valid session?
  const hosts = await portalsNeedingSession(db, profileId, sections)
  let requiresPresence = false
  for (const host of hosts) {
    const sess = await findValidSession(db, { profileId, portalHost: host })
    if (!sess) { requiresPresence = true; break }
  }
  const presenceReason = requiresPresence ? 'login_2fa' : null

  const mkEvent = (iso) => ({
    id: `hamilton_run_${profileId}_${iso}`,
    deadline: iso, // calendar feed keys events on `deadline`
    calendar_source: 'hamilton_run',
    title: `Hamilton prepares — ${pendingCount} ${pendingCount === 1 ? 'source' : 'sources'}`,
    profile_id: String(profileId),
    pending_task_count: pendingCount,
    requires_presence: requiresPresence,
    presence_reason: presenceReason,
    detail: requiresPresence
      ? 'A portal needs sign-in/2FA — be available, or capture a fresh session beforehand.'
      : 'Hamilton prepares drafts unattended (saved session reused); final submission remains with you.',
  })

  if (!schedule.enabled) {
    // No fixed window → Hamilton can run anytime. Plot a single "ready now" marker.
    const now = new Date()
    const at = now < new Date(rangeStart) ? new Date(rangeStart) : now
    return [mkEvent(at.toISOString())]
  }
  return windowStartsBetween(schedule, rangeStart, rangeEnd).map(mkEvent)
}

/**
 * SYSTEM-WIDE scan: every profile that has active Hamilton work but a portal it
 * needs to log into with no valid saved session — i.e. runs that will stall on
 * login/2FA until the owner captures a session. Read-only. Shaped as
 * { ok, summary, findings:[{severity,title,description,...}] } so Sam's
 * diagnostics can mine `findings` directly and Anya can report it. This is how
 * the session-import + calendar capability becomes monitorable by the agents.
 */
export async function scanHamiltonSessionReadiness(db, { limit = 500 } = {}) {
  if (!db) return { ok: false, summary: 'no db', findings: [] }
  let profileIds = []
  try {
    const placeholders = ACTIVE_TASK_STATUSES.map(() => '?').join(', ')
    const rows = await db
      .prepare(`SELECT DISTINCT profile_id FROM application_tasks WHERE status IN (${placeholders}) LIMIT ?`)
      .all(...ACTIVE_TASK_STATUSES, Number(limit) || 500)
    profileIds = (rows || []).map((r) => r.profile_id).filter(Boolean)
  } catch {
    // application_tasks absent → nothing to scan.
    return { ok: true, summary: 'No application tasks table / no active work.', findings: [], profiles_scanned: 0 }
  }

  const findings = []
  for (const profileId of profileIds) {
    const sections = await loadProfileSections(db, profileId)
    const hosts = await portalsNeedingSession(db, profileId, sections)
    // Hosts the owner actually has a saved login for (those require sign-in);
    // a committed-college URL with no credential isn't actionable. NOTE:
    // listCredentialedDomains returns a Set, so spread before mapping.
    let credHosts = []
    try { credHosts = [...await listCredentialedDomains(db, profileId)].map((h) => String(h).toLowerCase()) } catch { credHosts = [] }
    for (const host of hosts) {
      if (!credHosts.includes(host)) continue
      const sess = await findValidSession(db, { profileId, portalHost: host })
      if (!sess) {
        findings.push({
          severity: 'medium',
          category: 'hamilton_session',
          title: `Hamilton run will stall on login: ${host}`,
          description: `Profile ${profileId} has active Hamilton work and a saved login for ${host}, but no valid captured session — the run will stop for 2FA.`,
          evidence: { profile_id: profileId, portal_host: host },
          recommended_fix: `Capture a session via tools/hamilton-session-capture (or POST /api/hamilton/automation/sessions/import) for ${host}, then schedule the run.`,
          confidence: 0.9,
        })
      }
    }
  }
  return {
    ok: true,
    summary: findings.length
      ? `${findings.length} portal session(s) need capture across ${profileIds.length} active profile(s).`
      : `All ${profileIds.length} active profile(s) have valid portal sessions (or none required).`,
    profiles_scanned: profileIds.length,
    findings,
  }
}

/**
 * Proactively remind the owner to (re)capture a portal session BEFORE a
 * scheduled run stalls on it — the active counterpart to the Sam/Anya scan.
 * Deduped per (profile, host) over `lookbackHours` so it never nags. Returns
 * the number of reminders emitted. Safe to call from the readiness endpoint
 * (fire-and-forget) and from the scheduler.
 */
export async function emitSessionCaptureReminders(db, { profileId, lookbackHours = 20 } = {}) {
  if (!db || !profileId) return 0
  const readiness = await getHamiltonReadiness(db, { profileId })
  if (!readiness || readiness.pending_task_count === 0) return 0
  const hosts = readiness.portals_needing_capture || []
  if (hosts.length === 0) return 0

  // Resolve the profile owner so the reminder reliably reaches them (and so the
  // dedup marker is actually written even if the broader access resolver is
  // unavailable).
  let profileUserId = null
  try {
    const row = await db.prepare('SELECT user_id FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    profileUserId = row?.user_id || null
  } catch { profileUserId = null }

  // Space-format ('YYYY-MM-DD HH:MM:SS'), NOT ISO. notifications.created_at is
  // written by SQLite CURRENT_TIMESTAMP (space-separated); an ISO cutoff ('…T…Z')
  // sorts BEFORE any space-format value at char 10 (' ' < 'T'), so the dedup
  // `created_at > cutoff` would never match and reminders would never dedup.
  // Space-format compares correctly under SQLite (same shape) and Postgres
  // (parses the literal to a timestamp).
  const cutoff = new Date(Date.now() - lookbackHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
  let emitted = 0
  for (const host of hosts) {
    // Dedup: skip if we already reminded about this host recently.
    let recent = null
    try {
      recent = await db.prepare(
        `SELECT 1 FROM notifications WHERE type = ? AND data LIKE ? AND created_at > ? LIMIT 1`,
      ).get(SESSION_REMINDER_TYPE, `%${host}%`, cutoff)
    } catch { recent = null }
    if (recent) continue
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId,
      profileUserId,
      type: SESSION_REMINDER_TYPE,
      title: `Capture your ${host} login for Hamilton`,
      message: `Hamilton has preparation work ready but no valid saved session for ${host}. Capture one (you complete login + 2FA once) so she can open the portal and prepare drafts — otherwise the scheduled run will pause for sign-in. Final submission remains with you.`,
      severity: 'warning',
      data: { portal_host: host, action: 'capture_session' },
    }).catch(() => {})
    emitted += 1
  }
  return emitted
}

/**
 * Login-time PORTAL SYNC prompt for the profile owner AND admins (owner rule,
 * 2026-08-01): "alert the profile owner and admin ON LOGIN that a sync needs to
 * happen, and which portals need synced."
 *
 * SCOPE IS ONE PROFILE, ALWAYS. `profileId` is required and there is no
 * all-profiles variant, because an admin digest across 39 prod profiles is a
 * wall of prompts an admin learns to ignore — which would destroy the surface
 * for the one profile that matters. An admin working inside a profile gets
 * exactly the owner's list for that profile.
 *
 * Deduped per (profile, host) over `lookbackHours` so a login loop never nags.
 * The message names the ACTION honestly: a portal with no captured session is
 * asked for one watched sign-in, never "sync now" — you cannot sync a portal
 * you cannot get into.
 *
 * Returns the number of reminders emitted. Never throws.
 */
export async function emitPortalSyncReminders(db, { profileId, lookbackHours = 20 } = {}) {
  if (!db || !profileId) return 0
  let needs = null
  try {
    needs = await resolveProfileSyncNeeds(db, { profileId })
  } catch { return 0 }
  const portals = needs?.portals || []
  if (portals.length === 0) return 0

  let profileUserId = null
  try {
    const row = await db.prepare('SELECT user_id FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    profileUserId = row?.user_id || null
  } catch { profileUserId = null }

  // Space-format ('YYYY-MM-DD HH:MM:SS'), NOT ISO — see emitSessionCaptureReminders:
  // notifications.created_at is written by SQLite CURRENT_TIMESTAMP, and an ISO
  // cutoff sorts before every space-format value at char 10 (' ' < 'T'), so the
  // dedup predicate would never match and every login would re-notify.
  const cutoff = new Date(Date.now() - lookbackHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
  let emitted = 0
  for (const portal of portals) {
    const host = portal.portal_host
    let recent = null
    try {
      recent = await db.prepare(
        `SELECT 1 FROM notifications WHERE type = ? AND data LIKE ? AND created_at > ? LIMIT 1`,
      ).get(SYNC_REMINDER_TYPE, `%${host}%`, cutoff)
    } catch { recent = null }
    if (recent) continue

    const why = portal.reasons.map((r) => r.detail).join(' ')
    const needsSignIn = portal.action === SYNC_NEED_ACTION.SIGN_IN
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId,
      profileUserId,
      type: SYNC_REMINDER_TYPE,
      title: needsSignIn
        ? `Sign in once to ${portal.label} so it can sync`
        : `${portal.label} needs a sync`,
      message: needsSignIn
        ? `${why} Hamilton has no valid saved session for ${host}, so the sync cannot run yet — one side-by-side sign-in restores it, and the sync runs immediately while the session is still warm.`
        : `${why} Hamilton holds a valid session for ${host} and can sync now.`,
      severity: 'info',
      data: {
        portal_host: host,
        action: needsSignIn ? 'capture_session' : 'sync_portal',
        reason_codes: portal.reason_codes,
        last_successful_sync_at: portal.last_successful_sync_at,
        login_url: portal.login_url,
      },
    }).catch(() => {})
    emitted += 1
  }
  return emitted
}

export default {
  getHamiltonReadiness,
  computeHamiltonCalendarEvents,
  scanHamiltonSessionReadiness,
  emitSessionCaptureReminders,
  emitPortalSyncReminders,
}
