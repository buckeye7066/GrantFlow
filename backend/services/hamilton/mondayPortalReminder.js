/**
 * mondayPortalReminder.js
 *
 * Owner requirement (c): "Unmerged portals need to be sent as reminders at least
 * once a week (Monday mornings)."
 *
 * Once a week (Monday morning ET, scheduled in server.js exactly like the
 * Hamilton weekly digest) this sweep, for every active profile, finds the
 * profile's portals that are NOT merged — i.e. still need the user to log in,
 * finish, or merge their data — and sends ONE reminder per profile to the
 * profile's contact emails (and SMS where opted in) via the existing comms
 * channel (dr.johnwhite alias). A portal that has reached the MERGED terminal
 * state is excluded; a portal that is COMPLETE (application done) but not yet
 * merged is STILL reminded — the owner wants to be nudged to merge it.
 *
 * "Unmerged" is computed from BOTH sources of truth so we never miss a portal:
 *   - the live portal tiles for the profile (profilePortalIndex) — every portal
 *     that applies, minus any whose status row is 'merged', and
 *   - portal_portal_status rows in 'complete' / 'unmerged' (so a completed-but-
 *     not-merged portal is reminded even if a tile no longer derives for it).
 *
 * Idempotency: the SCHEDULER (server.js) guards once-per-Monday via system_kv,
 * exactly like the Hamilton digest. This service additionally stamps
 * last_reminded_at on each reminded portal so the audit trail is durable. It is
 * gated by MONDAY_PORTAL_REMINDER_ENABLED (default on). Never throws per profile
 * — one bad profile cannot abort the whole sweep.
 *
 * Observability (standing agent rule): the run summary is returned to the
 * scheduler, which persists it to system_kv; Sam's diagnostics + the Anya owner
 * tool read it back.
 */

import { getProfilePortals } from './profilePortalIndex.js'
import {
  getPortalStatusMap,
  recordReminderSent,
  PORTAL_STATUS,
  ensurePortalCompletionSchema,
} from './portalCompletionStore.js'
import { notifyProfile, resolveProfileContacts } from '../comms/commsService.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('mondayPortalReminder')

