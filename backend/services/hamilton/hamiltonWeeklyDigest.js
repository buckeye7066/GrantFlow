/**
 * hamiltonWeeklyDigest.js — Hamilton's weekly per-profile funding status digest.
 *
 * Once a week (Monday 08:00 ET, scheduled in server.js) Hamilton drafts ONE
 * Outlook message PER PROFILE into the owner's draft box (dr.johnwhite mailbox),
 * addressed to EVERY email on that profile. The owner reviews and sends — this
 * never sends on its own (same draft-only safety as John).
 *
 * Each digest covers, for that profile:
 *   - where they stand (counts by pipeline stage, awarded total),
 *   - what needs IMMEDIATE attention (deadlines ≤7 days, portal merges, missing
 *     info, billing issues),
 *   - what needs attention SOON (deadlines 8–30 days, follow-ups),
 *   - upcoming deadlines for funding sources in their pipeline,
 *   - deadlines / requirements for AWARDED sources (reporting, period end).
 *
 * Observability (per the standing agent rule): every run records a summary to
 * system_kv (`hamilton_weekly_digest_last_run` + `..._summary`) so Sam's
 * diagnostics and the admin/Anya status endpoint can see it, and a manual run
 * is exposed via the admin comms route.
 */

import { createOutlookProvider } from '../john/johnOutlookProvider.js'
import { getJohnConfig } from '../john/johnOutreachSafety.js'
import { resolveProfileContacts, sendBroadcast } from '../comms/commsService.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('hamiltonWeeklyDigest')

const DAY = 86400000
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function isWeeklyDigestEnabled() {
  // On by default — the owner asked for it to run every Monday regardless of
  // login. Set HAMILTON_WEEKLY_DIGEST_ENABLED=false to disable.
  return String(process.env.HAMILTON_WEEKLY_DIGEST_ENABLED ?? 'true').toLowerCase() !== 'false'
}

/**
 * How the weekly digest is delivered:
 *   - 'draft' (default) → one Outlook draft per profile into the owner's
 *     mailbox; the owner reviews and sends manually.
 *   - 'send'            → AUTO-SEND one email per profile directly to the
 *     profile's contact emails via the existing comms channel (Resend),
 *     recorded in comms_broadcasts/comms_broadcast_recipients (kind
 *     'weekly_digest') so Sam/Anya/admin can audit every send.
 * Owner-approved auto-send (2026-07-02): prod sets
 * HAMILTON_WEEKLY_DIGEST_DELIVERY=send. The leads pipeline (John) is not
 * affected — it stays draft-only.
 */
export function weeklyDigestDeliveryMode() {
  return String(process.env.HAMILTON_WEEKLY_DIGEST_DELIVERY || 'draft').toLowerCase() === 'send'
    ? 'send'
    : 'draft'
}

const ACTIVE_PIPELINE = new Set([
  'saved', 'interested', 'gathering_documents', 'drafting', 'ready_to_submit',
  'submitted', 'follow_up', 'application_prep', 'revision', 'portal', 'pending_review',
  'under_review', 'app_prep',
])

function daysUntil(dateStr, now) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (!Number.isFinite(d.getTime())) return null
  return Math.ceil((d.getTime() - now.getTime()) / DAY)
}

const money = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return null
  return `$${Math.round(v).toLocaleString()}`
}

/**
 * Gather the raw signals for one profile. Every query is best-effort so a
 * missing column/table in some environment never breaks the digest.
 */
async function gatherProfileSignals(db, profileId, now) {
  const out = { grants: [], openInvoices: [] }
  try {
    out.grants = await db.prepare(
      `SELECT id, title, funder, status, deadline, award_date, end_date,
              amount_requested, amount_awarded, portal_url, application_url
         FROM grants
        WHERE profile_id = ?
          AND (status IS NULL OR status NOT IN ('archived','declined','rejected','declined_no_review','closed'))
        ORDER BY deadline IS NULL, deadline ASC`,
    ).all(String(profileId))
  } catch (err) { log.warn('grants query failed', { profileId, error: err?.message }) }

  try {
    out.openInvoices = await db.prepare(
      `SELECT id, amount_cents, status, due_at, period_start, period_end
         FROM billing_invoices
        WHERE profile_id = ? AND status IN ('sent','second_notice','suspended')
        ORDER BY issued_at DESC LIMIT 10`,
    ).all(String(profileId))
  } catch { /* billing schema may not be present in some envs */ }

  return out
}

