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
 *   - PRO BONO (admin-only flag on the billing account): the account still gets
 *     a statement each cycle so the value of the work is on record, but it is
 *     issued settled — gross value, a matching pro bono credit, $0 due, no
 *     payment link, never chased. Flipping the flag on settles every open or
 *     suspended invoice the same way and lifts a billing suspension; dunning
 *     re-reads the flag before it chases anything, so an invoice issued before
 *     the grant can never suspend a pro bono account.
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
import { suspendProfile, reactivateProfile, cadenceCycleDays, readProfileLifecycleStatus } from './accountStatus.js'

const log = createLogger('invoiceService')

/** Invoice status for a settled pro bono statement ($0 due, never dunned). */
export const PRO_BONO_INVOICE_STATUS = 'pro_bono'
/** Statuses that still carry a balance the account is being asked to pay. */
const OPEN_INVOICE_STATUSES = ['sent', 'second_notice', 'suspended']

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
  // Pro bono bookkeeping. amount_cents stays "what is DUE" (every existing
  // reader + dunning keys off it); gross_amount_cents is the value of the work
  // and pro_bono_credit_cents the write-off that brought the balance to $0.
  for (const [col, ddl] of [
    ['gross_amount_cents', 'INTEGER'],
    ['pro_bono_credit_cents', 'INTEGER DEFAULT 0'],
    ['is_pro_bono', isPg ? 'BOOLEAN DEFAULT FALSE' : 'BOOLEAN DEFAULT 0'],
    ['settled_reason', 'TEXT'],
  ]) {
    try { await db.exec(`ALTER TABLE billing_invoices ADD COLUMN ${col} ${ddl}`) } catch { /* exists */ }
  }
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

/**
 * A deleted profile is never billed, chased, or suspended. Returns 'live',
 * 'deleted', or 'unknown'. "Deleted" is profiles.status = 'deleted' (soft
 * delete) OR no profiles row at all (a hard delete cascades billing_accounts
 * away, but billing_invoices has no FK, so its invoices outlive the profile).
 * 'unknown' means the read failed: callers FAIL CLOSED — skip billing work for
 * that profile this pass and touch nothing, so a transient error neither bills
 * nor voids.
 */
async function profileBillingLifecycle(db, profileId) {
  const state = await readProfileLifecycleStatus(db, profileId)
  if (!state) return 'unknown'
  return !state.exists || state.status === 'deleted' ? 'deleted' : 'live'
}

/**
 * Void the open invoices (every OPEN_INVOICE_STATUSES value, 'suspended'
 * included) of every deleted or vanished profile. Runs at the top of dunning,
 * BEFORE pro bono reconciliation, so a deleted pro bono profile's invoice is
 * voided as profile_deleted instead of being re-settled.
 */
async function voidOpenInvoicesOfDeletedProfiles(db) {
  const safeOpenStatusPlaceholders = OPEN_INVOICE_STATUSES.map(() => '?').join(',')
  const rows = await db.prepare(
    `SELECT DISTINCT profile_id FROM billing_invoices
      WHERE status IN (${safeOpenStatusPlaceholders})`,
  ).all(...OPEN_INVOICE_STATUSES)
  let voided = 0
  for (const row of rows || []) {
    if (!row?.profile_id) continue
    if (await profileBillingLifecycle(db, row.profile_id) !== 'deleted') continue
    const r = await voidOpenInvoicesForDeletedProfile(db, { profileId: row.profile_id })
    voided += r.voided || 0
  }
  // Retry Checkout expiry for invoices already voided for profile_deleted whose
  // link could not be expired earlier (a successful expiry clears the link).
  const pendingLinks = await db.prepare(
    `SELECT id, stripe_payment_link FROM billing_invoices
      WHERE status = 'void' AND settled_reason = 'profile_deleted' AND stripe_payment_link IS NOT NULL`,
  ).all()
  const retried = await expireAndClearInvoiceLinks(db, pendingLinks)
  return { voided, links_retried: (pendingLinks || []).filter((row) => row?.stripe_payment_link).length, links_expired_on_retry: retried.expired }
}

/**
 * Void every invoice on a deleted profile that still asks for money, so nothing
 * dangling is chased. Called by the profile delete route; dunning applies the
 * same rule to profiles deleted before this existed. Paid / pro bono / void
 * rows are history and stay untouched. Restoring a profile does not un-void.
 */
