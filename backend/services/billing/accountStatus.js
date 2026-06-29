/**
 * accountStatus.js — suspend / reactivate a profile, and ban / unban its user.
 *
 *  - Suspension is PROFILE-level (profiles.status = 'suspended'): the account
 *    keeps existing but access is paused. Used both by dunning (one full billing
 *    cycle past due) and by the owner manually from the admin panel.
 *  - A BAN is USER-level and routes through the canonical owner blocklist so the
 *    same machinery that already blocks login + mirrors to John/Yana suppression
 *    is reused (no parallel ban system). Banning also suspends the user's
 *    profiles.
 *
 * Every state change notifies the affected profile (email preferred, SMS
 * fallback) AND the owner/admin, and explains how to lift it.
 */

import { ADMIN_EMAIL } from '../../config/constants.js'
import { sendEmail } from '../email.js'
import { notifyProfile, resolveProfileContacts } from '../comms/commsService.js'
import { addEntry, removeEntry, markUserBlockedByEmail } from '../blocklist/ownerBlocklistService.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('accountStatus')

function adminEmail() {
  return String(process.env.BILLING_OWNER_CC || ADMIN_EMAIL || '').trim() || null
}

/** Days in ONE billing cycle for a cadence — the past-due suspension threshold. */
export function cadenceCycleDays(cadence) {
  switch (String(cadence || 'weekly').toLowerCase()) {
    case 'monthly': return 30
    case 'semimonthly': return 15
    case 'biweekly': return 14
    case 'weekly':
    default: return 7
  }
}

async function resolveOrgName(db, profileId) {
  try {
    const row = await db.prepare('SELECT display_name FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    return row?.display_name || null
  } catch { return null }
}

function howToLiftText({ paymentLink } = {}) {
  return paymentLink
    ? `To restore access, settle the balance here: ${paymentLink} — access resumes automatically once payment is received. Or simply reply to this email and we'll help.`
    : `To restore access, reply to this email to settle the balance or arrange payment, and we'll lift the pause right away.`
}

/**
 * Suspend a profile. Sets profiles.status='suspended', notifies the profile
 * (email + SMS) and the owner, and records why. `paymentLink` is included in the
 * "how to lift" copy when available.
 */
export async function suspendProfile(db, { profileId, reason = 'past_due', suspendedBy = 'system', paymentLink = null, notify = true } = {}) {
  if (!profileId) return { ok: false, error: 'profile_id_required' }
  try {
    await db.prepare(`UPDATE profiles SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(String(profileId))
  } catch (err) {
    return { ok: false, error: err?.message || 'suspend_failed' }
  }
  const orgName = await resolveOrgName(db, profileId)
  log.info('profile suspended', { profile_id: profileId, reason, by: suspendedBy })

  if (notify) {
    const subject = 'Your GrantFlow account has been paused'
    const text = [
      orgName ? `Hi ${orgName},` : 'Hello,', '',
      `Access to this GrantFlow account has been paused${reason === 'past_due' ? ' because an invoice is now past due' : ''}.`,
      howToLiftText({ paymentLink }), '',
      'The GrantFlow team',
    ].join('\n')
    try { await notifyProfile(db, { profileId, subject, text, channel: 'auto' }) } catch (err) { log.warn('suspend notify (profile) failed', { error: err?.message }) }
    const admin = adminEmail()
    if (admin) {
      try {
        await sendEmail({
          to: admin,
          subject: `[GrantFlow admin] Account paused: ${orgName || profileId}`,
          text: `Profile "${orgName || profileId}" (${profileId}) was suspended.\nReason: ${reason}\nBy: ${suspendedBy}\nLift it from Admin → Billing, or it lifts automatically when the invoice is paid.`,
        })
      } catch (err) { log.warn('suspend notify (admin) failed', { error: err?.message }) }
    }
  }
  return { ok: true, profile_id: String(profileId), status: 'suspended' }
}

/** Reactivate a suspended profile. */
export async function reactivateProfile(db, { profileId, reactivatedBy = 'admin', notify = true } = {}) {
  if (!profileId) return { ok: false, error: 'profile_id_required' }
  try {
    await db.prepare(`UPDATE profiles SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(String(profileId))
  } catch (err) {
    return { ok: false, error: err?.message || 'reactivate_failed' }
  }
  const orgName = await resolveOrgName(db, profileId)
  log.info('profile reactivated', { profile_id: profileId, by: reactivatedBy })
  if (notify) {
    const subject = 'Your GrantFlow account is active again'
    const text = `${orgName ? `Hi ${orgName},` : 'Hello,'}\n\nGood news — access to this GrantFlow account has been restored. Thank you!\n\nThe GrantFlow team`
    try { await notifyProfile(db, { profileId, subject, text, channel: 'auto' }) } catch (err) { log.warn('reactivate notify failed', { error: err?.message }) }
  }
  return { ok: true, profile_id: String(profileId), status: 'active' }
}

/** The email addresses to ban for a profile (owner + non-proxy profile emails). */
async function bannableEmails(db, profileId) {
  const contacts = await resolveProfileContacts(db, profileId)
  return contacts.emails.filter((e) => !e.is_proxy).map((e) => e.email)
}

/**
 * Ban the user(s) behind a profile: add their email(s) to the owner blocklist
 * (which blocks login + mirrors to outreach suppression), mark the account
 * banned, and suspend the profile. Notifies the owner.
 */
export async function banProfileUser(db, { profileId, reason = 'owner_ban', bannedBy = 'admin' } = {}) {
  if (!profileId) return { ok: false, error: 'profile_id_required' }
  const emails = await bannableEmails(db, profileId)
  let banned = 0
  for (const email of emails) {
    try {
      await addEntry(db, { match_type: 'email', value: email, reason, source: 'admin_ban', enforcement: 'block' })
      await markUserBlockedByEmail(db, email, reason)
      banned += 1
    } catch (err) { log.warn('ban email failed', { error: err?.message }) }
  }
  // Pausing the profile too so banned users can't keep operating an open session.
  await suspendProfile(db, { profileId, reason: 'banned', suspendedBy: bannedBy, notify: false })
  const orgName = await resolveOrgName(db, profileId)
  log.info('user banned', { profile_id: profileId, emails: emails.length, by: bannedBy })
  const admin = adminEmail()
  if (admin) {
    try {
      await sendEmail({
        to: admin,
        subject: `[GrantFlow admin] User banned: ${orgName || profileId}`,
        text: `Banned ${banned} email(s) for profile "${orgName || profileId}" (${profileId}).\nReason: ${reason}\nBy: ${bannedBy}\nThe email(s) can no longer log in. Unban from Admin → Billing.`,
      })
    } catch { /* best-effort */ }
  }
  return { ok: true, profile_id: String(profileId), banned_emails: banned }
}

/** Reverse a ban: remove the blocklist entries and reactivate the account. */
export async function unbanProfileUser(db, { profileId, unbannedBy = 'admin' } = {}) {
  if (!profileId) return { ok: false, error: 'profile_id_required' }
  const emails = await bannableEmails(db, profileId)
  for (const email of emails) {
    try {
      await removeEntry(db, { match_type: 'email', value: email })
      await db.prepare(`UPDATE users SET status = 'active', blocked_reason = NULL WHERE LOWER(primary_email) = LOWER(?)`).run(email)
    } catch (err) { log.warn('unban email failed', { error: err?.message }) }
  }
  await reactivateProfile(db, { profileId, reactivatedBy: unbannedBy, notify: false })
  log.info('user unbanned', { profile_id: profileId, by: unbannedBy })
  return { ok: true, profile_id: String(profileId), unbanned_emails: emails.length }
}
