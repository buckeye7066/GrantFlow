/**
 * invoiceService.js — generate, email, chase, and settle invoices.
 *
 * Flow (per the owner's spec):
 *   - On the account's cadence (weekly Fri 09:00 ET / semimonthly / monthly) an
 *     invoice is generated and emailed to the user, CC'd to the owner.
 *   - If unpaid after 3 days → a second invoice/reminder is sent.
 *   - If unpaid after 7 days → the account is suspended.
 *   - Stripe webhook (or admin mark-paid) flips an invoice to paid and lifts any
 *     suspension.
 *
 * SAFETY: the whole cycle is gated behind BILLING_AUTOMATION_ENABLED (default
 * OFF) so it never sends real money emails or suspends accounts until the owner
 * turns it on. Email is best-effort (Resend); Stripe payment links are included
 * only when Stripe is configured.
 */

import crypto from 'crypto'
import { ensureBillingSchema, mapAccountRow, computeEffectiveBilling } from '../billingAccounts.js'
import { billingMomentPassed, normalizeCadence } from './invoiceSchedule.js'
import { sendEmail } from '../email.js'
import { ADMIN_EMAIL } from '../../config/constants.js'
import { createLogger } from '../../utils/logger.js'
import { notifyProfile } from '../comms/commsService.js'
import { suspendProfile, cadenceCycleDays } from './accountStatus.js'

const log = createLogger('invoiceService')

export function isBillingAutomationEnabled() {
  return String(process.env.BILLING_AUTOMATION_ENABLED || 'false').toLowerCase() === 'true'
}
function ownerCc() {
  return String(process.env.BILLING_OWNER_CC || ADMIN_EMAIL || '').trim() || null
}
const SECOND_NOTICE_DAYS = () => Number(process.env.BILLING_SECOND_NOTICE_DAYS || 3)
const SUSPEND_DAYS = () => Number(process.env.BILLING_SUSPEND_DAYS || 7)
const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`

let ensured = false
export async function ensureInvoiceSchema(db) {
  if (!db || ensured) return
  await ensureBillingSchema(db)
  const isPg = db?.dialect === 'postgres'
  const ts = isPg ? 'TIMESTAMPTZ' : 'TIMESTAMP'
  // Cadence + anchor on the account, plus the free-period (trial) window the
  // owner can grant (one week / one month, individually or globally). A profile
  // is "currently free" when free_until IS NOT NULL AND free_until > now — a
  // pure suppression window, independent of pro-bono (permanent) and discounts.
  for (const [col, ddl] of [
    ['billing_cadence', `TEXT DEFAULT 'weekly'`],
    ['billing_anchor_at', ts],
    ['free_until', ts],
    ['free_granted_at', ts],
    ['free_kind', `TEXT`],
    ['free_reason', `TEXT`],
    // Set true on each grant; cleared the first time the user sees the in-app
    // notice. Drives the "your free week/month started on X" first-login banner.
    ['free_notice_pending', isPg ? `BOOLEAN DEFAULT FALSE` : `BOOLEAN DEFAULT 0`],
  ]) {
    try { await db.exec(`ALTER TABLE billing_accounts ADD COLUMN ${col} ${ddl}`) } catch { /* exists */ }
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS billing_invoices (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      account_id TEXT,
      cadence TEXT NOT NULL,
      period_key TEXT NOT NULL,
      period_start TEXT,
      period_end TEXT,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'sent',
      recipient_email TEXT,
      stripe_invoice_id TEXT,
      stripe_payment_link TEXT,
      reminders_sent INTEGER NOT NULL DEFAULT 0,
      issued_at ${ts},
      due_at ${ts},
      last_reminder_at ${ts},
      paid_at ${ts},
      suspended_at ${ts},
      created_at ${ts} DEFAULT ${isPg ? 'now()' : 'CURRENT_TIMESTAMP'}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoices_account_period ON billing_invoices(profile_id, period_key);
    CREATE INDEX IF NOT EXISTS idx_billing_invoices_status ON billing_invoices(status);
  `)
  ensured = true
}

/**
 * Amy's synthetic crawler-training profiles (created_by 'agent:amy') carry
 * non-routable RFC-6761 `.invalid` emails. Invoicing them just bounces at
 * Resend forever (dunning re-reminds daily), so billing skips them entirely —
 * same exclusion the weekly digest and outreach loaders apply.
 */