export async function voidOpenInvoicesForDeletedProfile(db, { profileId } = {}) {
  if (!profileId) return { ok: false, error: 'profile_id_required', voided: 0, links_expired: 0, links_not_expired: 0 }
  await ensureInvoiceSchema(db)
  const pid = String(profileId)
  const safeOpenStatusPlaceholders = OPEN_INVOICE_STATUSES.map(() => '?').join(',')
  const open = await db.prepare(
    `SELECT id, stripe_payment_link FROM billing_invoices
      WHERE profile_id = ? AND status IN (${safeOpenStatusPlaceholders})`,
  ).all(pid, ...OPEN_INVOICE_STATUSES)
  const res = await db.prepare(
    `UPDATE billing_invoices SET status = 'void', settled_reason = 'profile_deleted'
      WHERE profile_id = ? AND status IN (${safeOpenStatusPlaceholders})`,
  ).run(pid, ...OPEN_INVOICE_STATUSES)
  const voided = Number(res?.changes ?? 0) || 0
  const links = await expireAndClearInvoiceLinks(db, open)
  log.info('open invoices voided — profile deleted', { profile_id: pid, voided, links_expired: links.expired, links_not_expired: links.not_expired })
  return { ok: true, profile_id: pid, voided, links_expired: links.expired, links_not_expired: links.not_expired }
}

/**
 * Every writer that marks profiles deleted (the profile and organization
 * delete routes, profile merge, the dedupe and orphan-maintenance scripts)
 * calls this so no deleted profile keeps an open invoice or a payable link.
 * Acts only on profiles whose lifecycle now reads deleted or missing, so a
 * caller can never void a live profile's billing. Best-effort; never throws.
 */
export async function voidInvoicesForDeletedProfiles(db, profileIds = []) {
  const ids = [...new Set((profileIds || []).filter(Boolean).map(String))]
  let voided = 0
  let failed = 0
  for (const profileId of ids) {
    try {
      if (await profileBillingLifecycle(db, profileId) !== 'deleted') continue
      const r = await voidOpenInvoicesForDeletedProfile(db, { profileId })
      voided += r.voided || 0
    } catch (err) {
      failed += 1
      log.warn('void invoices for deleted profile failed', { profile_id: profileId, error: err?.message })
    }
  }
  return { profiles: ids.length, voided, failed }
}

/**
 * Best-effort: expire the Stripe Checkout Session behind each voided invoice's
 * emailed payment link, then clear the link so the invoice leaves the retry
 * set. A link is cleared only when the session is expired (or already
 * expired/paid) or can never be expired (not a Checkout URL); any other
 * failure KEEPS the link, and the dunning sweep retries it every pass. The
 * session id is not stored; stripeService derives it from the Checkout URL
 * path. Never throws — a Stripe outage must never fail a delete or a dunning
 * pass (markInvoicePaid still refuses to turn a void invoice into paid).
 */
