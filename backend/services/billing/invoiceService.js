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
  // Cadence + anchor on the account.
  for (const [col, ddl] of [
    ['billing_cadence', `TEXT DEFAULT 'weekly'`],
    ['billing_anchor_at', ts],
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
async function maybeStripePaymentLink(db, { profileId, amountCents }) {
  if (!process.env.STRIPE_SECRET_KEY) return null
  try {
    const { createInvoicePaymentLink } = await import('../stripeService.js').catch(() => ({}))
    if (typeof createInvoicePaymentLink === 'function') {
      return await createInvoicePaymentLink(db, { profileId, amountCents })
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
  const cadence = normalizeCadence(accountRow.billing_cadence || account.billing_cadence)
  const moment = billingMomentPassed(cadence, now)

  // Respect the billing anchor (don't invoice periods before billing started).
  const anchor = accountRow.billing_anchor_at ? new Date(accountRow.billing_anchor_at) : null
  if (anchor && new Date(moment.billed_at) < anchor) return null

  // Already invoiced this period?
  const exists = await db.prepare('SELECT id FROM billing_invoices WHERE profile_id = ? AND period_key = ? LIMIT 1')
    .get(account.profile_id, moment.period_key)
  if (exists) return null

  const eff = await computeEffectiveBilling(db, account.profile_id, account)
  if (eff.is_pro_bono || !eff.net_monthly_cents) return null // nothing to bill

  const id = crypto.randomUUID()
  const recipient = await resolveRecipientEmail(db, account.profile_id)
  const paymentLink = await maybeStripePaymentLink(db, { profileId: account.profile_id, amountCents: eff.net_monthly_cents })
  const dueAt = new Date(now.getTime() + SUSPEND_DAYS() * 86400000).toISOString()

  await db.prepare(
    `INSERT INTO billing_invoices (id, profile_id, account_id, cadence, period_key, period_start, period_end,
        amount_cents, currency, status, recipient_email, stripe_payment_link, issued_at, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'sent', ?, ?, ?, ?)`,
  ).run(id, account.profile_id, account.id, cadence, moment.period_key, moment.period_start, moment.period_end,
    eff.net_monthly_cents, recipient, paymentLink, now.toISOString(), dueAt)

  const orgName = await resolveOrgName(db, account.profile_id)
  if (recipient) {
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
  const open = await db.prepare(`SELECT * FROM billing_invoices WHERE status IN ('sent','second_notice')`).all()
  let reminded = 0
  let suspended = 0
  for (const inv of open || []) {
    const issued = inv.issued_at ? new Date(inv.issued_at) : null
    if (!issued) continue
    const ageDays = (now - issued) / 86400000

    if (ageDays >= SUSPEND_DAYS()) {
      await db.prepare(`UPDATE billing_invoices SET status = 'suspended', suspended_at = ? WHERE id = ?`).run(now.toISOString(), inv.id)
      try { await db.prepare(`UPDATE profiles SET status = 'suspended' WHERE id = ?`).run(inv.profile_id) } catch { /* status col */ }
      const orgName = await resolveOrgName(db, inv.profile_id)
      if (inv.recipient_email) {
        await sendEmail({
          to: inv.recipient_email, cc: ownerCc(),
          subject: `Account access paused — invoice ${money(inv.amount_cents)} unpaid`,
          text: `${orgName ? `Hi ${orgName},` : 'Hello,'}\n\nWe've temporarily paused this account because the invoice for ${inv.period_start}–${inv.period_end} (${money(inv.amount_cents)}) is now ${Math.floor(ageDays)} days past due. Settle it and access resumes right away — just reply and we'll help.\n\nThe GrantFlow team`,
        })
      }
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
  return { reminded, suspended }
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
