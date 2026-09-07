/**
 * Pro bono billing — the admin flag must mean "$0 due", everywhere, always.
 *
 * Prod evidence (2026-09-07): 16/27 billing accounts are pro bono, yet 10
 * invoices on those profiles sat in status 'suspended' with a balance, and one
 * profile flagged pro bono on 08-31 was still suspended by dunning on 09-04 for
 * an invoice issued 08-28. Two defects + one gap:
 *   1. processDunning never re-read the account, so a pre-flag invoice kept
 *      being chased and suspended the account.
 *   2. Flipping is_pro_bono on left every open invoice owing money.
 *   3. Pro bono accounts got NO statement at all, instead of one that shows the
 *      value of the work with a matching pro bono credit and $0 due.
 */
import request from 'supertest'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

vi.mock('../services/email.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendEmail: vi.fn(async () => ({ ok: true, id: 'mock' })) }
})

import { getAppAndDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'
import { sendEmail } from '../services/email.js'
import {
  ensureInvoiceSchema,
  generateInvoiceForAccount,
  processDunning,
  settleInvoicesAsProBono,
  reconcileProBonoAccounts,
  buildInvoiceEmail,
  PRO_BONO_INVOICE_STATUS,
} from '../services/billing/invoiceService.js'
import { ensureBillingAccount, selectAccount, computeEffectiveBilling } from '../services/billingAccounts.js'

// Friday 2026-09-04 14:00 ET — past the 09:00 ET weekly billing moment.
const NOW = new Date('2026-09-04T18:00:00Z')
const ANCHOR = '2026-06-01T13:00:00Z'

describe('pro bono billing', () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
    await ensureInvoiceSchema(db)
  }, 60_000)

  beforeEach(() => {
    vi.mocked(sendEmail).mockClear()
    for (const sql of ['DELETE FROM billing_invoices', 'DELETE FROM billing_account_events', 'DELETE FROM billing_accounts', "DELETE FROM profiles WHERE id LIKE 'pb-%'"]) {
      try { db.prepare(sql).run() } catch { /* table variance */ }
    }
  })

  async function seedProfile(id, { proBono, monthlyCents = 14900, status = 'active', discountPercent = 0 } = {}) {
    db.prepare("INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, 'organization', ?)").run(id, `Org ${id}`, status)
    // The invoice recipient resolves from basic_information.email when the
    // profile has no owning user (the case for admin-created org profiles).
    db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)")
      .run(id, JSON.stringify({ email: `${id}@example.com` }))
    await ensureBillingAccount(db, id)
    db.prepare(`UPDATE billing_accounts SET is_pro_bono = ?, custom_monthly_cents = ?, discount_percent = ?, billing_cadence = 'weekly', billing_anchor_at = ? WHERE profile_id = ?`)
      .run(proBono ? 1 : 0, monthlyCents, discountPercent, ANCHOR, id)
    return selectAccount(db, id)
  }

  function seedInvoice({ id, profileId, status, amount = 14900, issuedAt }) {
    db.prepare(`INSERT INTO billing_invoices (id, profile_id, cadence, period_key, amount_cents, status, recipient_email, issued_at)
                VALUES (?, ?, 'weekly', ?, ?, ?, 'someone@example.com', ?)`)
      .run(id, profileId, `weekly:${id}`, amount, status, issuedAt)
  }

  const invoice = (id) => db.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(id)
  const profileStatus = (id) => db.prepare('SELECT status FROM profiles WHERE id = ?').get(id)?.status

  describe('computeEffectiveBilling exposes the pro bono credit', () => {
    it('a pro bono account owes $0 but reports what it WOULD owe as the credit', async () => {
      const acct = await seedProfile('pb-eff', { proBono: true, monthlyCents: 20000, discountPercent: 10 })
      const eff = await computeEffectiveBilling(db, 'pb-eff', acct)
      expect(eff.is_pro_bono).toBe(true)
      expect(eff.net_monthly_cents).toBe(0)
      expect(eff.would_owe_monthly_cents).toBe(18000)
      expect(eff.pro_bono_credit_cents).toBe(18000)
    })

    it('a paying account has no credit', async () => {
      const acct = await seedProfile('pb-eff2', { proBono: false, monthlyCents: 20000 })
      const eff = await computeEffectiveBilling(db, 'pb-eff2', acct)
      expect(eff.net_monthly_cents).toBe(20000)
      expect(eff.pro_bono_credit_cents).toBe(0)
    })
  })

  describe('generateInvoiceForAccount', () => {
    it('issues a $0 pro bono statement that records the value of the work and never asks for payment', async () => {
      const acct = await seedProfile('pb-gen', { proBono: true, monthlyCents: 14900 })
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('pb-gen')
      const created = await generateInvoiceForAccount(db, row, { now: NOW })
      expect(created).toBeTruthy()
      expect(created.is_pro_bono).toBe(true)
      expect(created.amount_cents).toBe(0)
      expect(created.gross_amount_cents).toBe(14900)
      expect(acct.is_pro_bono).toBeTruthy()

      const inv = invoice(created.id)
      expect(inv.status).toBe(PRO_BONO_INVOICE_STATUS)
      expect(inv.amount_cents).toBe(0)
      expect(inv.gross_amount_cents).toBe(14900)
      expect(inv.pro_bono_credit_cents).toBe(14900)
      expect(Boolean(inv.is_pro_bono)).toBe(true)
      expect(inv.stripe_payment_link).toBeNull()
      expect(inv.paid_at).toBeTruthy()
      expect(inv.due_at).toBeNull()

      // The email shows value, the pro bono credit, and $0 due — no pay button.
      expect(sendEmail).toHaveBeenCalledTimes(1)
      const mail = vi.mocked(sendEmail).mock.calls[0][0]
      expect(mail.subject).toMatch(/pro bono/i)
      expect(mail.subject).toMatch(/\$0\.00/)
      expect(mail.text).toMatch(/Value of services:\s+\$149\.00/)
      expect(mail.text).toMatch(/Pro bono credit:\s+-\$149\.00/)
      expect(mail.text).toMatch(/Balance due:\s+\$0\.00/)
      expect(mail.text).not.toMatch(/payment link/i)
      expect(mail.html).not.toMatch(/Pay securely/)
    })

    it('a pro bono statement is idempotent per period and is never chased by dunning', async () => {
      await seedProfile('pb-gen2', { proBono: true, monthlyCents: 14900 })
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('pb-gen2')
      const first = await generateInvoiceForAccount(db, row, { now: NOW })
      const second = await generateInvoiceForAccount(db, row, { now: NOW })
      expect(first).toBeTruthy()
      expect(second).toBeNull()
      process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE = 'true'
      const dun = await processDunning(db, { now: new Date(NOW.getTime() + 30 * 86400000) })
      delete process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE
      expect(dun.suspended).toBe(0)
      expect(dun.reminded).toBe(0)
      expect(profileStatus('pb-gen2')).toBe('active')
    })

    it('a pro bono account whose value is $0 gets no statement (nothing to record)', async () => {
      await seedProfile('pb-gen3', { proBono: true, monthlyCents: 0 })
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('pb-gen3')
      expect(await generateInvoiceForAccount(db, row, { now: NOW })).toBeNull()
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('a paying account is still invoiced normally', async () => {
      await seedProfile('pb-gen4', { proBono: false, monthlyCents: 14900 })
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('pb-gen4')
      const created = await generateInvoiceForAccount(db, row, { now: NOW })
      const inv = invoice(created.id)
      expect(inv.status).toBe('sent')
      expect(inv.amount_cents).toBe(14900)
      expect(inv.gross_amount_cents).toBe(14900)
      expect(inv.pro_bono_credit_cents).toBe(0)
      expect(vi.mocked(sendEmail).mock.calls[0][0].text).toMatch(/Amount due:\s+\$149\.00/)
    })
  })

  describe('settleInvoicesAsProBono', () => {
    it('zeroes every open or suspended invoice, keeps the value as a credit, and lifts a billing suspension', async () => {
      await seedProfile('pb-settle', { proBono: true, status: 'suspended' })
      seedInvoice({ id: 'pb-s1', profileId: 'pb-settle', status: 'sent', issuedAt: '2026-08-28T13:00:00Z' })
      seedInvoice({ id: 'pb-s2', profileId: 'pb-settle', status: 'second_notice', issuedAt: '2026-08-21T13:00:00Z' })
      seedInvoice({ id: 'pb-s3', profileId: 'pb-settle', status: 'suspended', amount: 13410, issuedAt: '2026-08-14T13:00:00Z' })
      seedInvoice({ id: 'pb-s4', profileId: 'pb-settle', status: 'paid', issuedAt: '2026-08-07T13:00:00Z' })
      seedInvoice({ id: 'pb-s5', profileId: 'pb-settle', status: 'void', issuedAt: '2026-07-31T13:00:00Z' })

      const res = await settleInvoicesAsProBono(db, { profileId: 'pb-settle', now: NOW })
      expect(res.settled).toBe(3)
      expect(res.reactivated).toBe(true)

      for (const id of ['pb-s1', 'pb-s2']) {
        const inv = invoice(id)
        expect(inv.status).toBe(PRO_BONO_INVOICE_STATUS)
        expect(inv.amount_cents).toBe(0)
        expect(inv.gross_amount_cents).toBe(14900)
        expect(inv.pro_bono_credit_cents).toBe(14900)
        expect(inv.paid_at).toBeTruthy()
      }
      const s3 = invoice('pb-s3')
      expect(s3.status).toBe(PRO_BONO_INVOICE_STATUS)
      expect(s3.gross_amount_cents).toBe(13410)
      expect(s3.amount_cents).toBe(0)
      expect(invoice('pb-s4').status).toBe('paid')
      expect(invoice('pb-s4').amount_cents).toBe(14900)
      expect(invoice('pb-s5').status).toBe('void')
      expect(profileStatus('pb-settle')).toBe('active')
    })

    it('is a no-op for an account with nothing open', async () => {
      await seedProfile('pb-settle2', { proBono: true })
      const res = await settleInvoicesAsProBono(db, { profileId: 'pb-settle2', now: NOW })
      expect(res.settled).toBe(0)
      expect(res.reactivated).toBe(false)
    })
  })

  describe('processDunning re-reads the account before chasing', () => {
    it('settles a pre-flag invoice on a pro bono account instead of suspending it; still suspends a paying account', async () => {
      await seedProfile('pb-dun-free', { proBono: true })
      await seedProfile('pb-dun-pay', { proBono: false })
      const tenDaysAgo = new Date(NOW.getTime() - 10 * 86400000).toISOString()
      seedInvoice({ id: 'pb-d1', profileId: 'pb-dun-free', status: 'sent', issuedAt: tenDaysAgo })
      seedInvoice({ id: 'pb-d2', profileId: 'pb-dun-pay', status: 'sent', issuedAt: tenDaysAgo })

      process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE = 'true'
      const res = await processDunning(db, { now: NOW })
      delete process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE

      expect(res.pro_bono_settled).toBe(1)
      expect(res.suspended).toBe(1)
      expect(invoice('pb-d1').status).toBe(PRO_BONO_INVOICE_STATUS)
      expect(invoice('pb-d1').amount_cents).toBe(0)
      expect(profileStatus('pb-dun-free')).toBe('active')
      expect(invoice('pb-d2').status).toBe('suspended')
      expect(profileStatus('pb-dun-pay')).toBe('suspended')
    })
  })

  describe('reconcileProBonoAccounts', () => {
    it('heals every pro bono account that still carries a balance (the prod backlog)', async () => {
      await seedProfile('pb-rec-a', { proBono: true, status: 'suspended' })
      await seedProfile('pb-rec-b', { proBono: true })
      await seedProfile('pb-rec-c', { proBono: false, status: 'suspended' })
      seedInvoice({ id: 'pb-r1', profileId: 'pb-rec-a', status: 'suspended', issuedAt: '2026-08-28T13:00:00Z' })
      seedInvoice({ id: 'pb-r2', profileId: 'pb-rec-b', status: 'sent', issuedAt: '2026-08-28T13:00:00Z' })
      seedInvoice({ id: 'pb-r3', profileId: 'pb-rec-c', status: 'suspended', issuedAt: '2026-08-28T13:00:00Z' })

      const res = await reconcileProBonoAccounts(db, { now: NOW })
      expect(res.accounts).toBe(2)
      expect(res.settled).toBe(2)
      expect(res.reactivated).toBe(1)
      expect(invoice('pb-r1').status).toBe(PRO_BONO_INVOICE_STATUS)
      expect(invoice('pb-r2').status).toBe(PRO_BONO_INVOICE_STATUS)
      expect(invoice('pb-r3').status).toBe('suspended') // paying account untouched
      expect(profileStatus('pb-rec-a')).toBe('active')
      expect(profileStatus('pb-rec-c')).toBe('suspended')
    })
  })

  describe('admin flips the flag on', () => {
    it('PUT /api/billing/accounts/:id with is_pro_bono=true settles open invoices and lifts the suspension', async () => {
      await seedProfile('pb-route', { proBono: false, status: 'suspended' })
      seedInvoice({ id: 'pb-rt1', profileId: 'pb-route', status: 'suspended', issuedAt: '2026-08-28T13:00:00Z' })
      const tiers = await request(app).get('/api/billing/tiers').set(TEST_ADMIN_AUTH_HEADER)
      const tierId = (tiers.body.tiers || tiers.body || [])[0]?.id
      expect(tierId).toBeTruthy()

      const res = await request(app)
        .put('/api/billing/accounts/pb-route')
        .set(TEST_ADMIN_AUTH_HEADER)
        .send({ tier_id: tierId, is_pro_bono: true, pro_bono_reason: 'hardship' })
      expect(res.status).toBe(200)
      expect(res.body.account.is_pro_bono).toBe(true)
      expect(res.body.pro_bono_settlement).toEqual(expect.objectContaining({ settled: 1, reactivated: true }))
      expect(invoice('pb-rt1').status).toBe(PRO_BONO_INVOICE_STATUS)
      expect(invoice('pb-rt1').amount_cents).toBe(0)
      expect(profileStatus('pb-route')).toBe('active')

      const list = await request(app).get('/api/billing/me/pb-route/invoices').set(TEST_ADMIN_AUTH_HEADER)
      expect(list.status).toBe(200)
      expect(list.body.invoices[0]).toEqual(expect.objectContaining({
        status: PRO_BONO_INVOICE_STATUS, amount_cents: 0, gross_amount_cents: 14900, pro_bono_credit_cents: 14900,
      }))
    })
  })

  describe('buildInvoiceEmail (pro bono statement)', () => {
    it('shows value, credit, and $0 due without a pay button', () => {
      const m = buildInvoiceEmail({
        orgName: 'Focus Forward Ministry', amountCents: 0, grossAmountCents: 13410, proBonoCreditCents: 13410,
        proBono: true, periodStart: '2026-08-22', periodEnd: '2026-08-28', cadence: 'weekly',
      })
      expect(m.subject).toMatch(/pro bono/i)
      expect(m.subject).toMatch(/\$0\.00/)
      expect(m.text).toMatch(/Value of services:\s+\$134\.10/)
      expect(m.text).toMatch(/Pro bono credit:\s+-\$134\.10/)
      expect(m.text).toMatch(/Balance due:\s+\$0\.00/)
      expect(m.text).not.toMatch(/Due by/)
      expect(m.html).toContain('$134.10')
      expect(m.html).not.toContain('Pay securely')
    })
  })
})