async function expireAndClearInvoiceLinks(db, rows) {
  const withLinks = (rows || []).filter((row) => row?.id && row?.stripe_payment_link)
  let expired = 0
  let notExpired = 0
  if (!withLinks.length) return { expired, not_expired: notExpired }
  let expireFn = null
  try {
    const mod = await import('../stripeService.js')
    expireFn = mod?.expireCheckoutSessionForUrl
  } catch (err) { log.warn('stripe payment link expiry unavailable', { error: err?.message }) }
  for (const row of withLinks) {
    let r
    try {
      r = typeof expireFn === 'function'
        ? await expireFn(String(row.stripe_payment_link))
        : { ok: false, reason: 'stripe_service_unavailable' }
    } catch (err) {
      r = { ok: false, reason: 'stripe_expire_threw', error: err?.message }
    }
    if (r?.ok || r?.terminal) {
      try {
        await db.prepare(`UPDATE billing_invoices SET stripe_payment_link = NULL WHERE id = ? AND status = 'void'`).run(row.id)
      } catch (err) { log.warn('could not clear expired payment link', { invoice_id: row.id, error: err?.message }) }
      if (r?.ok) expired += 1
      else {
        notExpired += 1
        log.warn('payment link cannot be expired (not a Checkout Session); cleared', { invoice_id: row.id, reason: r?.reason || null })
      }
    } else {
      notExpired += 1
      log.warn('stripe payment link NOT expired for voided invoice; kept for retry', { invoice_id: row.id, reason: r?.reason || 'unknown', session_id: r?.session_id || null })
    }
  }
  return { expired, not_expired: notExpired }
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
export function buildInvoiceEmail({ orgName, amountCents, periodStart, periodEnd, cadence, dueDate, paymentLink, secondNotice = false, proBono = false, grossAmountCents = null, proBonoCreditCents = null }) {
  const amt = money(amountCents)
  const periodLine = periodStart && periodEnd ? `${periodStart} – ${periodEnd}` : 'the current period'
  const greeting = orgName ? `Hi ${orgName},` : 'Hello,'
  if (proBono) return buildProBonoStatementEmail({ greeting, periodLine, cadence, grossAmountCents, proBonoCreditCents })
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
  // CodeQL js/incomplete-html-attribute-sanitization (#384): escHtml feeds
  // href="${esc(paymentLink)}" below and must escape `"` too — an unescaped
  // double quote in paymentLink could break out of the attribute.
  const esc = escHtml
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

/** HTML-attribute-safe escape (shared by both email builders). */
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Pro bono statement: shows the value of the work, the pro bono credit that
 * covers it, and a $0 balance. No due date, no payment link, no "pay" button —
 * this is a record for the client's files, not a request for money.
 */
function buildProBonoStatementEmail({ greeting, periodLine, cadence, grossAmountCents, proBonoCreditCents }) {
  const gross = money(grossAmountCents)
  const credit = money(proBonoCreditCents ?? grossAmountCents)
  const zero = money(0)
  const lead = `This account is served pro bono, so nothing is owed. Here is your ${cadence} statement for ${periodLine} — it records the value of the work for your files.`
  const subject = `Your GrantFlow statement — ${periodLine} (pro bono, ${zero} due)`
  const text = [
    greeting, '', lead, '',
    `Value of services: ${gross}`,
    `Pro bono credit: -${credit}`,
    `Balance due: ${zero}`,
    `Billing period: ${periodLine}`, '',
    `No action is needed. We're honored to do this work alongside you — reply any time if anything looks off.`, '',
    'With appreciation,', 'The GrantFlow team',
  ].join('\n')
  const html = `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;color:#0f172a;line-height:1.5">
    <p>${escHtml(greeting)}</p>
    <p>${escHtml(lead)}</p>
    <table style="border-collapse:collapse;margin:12px 0"><tbody>
      <tr><td style="padding:4px 12px 4px 0;color:#475569">Value of services</td><td style="padding:4px 0">${gross}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#475569">Pro bono credit</td><td style="padding:4px 0;color:#059669">-${credit}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#475569">Balance due</td><td style="padding:4px 0;font-weight:700">${zero}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#475569">Billing period</td><td style="padding:4px 0">${escHtml(periodLine)}</td></tr>
    </tbody></table>
    <p style="color:#475569;font-size:13px">No action is needed. We're honored to do this work alongside you — reply any time if anything looks off.</p>
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
  const lifecycle = await profileBillingLifecycle(db, account.profile_id)
  if (lifecycle === 'deleted') {
    log.info('invoice skipped — profile deleted', { profile_id: account.profile_id })
    return null
  }
  if (lifecycle === 'unknown') {
    log.warn('invoice skipped — profile lifecycle unreadable', { profile_id: account.profile_id })
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
  const proBono = Boolean(eff.is_pro_bono)
  // Pro bono: the statement carries the value of the work (what the account
  // WOULD owe) with a matching credit; a paying account carries the net due.
  const gross = proBono ? eff.pro_bono_credit_cents : eff.net_monthly_cents
  if (!gross) return null // nothing to bill, nothing to record
  const due = proBono ? 0 : gross

  const id = crypto.randomUUID()
  const recipient = await resolveRecipientEmail(db, account.profile_id)
  const paymentLink = proBono ? null : await maybeStripePaymentLink(db, { profileId: account.profile_id, amountCents: due, invoiceId: id })
  const dueAt = proBono ? null : new Date(now.getTime() + SUSPEND_DAYS() * 86400000).toISOString()
  const status = proBono ? PRO_BONO_INVOICE_STATUS : 'sent'
  const paidAt = proBono ? now.toISOString() : null

  await db.prepare(
    `INSERT INTO billing_invoices (id, profile_id, account_id, cadence, period_key, period_start, period_end,
        amount_cents, currency, status, recipient_email, stripe_payment_link, issued_at, due_at,
        gross_amount_cents, pro_bono_credit_cents, is_pro_bono, settled_reason, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, account.profile_id, account.id, cadence, moment.period_key, moment.period_start, moment.period_end,
    due, status, recipient, paymentLink, now.toISOString(), dueAt,
    gross, proBono ? gross : 0, dbBool(db, proBono), proBono ? 'pro_bono' : null, paidAt)

  const orgName = await resolveOrgName(db, account.profile_id)

  // Re-check immediately before delivery, after every other lookup: a delete
  // that landed after the first check — even after its void sweep finished —
  // must not leave a live invoice or send an email. An unreadable lifecycle
  // sends nothing; the invoice stays for the next cycle's dunning pass.
  const lifecycleAtSend = await profileBillingLifecycle(db, account.profile_id)
  if (lifecycleAtSend === 'deleted') {
    await db.prepare(`UPDATE billing_invoices SET status = 'void', settled_reason = 'profile_deleted' WHERE id = ?`).run(id)
    await expireAndClearInvoiceLinks(db, [{ id, stripe_payment_link: paymentLink }])
    log.info('invoice voided — profile deleted during generation', { profile_id: account.profile_id, invoice_id: id })
    return null
  }
  const emailDeferred = lifecycleAtSend === 'unknown'
  if (emailDeferred) {
    log.warn('invoice email NOT sent — profile lifecycle unreadable at delivery; left for the next cycle', { profile_id: account.profile_id, invoice_id: id })
  }
  if (!emailDeferred && recipient && !isNonRoutableEmail(recipient)) {
    const mail = buildInvoiceEmail({
      orgName, amountCents: due, periodStart: moment.period_start, periodEnd: moment.period_end, cadence,
      dueDate: dueAt ? dueAt.slice(0, 10) : null, paymentLink,
      proBono, grossAmountCents: gross, proBonoCreditCents: proBono ? gross : 0,
    })
    await sendEmail({ to: recipient, cc: ownerCc(), subject: mail.subject, html: mail.html, text: mail.text })
  }
  log.info(proBono ? 'pro bono statement generated' : 'invoice generated', { profile_id: account.profile_id, period: moment.period_key, amount_due: due, gross, emailed: Boolean(recipient) && !emailDeferred })
  return { id, profile_id: account.profile_id, period_key: moment.period_key, amount_cents: due, gross_amount_cents: gross, is_pro_bono: proBono, email_deferred: emailDeferred }
}

/**
 * Did a guarded UPDATE change a row? Real adapters report a row count (SQLite
 * `changes`, Postgres rowCount as `changes`); 0 means the guard refused the
 * transition. An adapter that reports no count is treated as applied.
 */
function writeApplied(result) {
  if (!result || typeof result.changes !== 'number') return true
  return result.changes > 0
}

/** Boolean bind value for the active dialect (better-sqlite3 rejects JS booleans). */
function dbBool(db, value) {
  const b = Boolean(value)
  return db?.dialect === 'postgres' ? b : (b ? 1 : 0)
}

/** SQL literal for "is_pro_bono is true" in the active dialect. */
function proBonoTrueLiteral(db) {
  return db?.dialect === 'postgres' ? 'TRUE' : '1'
}

/**
 * Settle every invoice on a profile that still carries a balance as pro bono:
 * status → 'pro_bono', the old balance becomes gross + credit, amount due → $0,
 * marked paid now. If any of them had suspended the profile, lift it (with the
 * normal "your account is active again" notice). Idempotent.
 */
export async function settleInvoicesAsProBono(db, { profileId, now = new Date(), settledBy = 'pro_bono' } = {}) {
  if (!profileId) return { ok: false, error: 'profile_id_required', settled: 0, reactivated: false }
  await ensureInvoiceSchema(db)
  const pid = String(profileId)
  // Shared guard for every caller (dunning, POST /admin/pro-bono/reconcile, the
  // account-update flag flip): a deleted profile's invoices are voided as
  // profile_deleted, never settled as pro bono; an unreadable lifecycle does
  // nothing.
  const lifecycle = await profileBillingLifecycle(db, pid)
  if (lifecycle === 'deleted') {
    const v = await voidOpenInvoicesForDeletedProfile(db, { profileId: pid })
    log.info('pro bono settlement skipped — profile deleted; open invoices voided', { profile_id: pid, voided: v.voided, by: settledBy })
    return { ok: true, profile_id: pid, settled: 0, reactivated: false, skipped: 'profile_deleted', voided: v.voided }
  }
  if (lifecycle === 'unknown') {
    log.warn('pro bono settlement skipped — profile lifecycle unreadable', { profile_id: pid, by: settledBy })
    return { ok: false, profile_id: pid, settled: 0, reactivated: false, error: 'lifecycle_unreadable' }
  }
  const placeholders = OPEN_INVOICE_STATUSES.map(() => '?').join(',')
  const open = await db.prepare(
    `SELECT id, status, amount_cents, gross_amount_cents FROM billing_invoices WHERE profile_id = ? AND status IN (${placeholders})`,
  ).all(pid, ...OPEN_INVOICE_STATUSES)
  if (!open?.length) return { ok: true, profile_id: pid, settled: 0, reactivated: false }

  const nowIso = now.toISOString()
  for (const inv of open) {
    const gross = Number.isFinite(Number(inv.gross_amount_cents)) && inv.gross_amount_cents !== null
      ? Number(inv.gross_amount_cents)
      : Number(inv.amount_cents) || 0
    await db.prepare(
      `UPDATE billing_invoices
          SET status = ?, amount_cents = 0, gross_amount_cents = ?, pro_bono_credit_cents = ?, is_pro_bono = ?,
              settled_reason = ?, paid_at = COALESCE(paid_at, ?), stripe_payment_link = NULL
        WHERE id = ?`,
    ).run(PRO_BONO_INVOICE_STATUS, gross, gross, dbBool(db, true), 'pro_bono', nowIso, inv.id)
  }
  const hadSuspension = open.some((inv) => inv.status === 'suspended')
  let reactivated = false
  if (hadSuspension) {
    let prof = null
    try { prof = await db.prepare('SELECT status FROM profiles WHERE id = ? LIMIT 1').get(pid) } catch { prof = null }
    if (String(prof?.status || '') === 'suspended') {
      const r = await reactivateProfile(db, { profileId: pid, reactivatedBy: settledBy })
      reactivated = Boolean(r?.ok)
    }
  }
  log.info('invoices settled as pro bono', { profile_id: pid, settled: open.length, reactivated, by: settledBy })
  return { ok: true, profile_id: pid, settled: open.length, reactivated }
}

/**
 * Every pro bono account with a balance still showing gets settled. Runs at the
 * top of each dunning pass (so the prod backlog heals on the next cycle) and is
 * exposed to the admin to run on demand.
 */
export async function reconcileProBonoAccounts(db, { now = new Date() } = {}) {
  await ensureInvoiceSchema(db)
  const placeholders = OPEN_INVOICE_STATUSES.map(() => '?').join(',')
  const rows = await db.prepare(
    `SELECT DISTINCT ba.profile_id FROM billing_accounts ba
       JOIN billing_invoices bi ON bi.profile_id = ba.profile_id
      WHERE ba.is_pro_bono = ${proBonoTrueLiteral(db)} AND bi.status IN (${placeholders})`,
  ).all(...OPEN_INVOICE_STATUSES)
  let settled = 0
  let reactivated = 0
  for (const row of rows || []) {
    const r = await settleInvoicesAsProBono(db, { profileId: row.profile_id, now, settledBy: 'pro_bono_reconcile' })
      .catch((err) => { log.warn('pro bono reconcile failed', { profile_id: row.profile_id, error: err?.message }); return null })
    if (!r) continue
    settled += r.settled
    if (r.reactivated) reactivated += 1
  }
  return { accounts: rows?.length || 0, settled, reactivated }
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
  // Deleted profiles first, across every open status, and before pro bono
  // reconciliation could re-settle their invoices.
  const deletedSweep = await voidOpenInvoicesOfDeletedProfiles(db)
    .catch((err) => { log.warn('deleted-profile invoice sweep failed', { error: err?.message }); return { voided: 0 } })
  // Re-read the pro bono flag BEFORE chasing anything: an invoice issued before
  // the grant is settled ($0 due) here, so it can never remind or suspend.
  const reconciled = await reconcileProBonoAccounts(db, { now })
    .catch((err) => { log.warn('pro bono reconcile failed', { error: err?.message }); return { settled: 0 } })
  const open = await db.prepare(`SELECT * FROM billing_invoices WHERE status IN ('sent','second_notice')`).all()
  let reminded = 0
  let suspended = 0
  let voided = 0
  let voidedDeleted = 0
  let skippedUnreadable = 0
  for (const inv of open || []) {
    // A deleted profile is never reminded or suspended: suspending it would
    // overwrite status 'deleted' and email a "paused" notice to someone who
    // deleted their account. Void it (same rule the delete route applies).
    // An unreadable lifecycle fails closed: no reminder, no suspend, no void.
    const lifecycle = await profileBillingLifecycle(db, inv.profile_id)
    if (lifecycle === 'unknown') {
      log.warn('dunning skipped invoice — profile lifecycle unreadable', { invoice_id: inv.id, profile_id: inv.profile_id })
      skippedUnreadable += 1
      continue
    }
    if (lifecycle === 'deleted') {
      await db.prepare(`UPDATE billing_invoices SET status = 'void', settled_reason = 'profile_deleted' WHERE id = ?`).run(inv.id)
      await expireAndClearInvoiceLinks(db, [inv])
      log.info('invoice voided — profile deleted', { invoice_id: inv.id, profile_id: inv.profile_id })
      voidedDeleted += 1
      continue
    }
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
      // Atomic transition: only an invoice still in the status we read, on a
      // profile that is still not deleted, is suspended — a void or delete that
      // landed after the read wins, and nothing is suspended or sent.
      const suspendWrite = await db.prepare(
        `UPDATE billing_invoices SET status = 'suspended', suspended_at = ?
          WHERE id = ? AND status = ?
            AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = billing_invoices.profile_id AND COALESCE(p.status, '') <> 'deleted')`,
      ).run(now.toISOString(), inv.id, inv.status)
      if (!writeApplied(suspendWrite)) {
        log.info('dunning suspend skipped — invoice or profile changed since read', { invoice_id: inv.id, profile_id: inv.profile_id })
        continue
      }
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
      const remindWrite = await db.prepare(
        `UPDATE billing_invoices SET status = 'second_notice', reminders_sent = reminders_sent + 1, last_reminder_at = ?
          WHERE id = ? AND status = 'sent'
            AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = billing_invoices.profile_id AND COALESCE(p.status, '') <> 'deleted')`,
      ).run(now.toISOString(), inv.id)
      if (!writeApplied(remindWrite)) {
        log.info('dunning reminder skipped — invoice or profile changed since read', { invoice_id: inv.id, profile_id: inv.profile_id })
        continue
      }
      const orgName = await resolveOrgName(db, inv.profile_id)
      if (inv.recipient_email) {
        const mail = buildInvoiceEmail({ orgName, amountCents: inv.amount_cents, periodStart: inv.period_start, periodEnd: inv.period_end, cadence: inv.cadence, dueDate: inv.due_at ? String(inv.due_at).slice(0, 10) : null, paymentLink: inv.stripe_payment_link, secondNotice: true })
        await sendEmail({ to: inv.recipient_email, cc: ownerCc(), subject: mail.subject, html: mail.html, text: mail.text })
      }
      reminded += 1
    }
  }
  return {
    reminded,
    suspended,
    voided,
    voided_deleted_profile: (deletedSweep.voided || 0) + voidedDeleted,
    payment_links_expired_on_retry: deletedSweep.links_expired_on_retry || 0,
    skipped_unreadable_profile: skippedUnreadable,
    pro_bono_settled: reconciled.settled || 0,
  }
}

/** Mark an invoice paid (Stripe webhook or admin) + lift any suspension. */
export async function markInvoicePaid(db, { invoiceId = null, profileId = null, stripeInvoiceId = null, source = 'manual' } = {}) {
  await ensureInvoiceSchema(db)
  let inv = null
  if (invoiceId) inv = await db.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(invoiceId)
  else if (stripeInvoiceId) inv = await db.prepare('SELECT * FROM billing_invoices WHERE stripe_invoice_id = ?').get(stripeInvoiceId)
  else if (profileId) inv = await db.prepare(`SELECT * FROM billing_invoices WHERE profile_id = ? AND status IN ('sent','second_notice','suspended') ORDER BY issued_at DESC LIMIT 1`).get(profileId)
  if (!inv) return { ok: false, error: 'invoice_not_found' }

  // A VOID invoice is never turned into 'paid' — a late payment on a deleted
  // profile's emailed link must not rewrite history or touch the profile.
  // Record that money arrived (paid_at), keep status 'void', and alert the
  // owner so the payment can be refunded.
  if (inv.status === 'void') {
    try {
      await db.prepare(`UPDATE billing_invoices SET paid_at = COALESCE(paid_at, ?) WHERE id = ?`).run(new Date().toISOString(), inv.id)
    } catch (err) { log.warn('could not record payment on voided invoice', { invoice_id: inv.id, error: err?.message }) }
    log.warn('payment received on a VOIDED invoice — refund needed', { invoice_id: inv.id, profile_id: inv.profile_id, settled_reason: inv.settled_reason || null, source })
    const admin = ownerCc()
    if (admin) {
      try {
        await sendEmail({
          to: admin,
          subject: `[GrantFlow admin] Refund needed: payment received on voided invoice ${inv.id}`,
          text: [
            `A payment arrived (${source}) for invoice ${inv.id} on profile ${inv.profile_id}, but that invoice is VOID (reason: ${inv.settled_reason || 'unspecified'}).`,
            `Invoice amount: ${money(inv.amount_cents)}.`,
            'The invoice was NOT marked paid and the profile status was NOT changed.',
            `Refund the payment in the Stripe dashboard (Checkout Session metadata billing_invoice_id = ${inv.id}).`,
          ].join('\n'),
        })
      } catch (err) { log.warn('refund-needed alert email failed', { invoice_id: inv.id, error: err?.message }) }
    }
    return {
      ok: true,
      invoice_id: inv.id,
      profile_id: inv.profile_id,
      reactivated: false,
      status: 'void',
      payment_on_void: true,
      refund_needed: true,
      settled_reason: inv.settled_reason || null,
    }
  }

  await db.prepare(`UPDATE billing_invoices SET status = 'paid', paid_at = ? WHERE id = ?`).run(new Date().toISOString(), inv.id)
  // If the profile was suspended for this invoice, reactivate — never a deleted
  // profile (a late payment must not resurrect it).
  let reactivated = false
  if (inv.status === 'suspended') {
    try {
      const res = await db.prepare(`UPDATE profiles SET status = 'active' WHERE id = ? AND COALESCE(status, '') <> 'deleted'`).run(inv.profile_id)
      reactivated = res && typeof res.changes === 'number' ? res.changes > 0 : true
    } catch { /* status col */ }
  }
  log.info('invoice paid', { invoice_id: inv.id, profile_id: inv.profile_id, source, reactivated })
  return { ok: true, invoice_id: inv.id, profile_id: inv.profile_id, reactivated }
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
    // Deleted profiles are never selected (soft delete keeps the profiles row,
    // so the ON DELETE CASCADE never fires). generateInvoiceForAccount re-checks.
    const accounts = await db.prepare(
      `SELECT ba.* FROM billing_accounts ba
         JOIN profiles p ON p.id = ba.profile_id
        WHERE COALESCE(p.status, '') <> 'deleted'`,
    ).all()
    for (const acc of accounts || []) {
      const r = await generateInvoiceForAccount(db, acc, { now }).catch((e) => { log.warn('generate failed', { profile_id: acc.profile_id, error: e?.message }); return null })
      if (r) generated += 1
    }
  } catch (err) { log.warn('runBillingCycle accounts query failed', { error: err?.message }) }
  const dun = await processDunning(db, { now }).catch(() => ({ reminded: 0, suspended: 0, voided: 0, voided_deleted_profile: 0, skipped_unreadable_profile: 0, pro_bono_settled: 0 }))
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