async function isSyntheticProfile(db, profileId) {
  try {
    const row = await db.prepare('SELECT created_by FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    return String(row?.created_by || '') === 'agent:amy'
  } catch { return false }
}

export function isNonRoutableEmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || ''
  return domain === 'invalid' || domain.endsWith('.invalid')
}

/** Resolve the email to invoice: profile owner user email, else basic_information.email. */
async function resolveRecipientEmail(db, profileId) {
  try {
    const row = await db.prepare(
      `SELECT u.primary_email FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.id = ? LIMIT 1`,
    ).get(String(profileId))
    if (row?.primary_email) return row.primary_email
  } catch { /* fall through */ }
  try {
    const sec = await db.prepare(
      `SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1`,
    ).get(String(profileId))
    if (sec?.data) {
      const d = typeof sec.data === 'string' ? JSON.parse(sec.data) : sec.data
      if (d?.email) return d.email
    }
  } catch { /* none */ }
  return null
}

/** Warm, MBA-level invoice email (HTML + text). */
export function buildInvoiceEmail({ orgName, amountCents, periodStart, periodEnd, cadence, dueDate, paymentLink, secondNotice = false }) {
  const amt = money(amountCents)
  const periodLine = periodStart && periodEnd ? `${periodStart} – ${periodEnd}` : 'the current period'
  const greeting = orgName ? `Hi ${orgName},` : 'Hello,'
  const lead = secondNotice
    ? `A quick, friendly follow-up — our records show the invoice below is still open. If it's already on its way, thank you and please disregard.`
    : `Thank you for the work we get to do alongside you. Here is your ${cadence} invoice for ${periodLine}.`
  const payLine = paymentLink
    ? `You can settle it securely here: ${paymentLink}`
    : `Reply to this email and we'll send a secure payment link, or let us know if anything looks off.`
  const subject = secondNotice
    ? `Reminder: invoice for ${periodLine} (${amt})`
    : `Your GrantFlow invoice — ${periodLine} (${amt})`
  const text = [
    greeting, '', lead, '',
    `Amount due: ${amt}`,
    `Billing period: ${periodLine}`,
    dueDate ? `Due by: ${dueDate}` : '', '',
    payLine, '',
    `We bill transparently — no percentage-of-award fees, ever — and we're glad to talk through anything.`, '',
    'With appreciation,', 'The GrantFlow team',
  ].filter((l) => l !== undefined).join('\n')
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;color:#0f172a;line-height:1.5">
    <p>${esc(greeting)}</p>
    <p>${esc(lead)}</p>
    <table style="border-collapse:collapse;margin:12px 0"><tbody>
      <tr><td style="padding:4px 12px 4px 0;color:#475569">Amount due</td><td style="padding:4px 0;font-weight:700">${amt}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#475569">Billing period</td><td style="padding:4px 0">${esc(periodLine)}</td></tr>
      ${dueDate ? `<tr><td style="padding:4px 12px 4px 0;color:#475569">Due by</td><td style="padding:4px 0">${esc(dueDate)}</td></tr>` : ''}
    </tbody></table>
    <p>${paymentLink ? `<a href="${esc(paymentLink)}" style="background:#059669;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Pay securely</a>` : esc(payLine)}</p>
    <p style="color:#475569;font-size:13px">We bill transparently — no percentage-of-award fees, ever — and we're glad to talk through anything.</p>
    <p>With appreciation,<br/>The GrantFlow team</p>
  </body></html>`
  return { subject, html, text }
}

/** Optional Stripe payment link (only when Stripe is configured). Best-effort. */
async function maybeStripePaymentLink(db, { profileId, amountCents, invoiceId }) {
  if (!process.env.STRIPE_SECRET_KEY) return null
  try {
    const { createInvoicePaymentLink } = await import('../stripeService.js').catch(() => ({}))
    if (typeof createInvoicePaymentLink === 'function') {
      return await createInvoicePaymentLink(db, { profileId, amountCents, invoiceId })
    }
  } catch (err) { log.warn('stripe payment link failed', { error: err?.message }) }
  return null
}

/**
 * Generate any invoice that is now due for an account and email it. Idempotent:
 * one invoice per (profile, period_key). Skips $0 / pro-bono and periods before
 * the account's billing anchor. Returns the created invoice or null.
 */
export async function generateInvoiceForAccount(db, accountRow, { now = new Date() } = {}) {
  await ensureInvoiceSchema(db)
  const account = mapAccountRow(accountRow)
  if (!account?.profile_id) return null
  if (await isSyntheticProfile(db, account.profile_id)) {
    log.info('invoice skipped — synthetic (agent:amy) profile', { profile_id: account.profile_id })
    return null
  }
  const cadence = normalizeCadence(accountRow.billing_cadence || account.billing_cadence)
  // billing_anchor_at doubles as the biweekly parity epoch: the every-other-
  // Friday alternation is pinned to the account's persisted anchor (or the
  // fixed BIWEEKLY_EPOCH), so restarts/redeploys can never flip which Friday
  // an account is invoiced on.
  const moment = billingMomentPassed(cadence, now, { anchor: accountRow.billing_anchor_at || null })

  // Respect the billing anchor (don't invoice periods before billing started).
  const anchor = accountRow.billing_anchor_at ? new Date(accountRow.billing_anchor_at) : null
  if (anchor && new Date(moment.billed_at) < anchor) return null

  // Respect an active free period (one week / one month the owner granted). No
  // invoice is generated while the window is open; normal billing resumes
  // automatically once free_until passes.
  if (isFreePeriodActive(accountRow, now)) {
    log.info('invoice skipped — free period active', { profile_id: account.profile_id, free_until: accountRow.free_until })
    return null
  }

  // Already invoiced this period?
  const exists = await db.prepare('SELECT id FROM billing_invoices WHERE profile_id = ? AND period_key = ? LIMIT 1')
    .get(account.profile_id, moment.period_key)
  if (exists) return null

  const eff = await computeEffectiveBilling(db, account.profile_id, account)
  if (eff.is_pro_bono || !eff.net_monthly_cents) return null // nothing to bill

  const id = crypto.randomUUID()
  const recipient = await resolveRecipientEmail(db, account.profile_id)
  const paymentLink = await maybeStripePaymentLink(db, { profileId: account.profile_id, amountCents: eff.net_monthly_cents, invoiceId: id })
  const dueAt = new Date(now.getTime() + SUSPEND_DAYS() * 86400000).toISOString()

  await db.prepare(
    `INSERT INTO billing_invoices (id, profile_id, account_id, cadence, period_key, period_start, period_end,
        amount_cents, currency, status, recipient_email, stripe_payment_link, issued_at, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'sent', ?, ?, ?, ?)`,
  ).run(id, account.profile_id, account.id, cadence, moment.period_key, moment.period_start, moment.period_end,
    eff.net_monthly_cents, recipient, paymentLink, now.toISOString(), dueAt)

  const orgName = await resolveOrgName(db, account.profile_id)
  if (recipient && !isNonRoutableEmail(recipient)) {
    const mail = buildInvoiceEmail({ orgName, amountCents: eff.net_monthly_cents, periodStart: moment.period_start, periodEnd: moment.period_end, cadence, dueDate: dueAt.slice(0, 10), paymentLink })
    await sendEmail({ to: recipient, cc: ownerCc(), subject: mail.subject, html: mail.html, text: mail.text })
  }
  log.info('invoice generated', { profile_id: account.profile_id, period: moment.period_key, amount: eff.net_monthly_cents, emailed: Boolean(recipient) })
  return { id, profile_id: account.profile_id, period_key: moment.period_key, amount_cents: eff.net_monthly_cents }
}

async function resolveOrgName(db, profileId) {
  try {
    const row = await db.prepare('SELECT display_name FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    return row?.display_name || null
  } catch { return null }
}

/**
 * Chase + suspend: second notice at SECOND_NOTICE_DAYS, suspend at SUSPEND_DAYS.
 */
export async function processDunning(db, { now = new Date() } = {}) {
  await ensureInvoiceSchema(db)
  // SAFETY: never auto-suspend when there's no way for the user to pay. Suspend
  // requires either Stripe configured (a real payment path) or an explicit
  // override. Otherwise we keep reminding but never lock anyone out.
  const canSuspend = Boolean(process.env.STRIPE_SECRET_KEY)
    || String(process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE || 'false').toLowerCase() === 'true'
  const open = await db.prepare(`SELECT * FROM billing_invoices WHERE status IN ('sent','second_notice')`).all()
  let reminded = 0
  let suspended = 0
  let voided = 0
  for (const inv of open || []) {
    // Retire invoices that can never be paid: synthetic (agent:amy) profiles
    // and non-routable `.invalid` recipients. Voiding stops the daily reminder
    // -> bounce loop; existing bad rows heal on the next dunning pass.
    if (isNonRoutableEmail(inv.recipient_email) || await isSyntheticProfile(db, inv.profile_id)) {
      await db.prepare(`UPDATE billing_invoices SET status = 'void' WHERE id = ?`).run(inv.id)
      log.info('invoice voided — synthetic profile or non-routable recipient', { invoice_id: inv.id, profile_id: inv.profile_id })
      voided += 1
      continue
    }
    const issued = inv.issued_at ? new Date(inv.issued_at) : null
    if (!issued) continue
    const ageDays = (now - issued) / 86400000

    // Suspend once an invoice is a full billing CYCLE past due (one week, two
    // weeks, or one month depending on the account's cadence). An explicit
    // BILLING_SUSPEND_DAYS override still wins if set.
    const cycleDays = Number(process.env.BILLING_SUSPEND_DAYS) || cadenceCycleDays(inv.cadence)

    if (ageDays >= cycleDays && canSuspend) {
      await db.prepare(`UPDATE billing_invoices SET status = 'suspended', suspended_at = ? WHERE id = ?`).run(now.toISOString(), inv.id)
      // Single suspension path (sets profile status + notifies profile & admin
      // with how to lift). Pass the invoice's payment link when present.
      await suspendProfile(db, {
        profileId: inv.profile_id,
        reason: 'past_due',
        suspendedBy: 'billing_dunning',
        paymentLink: inv.stripe_payment_link || null,
      }).catch((err) => log.warn('suspendProfile failed', { error: err?.message }))
      suspended += 1
    } else if (ageDays >= SECOND_NOTICE_DAYS() && inv.status === 'sent') {
      await db.prepare(`UPDATE billing_invoices SET status = 'second_notice', reminders_sent = reminders_sent + 1, last_reminder_at = ? WHERE id = ?`).run(now.toISOString(), inv.id)
      const orgName = await resolveOrgName(db, inv.profile_id)
      if (inv.recipient_email) {
        const mail = buildInvoiceEmail({ orgName, amountCents: inv.amount_cents, periodStart: inv.period_start, periodEnd: inv.period_end, cadence: inv.cadence, dueDate: inv.due_at ? String(inv.due_at).slice(0, 10) : null, paymentLink: inv.stripe_payment_link, secondNotice: true })
        await sendEmail({ to: inv.recipient_email, cc: ownerCc(), subject: mail.subject, html: mail.html, text: mail.text })
      }
      reminded += 1
    }
  }
  return { reminded, suspended, voided }
}

/** Mark an invoice paid (Stripe webhook or admin) + lift any suspension. */
export async function markInvoicePaid(db, { invoiceId = null, profileId = null, stripeInvoiceId = null, source = 'manual' } = {}) {
  await ensureInvoiceSchema(db)
  let inv = null
  if (invoiceId) inv = await db.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(invoiceId)
  else if (stripeInvoiceId) inv = await db.prepare('SELECT * FROM billing_invoices WHERE stripe_invoice_id = ?').get(stripeInvoiceId)
  else if (profileId) inv = await db.prepare(`SELECT * FROM billing_invoices WHERE profile_id = ? AND status != 'paid' ORDER BY issued_at DESC LIMIT 1`).get(profileId)
  if (!inv) return { ok: false, error: 'invoice_not_found' }

  await db.prepare(`UPDATE billing_invoices SET status = 'paid', paid_at = ? WHERE id = ?`).run(new Date().toISOString(), inv.id)
  // If the profile was suspended for this invoice, reactivate.
  if (inv.status === 'suspended') {
    try { await db.prepare(`UPDATE profiles SET status = 'active' WHERE id = ?`).run(inv.profile_id) } catch { /* status col */ }
  }
  log.info('invoice paid', { invoice_id: inv.id, profile_id: inv.profile_id, source })
  return { ok: true, invoice_id: inv.id, profile_id: inv.profile_id, reactivated: inv.status === 'suspended' }
}

/**
 * The scheduled cycle: generate due invoices for every active account, then run
 * dunning. No-op unless BILLING_AUTOMATION_ENABLED=true.
 */
export async function runBillingCycle(db, { now = new Date(), force = false } = {}) {
  if (!force && !isBillingAutomationEnabled()) return { ran: false, reason: 'disabled' }
  await ensureInvoiceSchema(db)
  let generated = 0
  try {
    const accounts = await db.prepare('SELECT * FROM billing_accounts').all()
    for (const acc of accounts || []) {
      const r = await generateInvoiceForAccount(db, acc, { now }).catch((e) => { log.warn('generate failed', { profile_id: acc.profile_id, error: e?.message }); return null })
      if (r) generated += 1
    }
  } catch (err) { log.warn('runBillingCycle accounts query failed', { error: err?.message }) }
  const dun = await processDunning(db, { now }).catch(() => ({ reminded: 0, suspended: 0 }))
  return { ran: true, generated, ...dun }
}

/**
 * Set the billing anchor (when billing starts) for every account that doesn't
 * have one. Used once to start all existing profiles' billing as of a given
 * instant (the owner asked for 09:00 ET this morning).
 */
export async function backfillBillingAnchor(db, anchorIso, { provisionAll = true } = {}) {
  await ensureInvoiceSchema(db)
  let provisioned = 0
  // Billing accounts are created lazily, so "start ALL existing profiles' billing"
  // means first ensuring every active profile HAS an account, then anchoring.
  if (provisionAll) {
    const { ensureBillingAccount } = await import('../billingAccounts.js')
    let profiles = []
    try {
      profiles = await db.prepare(`SELECT id FROM profiles WHERE status IS NULL OR status NOT IN ('deleted','suspended')`).all()
    } catch { try { profiles = await db.prepare('SELECT id FROM profiles').all() } catch { profiles = [] } }
    for (const p of profiles || []) {
      try { await ensureBillingAccount(db, p.id); provisioned += 1 } catch { /* skip */ }
    }
  }
  const res = await db.prepare(`UPDATE billing_accounts SET billing_anchor_at = ? WHERE billing_anchor_at IS NULL`).run(anchorIso)
  return { provisioned, anchored: res?.changes ?? null, anchor: anchorIso }
}

// ---------------------------------------------------------------------------
// Free periods (one week / one month free), individual or global.
// ---------------------------------------------------------------------------

/** Map a free-period kind to its duration in days. */
export const FREE_PERIOD_DAYS = Object.freeze({ week: 7, month: 30 })

/** True when the account has an open free window at `now`. Pure read. */
export function isFreePeriodActive(accountRow, now = new Date()) {
  if (!accountRow?.free_until) return false
  const until = new Date(accountRow.free_until)
  return Number.isFinite(until.getTime()) && until.getTime() > now.getTime()
}

/**
 * Describe an account's free-period state for API responses. Pure read.
 * Returns { active, kind, until, granted_at, reason, days_remaining }.
 */
export function describeFreePeriod(accountRow, now = new Date()) {
  const active = isFreePeriodActive(accountRow, now)
  const until = accountRow?.free_until ? new Date(accountRow.free_until) : null
  const daysRemaining = active && until
    ? Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 86400000))
    : 0
  return {
    active,
    kind: accountRow?.free_kind ?? null,
    until: accountRow?.free_until ?? null,
    granted_at: accountRow?.free_granted_at ?? null,
    reason: accountRow?.free_reason ?? null,
    days_remaining: daysRemaining,
    notice_pending: Boolean(accountRow?.free_notice_pending),
  }
}

/** Friendly announcement copy for a granted free period (email + SMS share it). */
export function buildFreePeriodAnnouncement({ kind, grantedAt, until, orgName }) {
  const label = kind === 'month' ? 'a free month' : 'a free week'
  const started = grantedAt ? new Date(grantedAt).toLocaleDateString() : 'today'
  const through = until ? new Date(until).toLocaleDateString() : null
  const greeting = orgName ? `Hi ${orgName},` : 'Hello,'
  const subject = `You've got ${label} on GrantFlow 🎉`
  const text = [
    greeting, '',
    `Good news — we've added ${label} to your GrantFlow account. It started on ${started}${through ? ` and runs through ${through}` : ''}.`,
    `You won't be invoiced during this time. Everything keeps working exactly as it does now.`,
    '', 'With appreciation,', 'The GrantFlow team',
  ].join('\n')
  return { subject, text }
}