export function isMondayPortalReminderEnabled() {
  // On by default — the owner asked for a weekly Monday reminder regardless of
  // login. Set MONDAY_PORTAL_REMINDER_ENABLED=false to disable.
  return String(process.env.MONDAY_PORTAL_REMINDER_ENABLED ?? 'true').toLowerCase() !== 'false'
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Compute the NOT-merged portals for one profile. Returns an array of
 * { host, label, loginUrl, status } where status is 'complete' or 'unmerged'
 * (never 'merged'). Best-effort: any failure yields [].
 */
export async function selectUnmergedPortals(db, profileId) {
  if (!db || !profileId) return []
  try {
    await ensurePortalCompletionSchema(db)
    const statusMap = await getPortalStatusMap(db, profileId)
    const { portals } = await getProfilePortals(db, profileId, { refresh: false })

    const out = new Map()
    // 1. Live tiles, minus any host explicitly MERGED.
    for (const p of portals || []) {
      const host = p?.portalHost
      if (!host) continue
      const st = statusMap.get(String(host))
      if (st?.status === PORTAL_STATUS.MERGED) continue
      out.set(String(host), {
        host: String(host),
        label: p.label || String(host),
        loginUrl: p.loginUrl || `https://${host}`,
        status: st?.status === PORTAL_STATUS.COMPLETE ? PORTAL_STATUS.COMPLETE : PORTAL_STATUS.UNMERGED,
      })
    }
    // 2. Status rows in 'complete'/'unmerged' that no longer derive a tile (e.g. a
    //    completed FAFSA whose pipeline grant was archived) are still reminders.
    for (const [host, st] of statusMap.entries()) {
      if (st.status === PORTAL_STATUS.MERGED) continue
      if (out.has(host)) continue
      out.set(host, {
        host,
        label: host,
        loginUrl: `https://${host}`,
        status: st.status === PORTAL_STATUS.COMPLETE ? PORTAL_STATUS.COMPLETE : PORTAL_STATUS.UNMERGED,
      })
    }
    return [...out.values()].sort((a, b) => a.label.localeCompare(b.label))
  } catch (err) {
    log.warn('select_unmerged_failed', { profileId: String(profileId), err: err?.message })
    return []
  }
}

/** Build the reminder email content for one profile's unmerged portals. */
export function buildReminder({ displayName, unmerged }) {
  const n = unmerged.length
  const subject = `GrantFlow: ${n} portal${n === 1 ? '' : 's'} still need${n === 1 ? 's' : ''} to be merged`

  const line = (p) => {
    const tag = p.status === PORTAL_STATUS.COMPLETE
      ? ' (application complete — merge it to pull your results in)'
      : ' (log in to finish + merge)'
    return `${p.label}${tag}: ${p.loginUrl}`
  }

  const text = [
    `Hi${displayName ? ` ${displayName}` : ''},`,
    '',
    `You have ${n} portal${n === 1 ? '' : 's'} that haven't been merged into your profile yet.`,
    'Merging pulls your application status, awards, and saved info into GrantFlow so nothing falls through the cracks.',
    '',
    ...unmerged.map((p) => `  • ${line(p)}`),
    '',
    'Open GrantFlow → your profile → Portals to finish these.',
    'The GrantFlow team',
  ].join('\n')

  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#0f172a;line-height:1.5">
    <p>Hi${displayName ? ` ${esc(displayName)}` : ''},</p>
    <p>You have <strong>${n} portal${n === 1 ? '' : 's'}</strong> that haven't been merged into your profile yet. Merging pulls your application status, awards, and saved info into GrantFlow so nothing falls through the cracks.</p>
    <ul style="margin:0;padding-left:20px">
      ${unmerged.map((p) => `<li><a href="${esc(p.loginUrl)}">${esc(p.label)}</a>${p.status === PORTAL_STATUS.COMPLETE ? ' <em>(application complete — merge it to pull your results in)</em>' : ' <em>(log in to finish + merge)</em>'}</li>`).join('')}
    </ul>
    <p style="margin-top:18px">Open GrantFlow → your profile → <strong>Portals</strong> to finish these.<br/>The GrantFlow team</p>
  </div>`

  return { subject, text, html, count: n }
}

/**
 * Run the Monday portal reminder sweep. For each active profile with unmerged
 * portals AND a contact email, send one reminder. Returns a summary
 * { ran, profiles, reminded, portals_reminded, skipped_no_portals,
 *   skipped_no_contact, errors, at }.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {boolean} [opts.force]      run even when the env flag is off
 * @param {string[]} [opts.profileIds] restrict to specific profiles (manual run)
 * @param {string}  [opts.channel]    'auto' | 'email' | 'sms' (default 'auto')
 */
export async function runMondayPortalReminder(db, { force = false, profileIds = null, channel = 'auto', now = new Date() } = {}) {
  if (!force && !isMondayPortalReminderEnabled()) return { ran: false, reason: 'disabled' }
  if (!db) return { ran: false, reason: 'no_db' }

  await ensurePortalCompletionSchema(db)

  let profiles = []
  if (Array.isArray(profileIds) && profileIds.length) {
    profiles = profileIds.map((id) => ({ id }))
  } else {
    try {
      // Skip Amy's synthetic profiles (created_by='agent:amy') — QA fixtures,
      // not real clients; they must never receive a portal reminder.
      profiles = await db.prepare(
        `SELECT id FROM profiles WHERE (status IS NULL OR status NOT IN ('deleted','suspended')) AND (created_by IS NULL OR created_by <> 'agent:amy')`,
      ).all()
    } catch {
      try { profiles = await db.prepare('SELECT id FROM profiles').all() } catch { profiles = [] }
    }
  }

  let reminded = 0
  let portalsReminded = 0
  let skippedNoPortals = 0
  let skippedNoContact = 0
  let errors = 0

  for (const p of profiles || []) {
    try {
      const unmerged = await selectUnmergedPortals(db, p.id)
      if (unmerged.length === 0) { skippedNoPortals += 1; continue }

      const contacts = await resolveProfileContacts(db, p.id)
      const hasEmail = (contacts.emails || []).length > 0
      const hasSms = Boolean(contacts.sms_phone)
      if (!hasEmail && !hasSms) { skippedNoContact += 1; continue }

      const reminder = buildReminder({ displayName: contacts.display_name, unmerged })
      const res = await notifyProfile(db, {
        profileId: p.id,
        subject: reminder.subject,
        text: reminder.text,
        html: reminder.html,
        channel,
      })
      const anySent = (res?.results || []).some((r) => r.ok)
      if (anySent) {
        reminded += 1
        portalsReminded += unmerged.length
        // Durable per-portal reminder audit (idempotency belt-and-suspenders;
        // the scheduler's once-per-Monday guard is the primary mechanism).
        for (const u of unmerged) {
          try { await recordReminderSent(db, p.id, u.host) } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      errors += 1
      log.warn('reminder_failed', { profile_id: p.id, error: err?.message })
    }
  }

  const summary = {
    ran: true,
    profiles: (profiles || []).length,
    reminded,
    portals_reminded: portalsReminded,
    skipped_no_portals: skippedNoPortals,
    skipped_no_contact: skippedNoContact,
    errors,
    at: now.toISOString(),
  }
  log.info('monday portal reminder complete', summary)
  return summary
}

export default {
  isMondayPortalReminderEnabled,
  selectUnmergedPortals,
  buildReminder,
  runMondayPortalReminder,
}