/** Build the digest content (sections + rendered text/html) for one profile. */
export function buildDigest({ displayName, signals, now = new Date() }) {
  const { grants, openInvoices } = signals
  const immediate = []
  const soon = []
  const upcoming = []
  const awarded = []
  const stageCounts = {}
  let awardedTotal = 0

  for (const g of grants || []) {
    const status = g.status || 'discovered'
    stageCounts[status] = (stageCounts[status] || 0) + 1

    if (status === 'awarded') {
      awardedTotal += Number(g.amount_awarded) || 0
      const reqParts = []
      if (g.end_date) reqParts.push(`period ends ${g.end_date}`)
      if (g.award_date) reqParts.push(`awarded ${g.award_date}`)
      awarded.push({ title: g.title, funder: g.funder, amount: money(g.amount_awarded), detail: reqParts.join(' · ') })
      continue
    }

    const dUntil = daysUntil(g.deadline, now)
    const isActive = ACTIVE_PIPELINE.has(status)

    // Portal merge / missing info heuristics.
    if (isActive && g.portal_url && ['ready_to_submit', 'portal', 'submitted'].includes(status)) {
      immediate.push(`Portal step for “${g.title}” (${g.funder || 'funder'}) — confirm/merge the portal application.`)
    }
    if (isActive && ['gathering_documents', 'drafting', 'application_prep', 'revision'].includes(status) && dUntil !== null && dUntil <= 14) {
      immediate.push(`“${g.title}” still needs information (${status.replace(/_/g, ' ')}) and is due in ${dUntil} day${dUntil === 1 ? '' : 's'}.`)
    }

    if (dUntil !== null && dUntil >= 0) {
      const line = `${g.deadline} (${dUntil}d) — “${g.title}”${g.funder ? ` · ${g.funder}` : ''}`
      upcoming.push({ d: dUntil, line })
      if (dUntil <= 7) immediate.push(`Deadline in ${dUntil} day${dUntil === 1 ? '' : 's'}: “${g.title}”${g.funder ? ` (${g.funder})` : ''}.`)
      else if (dUntil <= 30) soon.push(`Deadline in ${dUntil} days: “${g.title}”${g.funder ? ` (${g.funder})` : ''}.`)
    }
    if (status === 'follow_up') soon.push(`Follow up on “${g.title}”${g.funder ? ` (${g.funder})` : ''}.`)
  }

  // Billing issues -> immediate attention.
  for (const inv of openInvoices || []) {
    const amt = money((Number(inv.amount_cents) || 0) / 100)
    const label = inv.status === 'suspended' ? 'account paused for an unpaid invoice' : 'an open invoice'
    immediate.push(`Billing: ${label}${amt ? ` (${amt})` : ''}${inv.due_at ? `, due ${String(inv.due_at).slice(0, 10)}` : ''}.`)
  }

  upcoming.sort((a, b) => a.d - b.d)
  const dedupe = (arr) => Array.from(new Set(arr))
  const immediateList = dedupe(immediate)
  const soonList = dedupe(soon)

  const stageSummary = Object.entries(stageCounts)
    .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
    .join(', ') || 'no active items yet'

  const subject = `GrantFlow weekly update — ${displayName || 'your profile'}${immediateList.length ? ` (${immediateList.length} need attention)` : ''}`

  const section = (title, items, empty) =>
    items.length
      ? `${title}:\n` + items.map((i) => `  • ${typeof i === 'string' ? i : i.line}`).join('\n')
      : `${title}:\n  • ${empty}`

  const text = [
    `Hi${displayName ? ` ${displayName}` : ''},`,
    '',
    `Here's where your funding stands this week.`,
    '',
    `Pipeline: ${stageSummary}.${awardedTotal > 0 ? ` Awarded to date: ${money(awardedTotal)}.` : ''}`,
    '',
    section('NEEDS IMMEDIATE ATTENTION', immediateList, 'Nothing urgent — nicely done.'),
    '',
    section('NEEDS ATTENTION SOON', soonList, 'Nothing in the next few weeks.'),
    '',
    section('UPCOMING DEADLINES', upcoming.slice(0, 15), 'No upcoming deadlines in your pipeline.'),
    '',
    section('AWARDED — DEADLINES & REQUIREMENTS', awarded.map((a) => `“${a.title}”${a.amount ? ` (${a.amount})` : ''}${a.detail ? ` — ${a.detail}` : ''}`), 'No awarded sources yet.'),
    '',
    'We can help with any of the above — just reply.',
    'The GrantFlow team',
  ].join('\n')

  const htmlSection = (title, items, empty, color) =>
    `<h3 style="margin:18px 0 6px;color:${color}">${esc(title)}</h3>` +
    (items.length
      ? `<ul style="margin:0;padding-left:20px">${items.map((i) => `<li>${esc(typeof i === 'string' ? i : i.line)}</li>`).join('')}</ul>`
      : `<p style="margin:0;color:#64748b">${esc(empty)}</p>`)

  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#0f172a;line-height:1.5">
    <p>Hi${displayName ? ` ${esc(displayName)}` : ''},</p>
    <p>Here's where your funding stands this week.</p>
    <p style="background:#f1f5f9;border-radius:8px;padding:8px 12px"><strong>Pipeline:</strong> ${esc(stageSummary)}.${awardedTotal > 0 ? ` <strong>Awarded to date:</strong> ${esc(money(awardedTotal))}.` : ''}</p>
    ${htmlSection('Needs immediate attention', immediateList, 'Nothing urgent — nicely done.', '#dc2626')}
    ${htmlSection('Needs attention soon', soonList, 'Nothing in the next few weeks.', '#d97706')}
    ${htmlSection('Upcoming deadlines', upcoming.slice(0, 15).map((u) => u.line), 'No upcoming deadlines in your pipeline.', '#2563eb')}
    ${htmlSection('Awarded — deadlines & requirements', awarded.map((a) => `${a.title}${a.amount ? ` (${a.amount})` : ''}${a.detail ? ` — ${a.detail}` : ''}`), 'No awarded sources yet.', '#059669')}
    <p style="margin-top:18px">We can help with any of the above — just reply.<br/>The GrantFlow team</p>
  </div>`

  return {
    subject, text, html,
    counts: { immediate: immediateList.length, soon: soonList.length, upcoming: upcoming.length, awarded: awarded.length },
  }
}

/**
 * Run the weekly digest: build + deliver one message per active profile
 * ("active" = status not deleted/suspended, and not one of Amy's synthetic
 * QA profiles). Delivery is per weeklyDigestDeliveryMode(): 'draft' (Outlook
 * draft into the owner's mailbox) or 'send' (auto-send via the comms channel).
 * Returns a summary { ran, mode, drafted, sent, skipped_no_email, profiles, errors }.
 *
 * `_sendBroadcast` is injectable for unit tests only.
 */
export async function runHamiltonWeeklyDigest(db, { now = new Date(), force = false, profileIds = null, _sendBroadcast = sendBroadcast } = {}) {
  if (!force && !isWeeklyDigestEnabled()) return { ran: false, reason: 'disabled' }

  const mode = weeklyDigestDeliveryMode()
  let provider = null
  let config = null
  if (mode === 'draft') {
    provider = createOutlookProvider()
    if (provider.notConfigured) {
      log.warn('weekly digest skipped — Outlook provider not configured')
      return { ran: false, reason: 'outlook_not_configured' }
    }
    config = getJohnConfig()
  }
  const fromAlias = config ? (config.fromAlias || config.primaryMailbox) : null
  const displayNameHdr = config ? (config.displayName || 'GrantFlow') : 'GrantFlow'

  let profiles = []
  if (Array.isArray(profileIds) && profileIds.length) {
    profiles = profileIds.map((id) => ({ id }))
  } else {
    try {
      // Skip Amy's synthetic profiles (created_by='agent:amy') — they are QA
      // fixtures, not real clients, and must never receive a digest.
      profiles = await db.prepare(`SELECT id FROM profiles WHERE (status IS NULL OR status NOT IN ('deleted','suspended')) AND (created_by IS NULL OR created_by <> 'agent:amy')`).all()
    } catch { try { profiles = await db.prepare('SELECT id FROM profiles').all() } catch { profiles = [] } }
  }

  let drafted = 0, sent = 0, skippedNoEmail = 0, errors = 0
  for (const p of profiles || []) {
    try {
      const contacts = await resolveProfileContacts(db, p.id)
      const emails = contacts.emails.map((e) => e.email)
      if (emails.length === 0) { skippedNoEmail += 1; continue }
      const signals = await gatherProfileSignals(db, p.id, now)
      const digest = buildDigest({ displayName: contacts.display_name, signals, now })
      if (mode === 'send') {
        // Auto-send via the existing comms machinery; every send lands in
        // comms_broadcasts + comms_broadcast_recipients (kind 'weekly_digest')
        // for the Sam/Anya observability trail.
        const r = await _sendBroadcast(db, {
          profileIds: [p.id],
          channel: 'email',
          subject: digest.subject,
          body: digest.text,
          html: digest.html,
          sentBy: 'hamilton',
          kind: 'weekly_digest',
        })
        if ((r?.sent_email ?? 0) > 0) sent += 1
        else { errors += 1; log.warn('digest send failed', { profile_id: p.id, error: r?.recipients?.[0]?.error || r?.error || 'no_email_sent' }) }
      } else {
        await provider.createDraft({
          toEmail: emails,
          toName: contacts.display_name || undefined,
          subject: digest.subject,
          bodyHtml: digest.html,
          bodyText: digest.text,
          requestedFromAlias: fromAlias,
          replyTo: config.replyTo || fromAlias,
          displayName: displayNameHdr,
        })
        drafted += 1
      }
    } catch (err) {
      errors += 1
      log.warn(`digest ${mode} failed`, { profile_id: p.id, error: err?.message })
    }
  }

  const summary = { ran: true, mode, drafted, sent, skipped_no_email: skippedNoEmail, profiles: (profiles || []).length, errors, at: now.toISOString() }
  log.info('weekly digest complete', summary)
  return summary
}