/**
 * Compute the new free_until when granting `kind` ('week'|'month'). The timer
 * starts at the moment of the grant (`now`), but never SHORTENS an existing
 * future window — we extend from whichever is later so re-granting stacks
 * gracefully rather than cutting an in-flight trial short.
 */
function nextFreeUntil(existingFreeUntil, kind, now) {
  const days = FREE_PERIOD_DAYS[kind]
  if (!days) throw new Error(`invalid free period kind: ${kind}`)
  const existing = existingFreeUntil ? new Date(existingFreeUntil) : null
  const base = existing && Number.isFinite(existing.getTime()) && existing.getTime() > now.getTime()
    ? existing
    : now
  return new Date(base.getTime() + days * 86400000)
}

/**
 * Grant a free period to one profile. `kind` is 'week' or 'month'. Ensures the
 * billing account exists first. Returns the resulting free-period descriptor.
 */
export async function grantFreePeriod(db, { profileId, kind = 'week', reason = null, grantedBy = 'admin', announce = true, now = new Date() } = {}) {
  if (!profileId) return { ok: false, error: 'profile_id_required' }
  if (!FREE_PERIOD_DAYS[kind]) return { ok: false, error: 'invalid_kind' }
  await ensureInvoiceSchema(db)
  const { ensureBillingAccount } = await import('../billingAccounts.js')
  const accountRow = await ensureBillingAccount(db, profileId)
  const until = nextFreeUntil(accountRow.free_until, kind, now)
  const trueVal = db?.dialect === 'postgres' ? true : 1
  await db.prepare(
    `UPDATE billing_accounts SET free_until = ?, free_granted_at = ?, free_kind = ?, free_reason = ?, free_notice_pending = ?, updated_at = ${db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'} WHERE profile_id = ?`,
  ).run(until.toISOString(), now.toISOString(), kind, reason, trueVal, profileId)
  log.info('free period granted', { profile_id: profileId, kind, until: until.toISOString(), granted_by: grantedBy })

  // Announce it (email preferred, SMS fallback). Best-effort — never fail the
  // grant because an email/SMS didn't go out. The in-app first-login notice
  // (free_notice_pending) is the durable channel; this is the proactive push.
  if (announce) {
    try {
      const orgName = await resolveOrgName(db, profileId)
      const msg = buildFreePeriodAnnouncement({ kind, grantedAt: now.toISOString(), until: until.toISOString(), orgName })
      await notifyProfile(db, { profileId, subject: msg.subject, text: msg.text, channel: 'auto' })
    } catch (err) { log.warn('free period announcement failed', { profile_id: profileId, error: err?.message }) }
  }
  return { ok: true, profile_id: profileId, kind, free_until: until.toISOString(), reason }
}

/**
 * Grant a free period to EVERY billing account (global). Provisions an account
 * for every active profile first so a freshly-created profile is covered too.
 * Returns the count granted.
 */
export async function grantFreePeriodGlobal(db, { kind = 'week', reason = null, grantedBy = 'admin', now = new Date() } = {}) {
  if (!FREE_PERIOD_DAYS[kind]) return { ok: false, error: 'invalid_kind' }
  await ensureInvoiceSchema(db)
  const { ensureBillingAccount } = await import('../billingAccounts.js')
  let profiles = []
  try {
    profiles = await db.prepare(`SELECT id FROM profiles WHERE status IS NULL OR status NOT IN ('deleted')`).all()
  } catch { try { profiles = await db.prepare('SELECT id FROM profiles').all() } catch { profiles = [] } }
  let granted = 0
  for (const p of profiles || []) {
    try { await grantFreePeriod(db, { profileId: p.id, kind, reason, grantedBy, now }); granted += 1 } catch { /* skip one */ }
  }
  log.info('free period granted globally', { kind, granted, granted_by: grantedBy })
  return { ok: true, kind, granted }
}

/**
 * Acknowledge (clear) the pending first-login free-period notice for a profile.
 * Called once the user has seen the "your free week/month started" banner.
 */
export async function acknowledgeFreeNotice(db, profileId) {
  await ensureInvoiceSchema(db)
  const falseVal = db?.dialect === 'postgres' ? false : 0
  await db.prepare('UPDATE billing_accounts SET free_notice_pending = ? WHERE profile_id = ?').run(falseVal, String(profileId))
  return { ok: true }
}

/** Revoke (clear) the free period for one profile (or all when profileId omitted). */
export async function revokeFreePeriod(db, { profileId = null } = {}) {
  await ensureInvoiceSchema(db)
  const clear = `free_until = NULL, free_granted_at = NULL, free_kind = NULL, free_reason = NULL`
  if (profileId) {
    await db.prepare(`UPDATE billing_accounts SET ${clear} WHERE profile_id = ?`).run(profileId)
    return { ok: true, profile_id: profileId }
  }
  const res = await db.prepare(`UPDATE billing_accounts SET ${clear} WHERE free_until IS NOT NULL`).run()
  return { ok: true, cleared: res?.changes ?? null }
}
