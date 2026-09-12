/**
 * A deleted profile is never billed, chased, suspended, or resurrected.
 *
 * Defect (origin/main 54232e13, 2026-09-11): DELETE /api/profiles/:id soft
 * deletes by setting profiles.status = 'deleted', so the row stays and
 * billing_accounts' ON DELETE CASCADE never fires. Then:
 *   1. runBillingCycle selected EVERY billing account and generateInvoiceForAccount
 *      had no profile-status check, so the deleted profile got a new invoice
 *      (saved + emailed, with a payment link when Stripe is configured).
 *   2. processDunning reminded it and, a cycle later, suspendProfile ran
 *      UPDATE profiles SET status = 'suspended', overwriting 'deleted' (the
 *      deleted-profile 404 stopped applying) and emailed a "paused" notice.
 *   3. markInvoicePaid set status 'active', resurrecting the profile.
 *   4. billing_invoices has no FK, so a HARD delete left orphaned open invoices
 *      that dunning kept reminding.
 */
import request from 'supertest'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services/email.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendEmail: vi.fn(async () => ({ ok: true, id: 'mock' })) }
})

vi.mock('../services/comms/commsService.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, notifyProfile: vi.fn(async () => ({ ok: true })) }
})

// Never call Stripe from a test; the real id derivation stays unmocked.
vi.mock('../services/stripeService.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, expireCheckoutSessionForUrl: vi.fn(async () => ({ ok: true })) }
})

// Lets the test drive the designated-profile soft-delete path (the one that
// keeps the profiles row) with a synthetic id.
vi.mock('../utils/ensureDesignatedProfiles.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    isDesignatedProfileId: (id) => String(id || '').startsWith('del-designated-') || actual.isDesignatedProfileId(id),
  }
})

import { getAppAndDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'
import { sendEmail } from '../services/email.js'
import { notifyProfile } from '../services/comms/commsService.js'
import {
  ensureInvoiceSchema,
  generateInvoiceForAccount,
  processDunning,
  markInvoicePaid,
  runBillingCycle,
  reconcileProBonoAccounts,
  settleInvoicesAsProBono,
} from '../services/billing/invoiceService.js'
import { mergeProfiles } from '../services/profileDedupeService.js'
import { suspendProfile, reactivateProfile } from '../services/billing/accountStatus.js'
import { ensureBillingAccount } from '../services/billingAccounts.js'
import { expireCheckoutSessionForUrl, checkoutSessionIdFromUrl } from '../services/stripeService.js'

// Friday 2026-09-04 14:00 ET — past the 09:00 ET weekly billing moment.
const NOW = new Date('2026-09-04T18:00:00Z')
const ANCHOR = '2026-06-01T13:00:00Z'
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString()

describe('deleted profiles are never billed', () => {
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
    vi.mocked(notifyProfile).mockClear()
    vi.mocked(expireCheckoutSessionForUrl).mockClear()
    for (const sql of [
      'DELETE FROM billing_invoices',
      'DELETE FROM billing_account_events',
      'DELETE FROM billing_accounts',
      "DELETE FROM profile_sections WHERE profile_id LIKE 'del-%'",
      "DELETE FROM profiles WHERE id LIKE 'del-%'",
      "DELETE FROM organizations WHERE id LIKE 'del-%'",
    ]) {
      try { db.prepare(sql).run() } catch { /* table variance */ }
    }
  })

  afterEach(() => {
    delete process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE
  })

  async function seedProfile(id, { status = 'active', monthlyCents = 14900 } = {}) {
    db.prepare("INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, 'organization', 'active')").run(id, `Org ${id}`)
    db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)")
      .run(id, JSON.stringify({ email: `${id}@example.com` }))
    await ensureBillingAccount(db, id)
    db.prepare(`UPDATE billing_accounts SET is_pro_bono = 0, custom_monthly_cents = ?, billing_cadence = 'weekly', billing_anchor_at = ? WHERE profile_id = ?`)
      .run(monthlyCents, ANCHOR, id)
    // Set the lifecycle status last, exactly as the delete route does to a live profile.
    db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run(status, id)
  }

  function seedInvoice({ id, profileId, status, amount = 14900, issuedAt, link = null }) {
    db.prepare(`INSERT INTO billing_invoices (id, profile_id, cadence, period_key, amount_cents, status, recipient_email, issued_at, stripe_payment_link)
                VALUES (?, ?, 'weekly', ?, ?, ?, ?, ?, ?)`)
      .run(id, profileId, `weekly:${id}`, amount, status, `${profileId}@example.com`, issuedAt, link)
  }

  const invoice = (id) => db.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(id)
  const invoicesFor = (profileId) => db.prepare('SELECT * FROM billing_invoices WHERE profile_id = ?').all(profileId)
  const profileStatus = (id) => db.prepare('SELECT status FROM profiles WHERE id = ?').get(id)?.status
  const emailedTo = () => vi.mocked(sendEmail).mock.calls.map((c) => c[0]?.to)
  const notifiedProfiles = () => vi.mocked(notifyProfile).mock.calls.map((c) => c[1]?.profileId)

  /**
   * A db that runs every statement for real, but whose statements matching
   * `sqlFragment` trigger `after()` once they complete — used to land a delete
   * exactly between a check and a write.
   */
  function dbWithHook(sqlFragment, method, after) {
    const wrapped = Object.create(db)
    wrapped.prepare = (sql) => {
      const stmt = db.prepare(sql)
      if (!String(sql).includes(sqlFragment)) return stmt
      return {
        get: async (...a) => { const r = await stmt.get(...a); if (method === 'get') await after(); return r },
        all: async (...a) => { const r = await stmt.all(...a); if (method === 'all') await after(); return r },
        run: async (...a) => { const r = await stmt.run(...a); if (method === 'run') await after(); return r },
      }
    }
    return wrapped
  }

  /** A db whose profile lifecycle read throws (every other statement is real). */
  function dbWithUnreadableLifecycle() {
    const wrapped = Object.create(db)
    wrapped.prepare = (sql) => {
      if (String(sql).includes('SELECT id, status FROM profiles')) {
        return { get: async () => { throw new Error('lifecycle read failed') }, all: async () => [], run: async () => ({ changes: 0 }) }
      }
      return db.prepare(sql)
    }
    return wrapped
  }

  const markDeleted = (id) => db.prepare("UPDATE profiles SET status = 'deleted' WHERE id = ?").run(id)

  /** A db whose profile lifecycle read succeeds `okReads` times, then throws. */
  function dbWithLifecycleReadFailingAfter(okReads) {
    let reads = 0
    const wrapped = Object.create(db)
    wrapped.prepare = (sql) => {
      const stmt = db.prepare(sql)
      if (!String(sql).includes('SELECT id, status FROM profiles')) return stmt
      return {
        get: async (...a) => {
          reads += 1
          if (reads > okReads) throw new Error('lifecycle read failed')
          return stmt.get(...a)
        },
        all: async (...a) => stmt.all(...a),
        run: async (...a) => stmt.run(...a),
      }
    }
    return wrapped
  }

  describe('invoice run', () => {
    it('runBillingCycle never invoices a deleted profile and still invoices an active one', async () => {
      await seedProfile('del-run-live')
      await seedProfile('del-run-gone', { status: 'deleted' })

      const res = await runBillingCycle(db, { now: NOW, force: true })

      expect(res.ran).toBe(true)
      expect(res.generated).toBe(1)
      expect(invoicesFor('del-run-gone')).toHaveLength(0)
      const live = invoicesFor('del-run-live')
      expect(live).toHaveLength(1)
      expect(live[0].status).toBe('sent')
      expect(live[0].amount_cents).toBe(14900)
      expect(emailedTo()).toContain('del-run-live@example.com')
      expect(emailedTo()).not.toContain('del-run-gone@example.com')
    })

    it('generateInvoiceForAccount refuses a deleted profile even when handed its account row directly', async () => {
      await seedProfile('del-gen-gone', { status: 'deleted' })
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('del-gen-gone')
      expect(row).toBeTruthy()

      expect(await generateInvoiceForAccount(db, row, { now: NOW })).toBeNull()
      expect(invoicesFor('del-gen-gone')).toHaveLength(0)
      expect(sendEmail).not.toHaveBeenCalled()
    })
  })

  describe('dunning', () => {
    it('voids a deleted profile\'s open invoices without emailing, notifying, or suspending it; live profiles are chased exactly as before', async () => {
      await seedProfile('del-dun-gone', { status: 'deleted' })
      await seedProfile('del-dun-pay')
      await seedProfile('del-dun-late')
      seedInvoice({ id: 'del-d-gone-1', profileId: 'del-dun-gone', status: 'sent', issuedAt: daysAgo(10) })
      seedInvoice({ id: 'del-d-gone-2', profileId: 'del-dun-gone', status: 'second_notice', issuedAt: daysAgo(4) })
      seedInvoice({ id: 'del-d-pay', profileId: 'del-dun-pay', status: 'sent', issuedAt: daysAgo(10) })
      seedInvoice({ id: 'del-d-late', profileId: 'del-dun-late', status: 'sent', issuedAt: daysAgo(4) })

      process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE = 'true'
      const res = await processDunning(db, { now: NOW })

      // Deleted profile: voided, never chased, status untouched.
      expect(res.voided_deleted_profile).toBe(2)
      for (const id of ['del-d-gone-1', 'del-d-gone-2']) {
        expect(invoice(id).status).toBe('void')
        expect(invoice(id).settled_reason).toBe('profile_deleted')
      }
      expect(profileStatus('del-dun-gone')).toBe('deleted')
      expect(emailedTo()).not.toContain('del-dun-gone@example.com')
      expect(notifiedProfiles()).not.toContain('del-dun-gone')

      // Regression: a paying profile a full cycle past due is suspended + notified.
      expect(res.suspended).toBe(1)
      expect(invoice('del-d-pay').status).toBe('suspended')
      expect(profileStatus('del-dun-pay')).toBe('suspended')
      const paused = vi.mocked(notifyProfile).mock.calls.find((c) => c[1]?.profileId === 'del-dun-pay')
      expect(paused?.[1]?.subject).toMatch(/paused/i)

      // Regression: a 4-day-old invoice gets the second notice email.
      expect(res.reminded).toBe(1)
      expect(invoice('del-d-late').status).toBe('second_notice')
      expect(emailedTo()).toContain('del-dun-late@example.com')
    })

    it('voids the orphaned open invoices of a hard-deleted profile (no profiles row left)', async () => {
      seedInvoice({ id: 'del-d-orphan', profileId: 'del-hard-gone', status: 'sent', issuedAt: daysAgo(10) })

      process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE = 'true'
      const res = await processDunning(db, { now: NOW })

      expect(res.voided_deleted_profile).toBe(1)
      expect(res.suspended).toBe(0)
      expect(res.reminded).toBe(0)
      expect(invoice('del-d-orphan').status).toBe('void')
      expect(sendEmail).not.toHaveBeenCalled()
      expect(notifyProfile).not.toHaveBeenCalled()
    })
  })

  describe('status writers never overwrite a deleted profile', () => {
    it('suspendProfile refuses a deleted profile and sends nothing', async () => {
      await seedProfile('del-sus-gone', { status: 'deleted' })
      const r = await suspendProfile(db, { profileId: 'del-sus-gone', reason: 'past_due', suspendedBy: 'billing_dunning' })
      expect(r).toEqual(expect.objectContaining({ ok: false, error: 'profile_deleted' }))
      expect(profileStatus('del-sus-gone')).toBe('deleted')
      expect(notifyProfile).not.toHaveBeenCalled()
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('reactivateProfile refuses a deleted profile and sends nothing', async () => {
      await seedProfile('del-react-gone', { status: 'deleted' })
      const r = await reactivateProfile(db, { profileId: 'del-react-gone', reactivatedBy: 'admin' })
      expect(r).toEqual(expect.objectContaining({ ok: false, error: 'profile_deleted' }))
      expect(profileStatus('del-react-gone')).toBe('deleted')
      expect(notifyProfile).not.toHaveBeenCalled()
    })

    it('suspend and reactivate still work for live profiles, including a NULL status', async () => {
      await seedProfile('del-live-1')
      const s = await suspendProfile(db, { profileId: 'del-live-1', reason: 'admin_suspend', suspendedBy: 'admin' })
      expect(s.ok).toBe(true)
      expect(profileStatus('del-live-1')).toBe('suspended')
      expect(notifiedProfiles()).toContain('del-live-1')
      const r = await reactivateProfile(db, { profileId: 'del-live-1', reactivatedBy: 'admin' })
      expect(r.ok).toBe(true)
      expect(profileStatus('del-live-1')).toBe('active')

      await seedProfile('del-live-null', { status: null })
      expect(profileStatus('del-live-null')).toBeNull()
      const n = await suspendProfile(db, { profileId: 'del-live-null', notify: false })
      expect(n.ok).toBe(true)
      expect(profileStatus('del-live-null')).toBe('suspended')
    })

    it('markInvoicePaid records the payment but never resurrects a deleted profile; a suspended live profile is lifted', async () => {
      await seedProfile('del-paid-gone', { status: 'deleted' })
      seedInvoice({ id: 'del-p-gone', profileId: 'del-paid-gone', status: 'suspended', issuedAt: daysAgo(10) })
      const gone = await markInvoicePaid(db, { invoiceId: 'del-p-gone', source: 'stripe' })
      expect(gone.ok).toBe(true)
      expect(gone.reactivated).toBe(false)
      expect(invoice('del-p-gone').status).toBe('paid')
      expect(profileStatus('del-paid-gone')).toBe('deleted')

      await seedProfile('del-paid-live', { status: 'suspended' })
      seedInvoice({ id: 'del-p-live', profileId: 'del-paid-live', status: 'suspended', issuedAt: daysAgo(10) })
      const live = await markInvoicePaid(db, { invoiceId: 'del-p-live', source: 'stripe' })
      expect(live.ok).toBe(true)
      expect(live.reactivated).toBe(true)
      expect(profileStatus('del-paid-live')).toBe('active')
    })
  })

  describe('review follow-ups: ordering, every open status, races, unreadable lifecycle', () => {
    it('a deleted PRO BONO profile\'s open invoices are voided as profile_deleted, not re-settled as pro bono, including a suspended one', async () => {
      await seedProfile('del-pb-gone', { status: 'deleted' })
      db.prepare('UPDATE billing_accounts SET is_pro_bono = 1 WHERE profile_id = ?').run('del-pb-gone')
      seedInvoice({ id: 'del-pb-sent', profileId: 'del-pb-gone', status: 'sent', issuedAt: daysAgo(2) })
      seedInvoice({ id: 'del-pb-susp', profileId: 'del-pb-gone', status: 'suspended', issuedAt: daysAgo(12) })

      const res = await processDunning(db, { now: NOW })

      expect(res.voided_deleted_profile).toBe(2)
      expect(res.pro_bono_settled).toBe(0)
      for (const id of ['del-pb-sent', 'del-pb-susp']) {
        expect(invoice(id).status).toBe('void')
        expect(invoice(id).settled_reason).toBe('profile_deleted')
      }
      expect(profileStatus('del-pb-gone')).toBe('deleted')
    })

    it('voids a hard-deleted profile\'s orphaned SUSPENDED invoice too', async () => {
      seedInvoice({ id: 'del-orphan-susp', profileId: 'del-hard-gone-2', status: 'suspended', issuedAt: daysAgo(20) })
      const res = await processDunning(db, { now: NOW })
      expect(res.voided_deleted_profile).toBe(1)
      expect(invoice('del-orphan-susp').status).toBe('void')
    })

    it('a delete that lands between the status check and the INSERT leaves a void invoice and sends no email', async () => {
      await seedProfile('del-race-gen')
      const racy = dbWithHook('INSERT INTO billing_invoices', 'run', () => markDeleted('del-race-gen'))
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('del-race-gen')

      expect(await generateInvoiceForAccount(racy, row, { now: NOW })).toBeNull()

      const rows = invoicesFor('del-race-gen')
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('void')
      expect(rows[0].settled_reason).toBe('profile_deleted')
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('a delete that lands between the pre-read and the guarded UPDATE makes suspend and reactivate refuse without notices', async () => {
      await seedProfile('del-race-sus')
      const racySuspend = dbWithHook('SELECT id, status FROM profiles', 'get', () => markDeleted('del-race-sus'))
      const s = await suspendProfile(racySuspend, { profileId: 'del-race-sus', reason: 'past_due', suspendedBy: 'billing_dunning' })
      expect(s).toEqual(expect.objectContaining({ ok: false, error: 'profile_deleted' }))
      expect(profileStatus('del-race-sus')).toBe('deleted')

      await seedProfile('del-race-react', { status: 'suspended' })
      const racyReactivate = dbWithHook('SELECT id, status FROM profiles', 'get', () => markDeleted('del-race-react'))
      const r = await reactivateProfile(racyReactivate, { profileId: 'del-race-react', reactivatedBy: 'admin' })
      expect(r).toEqual(expect.objectContaining({ ok: false, error: 'profile_deleted' }))
      expect(profileStatus('del-race-react')).toBe('deleted')

      expect(notifyProfile).not.toHaveBeenCalled()
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('voiding for profile_deleted expires every emailed Stripe Checkout link, and a Stripe failure never fails the delete', async () => {
      const id = 'del-designated-stripe'
      const linkA = 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4#fidkdWxOYHwnPyd1'
      const linkB = 'https://checkout.stripe.com/c/pay/cs_test_z9Y8x7W6#fidkdWxOYHwnPyd2'
      await seedProfile(id)
      seedInvoice({ id: 'del-stripe-a', profileId: id, status: 'sent', issuedAt: daysAgo(2), link: linkA })
      seedInvoice({ id: 'del-stripe-b', profileId: id, status: 'suspended', issuedAt: daysAgo(12), link: linkB })
      vi.mocked(expireCheckoutSessionForUrl).mockRejectedValueOnce(new Error('stripe down'))

      const res = await request(app).delete(`/api/profiles/${id}`).set(TEST_ADMIN_AUTH_HEADER)

      expect(res.status).toBe(204)
      expect(invoice('del-stripe-a').status).toBe('void')
      expect(invoice('del-stripe-b').status).toBe('void')
      const expiredUrls = vi.mocked(expireCheckoutSessionForUrl).mock.calls.map((c) => c[0])
      expect(expiredUrls).toEqual(expect.arrayContaining([linkA, linkB]))
    })

    it('dunning\'s deleted-profile sweep expires the Stripe link of an invoice it voids', async () => {
      const link = 'https://checkout.stripe.com/c/pay/cs_test_Dun1ng00#fid'
      await seedProfile('del-dun-stripe', { status: 'deleted' })
      seedInvoice({ id: 'del-dun-stripe-inv', profileId: 'del-dun-stripe', status: 'second_notice', issuedAt: daysAgo(5), link })

      const res = await processDunning(db, { now: NOW })

      expect(res.voided_deleted_profile).toBe(1)
      expect(vi.mocked(expireCheckoutSessionForUrl).mock.calls.map((c) => c[0])).toContain(link)
    })

    it('derives the Checkout Session id from the emailed URL and never calls Stripe without a key', async () => {
      expect(checkoutSessionIdFromUrl('https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5#fid')).toBe('cs_live_a1B2c3D4e5')
      expect(checkoutSessionIdFromUrl('https://checkout.stripe.com/pay/cs_test_Zz09')).toBe('cs_test_Zz09')
      expect(checkoutSessionIdFromUrl('https://pay.example/c/pay/cs_test_Zz09')).toBeNull()
      expect(checkoutSessionIdFromUrl('not a url')).toBeNull()
      const actual = await vi.importActual('../services/stripeService.js')
      const saved = process.env.STRIPE_SECRET_KEY
      delete process.env.STRIPE_SECRET_KEY
      try {
        expect(await actual.expireCheckoutSessionForUrl('https://checkout.stripe.com/c/pay/cs_test_Zz09'))
          .toEqual(expect.objectContaining({ ok: false, reason: 'stripe_not_configured', session_id: 'cs_test_Zz09' }))
      } finally {
        if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved
      }
    })

    it('a payment on a VOID invoice never flips it to paid or touches the profile, and alerts the owner to refund', async () => {
      process.env.BILLING_OWNER_CC = 'owner-alerts@example.com'
      try {
        await seedProfile('del-late-pay', { status: 'deleted' })
        seedInvoice({ id: 'del-late-inv', profileId: 'del-late-pay', status: 'void', issuedAt: daysAgo(9) })
        db.prepare("UPDATE billing_invoices SET settled_reason = 'profile_deleted' WHERE id = ?").run('del-late-inv')

        const r = await markInvoicePaid(db, { invoiceId: 'del-late-inv', source: 'stripe_webhook' })

        expect(r).toEqual(expect.objectContaining({ ok: true, reactivated: false, status: 'void', payment_on_void: true, refund_needed: true }))
        const inv = invoice('del-late-inv')
        expect(inv.status).toBe('void')
        expect(inv.settled_reason).toBe('profile_deleted')
        expect(inv.paid_at).toBeTruthy()
        expect(profileStatus('del-late-pay')).toBe('deleted')
        const alert = vi.mocked(sendEmail).mock.calls.map((c) => c[0]).find((m) => m?.to === 'owner-alerts@example.com')
        expect(alert?.subject).toMatch(/refund/i)
        expect(alert?.text).toMatch(/del-late-inv/)
      } finally {
        delete process.env.BILLING_OWNER_CC
      }
    })

    it('an unreadable profile lifecycle fails closed: no invoice, no reminder, no suspend, no void', async () => {
      await seedProfile('del-unread')
      seedInvoice({ id: 'del-unread-old', profileId: 'del-unread', status: 'sent', issuedAt: daysAgo(10) })
      const blind = dbWithUnreadableLifecycle()
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('del-unread')

      expect(await generateInvoiceForAccount(blind, row, { now: NOW })).toBeNull()
      expect(invoicesFor('del-unread')).toHaveLength(1)

      process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE = 'true'
      const res = await processDunning(blind, { now: NOW })
      expect(res.skipped_unreadable_profile).toBe(1)
      expect(res.suspended).toBe(0)
      expect(res.reminded).toBe(0)
      expect(res.voided_deleted_profile).toBe(0)
      expect(invoice('del-unread-old').status).toBe('sent')
      expect(profileStatus('del-unread')).toBe('active')
      expect(sendEmail).not.toHaveBeenCalled()
      expect(notifyProfile).not.toHaveBeenCalled()
    })
  })

  describe('review round two: every deletion writer, retried expiry, delivery re-check, atomic dunning, settle guard, zero-row writes', () => {
    it('DELETE /api/organizations/:id voids every linked profile\'s open invoices and expires their links', async () => {
      db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run('del-org-1', 'Org del-org-1')
      await seedProfile('del-org-p1')
      await seedProfile('del-org-p2')
      db.prepare("UPDATE profiles SET organization_id = 'del-org-1' WHERE id IN ('del-org-p1', 'del-org-p2')").run()
      const link = 'https://checkout.stripe.com/c/pay/cs_test_OrgDel01#fid'
      seedInvoice({ id: 'del-org-inv1', profileId: 'del-org-p1', status: 'sent', issuedAt: daysAgo(2), link })
      seedInvoice({ id: 'del-org-inv2', profileId: 'del-org-p2', status: 'suspended', issuedAt: daysAgo(12) })

      const res = await request(app).delete('/api/organizations/del-org-1').set(TEST_ADMIN_AUTH_HEADER)

      expect(res.status).toBe(200)
      expect(profileStatus('del-org-p1')).toBe('deleted')
      expect(profileStatus('del-org-p2')).toBe('deleted')
      for (const id of ['del-org-inv1', 'del-org-inv2']) {
        expect(invoice(id).status).toBe('void')
        expect(invoice(id).settled_reason).toBe('profile_deleted')
      }
      expect(vi.mocked(expireCheckoutSessionForUrl).mock.calls.map((c) => c[0])).toContain(link)
      expect(invoice('del-org-inv1').stripe_payment_link).toBeNull()
    })

    it('a profile merge voids the merged-away profile\'s open invoices after the transaction commits', async () => {
      await seedProfile('del-merge-winner')
      await seedProfile('del-merge-loser')
      seedInvoice({ id: 'del-merge-inv', profileId: 'del-merge-loser', status: 'sent', issuedAt: daysAgo(2) })

      await mergeProfiles(db, { winnerId: 'del-merge-winner', loserIds: ['del-merge-loser'], dryRun: false })

      expect(invoice('del-merge-inv').status).toBe('void')
      expect(invoice('del-merge-inv').settled_reason).toBe('profile_deleted')
      // Never repointed onto the keeper as a live balance.
      expect(invoice('del-merge-inv').profile_id).toBe('del-merge-loser')
    })

    it('a failed Checkout expiry keeps the link, and the next dunning sweep retries it and clears the link', async () => {
      const id = 'del-designated-retry'
      const link = 'https://checkout.stripe.com/c/pay/cs_test_Retry001#fid'
      await seedProfile(id)
      seedInvoice({ id: 'del-retry-inv', profileId: id, status: 'sent', issuedAt: daysAgo(2), link })
      vi.mocked(expireCheckoutSessionForUrl).mockResolvedValueOnce({ ok: false, reason: 'stripe_expire_failed' })

      const res = await request(app).delete(`/api/profiles/${id}`).set(TEST_ADMIN_AUTH_HEADER)
      expect(res.status).toBe(204)
      expect(invoice('del-retry-inv').status).toBe('void')
      expect(invoice('del-retry-inv').stripe_payment_link).toBe(link)

      const dun = await processDunning(db, { now: NOW })

      expect(dun.payment_links_expired_on_retry).toBe(1)
      expect(invoice('del-retry-inv').stripe_payment_link).toBeNull()
      expect(vi.mocked(expireCheckoutSessionForUrl).mock.calls.filter((c) => c[0] === link)).toHaveLength(2)
    })

    it('a delete that lands during the org-name lookup still voids the invoice and sends no email', async () => {
      await seedProfile('del-send-race')
      const racy = dbWithHook('SELECT display_name FROM profiles', 'get', () => markDeleted('del-send-race'))
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('del-send-race')

      expect(await generateInvoiceForAccount(racy, row, { now: NOW })).toBeNull()

      const rows = invoicesFor('del-send-race')
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('void')
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('an unreadable lifecycle at delivery withdraws the undelivered invoice, and the next cycle regenerates and emails it', async () => {
      await seedProfile('del-send-unread')
      const flaky = dbWithLifecycleReadFailingAfter(1)
      const row = db.prepare('SELECT * FROM billing_accounts WHERE profile_id = ?').get('del-send-unread')

      expect(await generateInvoiceForAccount(flaky, row, { now: NOW })).toBeNull()
      expect(invoicesFor('del-send-unread')).toHaveLength(0)
      expect(sendEmail).not.toHaveBeenCalled()

      const next = await generateInvoiceForAccount(db, row, { now: NOW })
      expect(next).toBeTruthy()
      const rows = invoicesFor('del-send-unread')
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('sent')
      expect(emailedTo()).toContain('del-send-unread@example.com')
    })

    it('dunning never reminds or rewrites an invoice voided between its read and the reminder UPDATE', async () => {
      await seedProfile('del-atomic-remind')
      seedInvoice({ id: 'del-atomic-remind-inv', profileId: 'del-atomic-remind', status: 'sent', issuedAt: daysAgo(4) })
      const racy = dbWithHook('SELECT created_by FROM profiles', 'get', () =>
        db.prepare("UPDATE billing_invoices SET status = 'void', settled_reason = 'profile_deleted' WHERE id = ?").run('del-atomic-remind-inv'))

      const res = await processDunning(racy, { now: NOW })

      expect(res.reminded).toBe(0)
      expect(invoice('del-atomic-remind-inv').status).toBe('void')
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('dunning never suspends when the profile is deleted between its read and the suspension UPDATE', async () => {
      await seedProfile('del-atomic-suspend')
      seedInvoice({ id: 'del-atomic-suspend-inv', profileId: 'del-atomic-suspend', status: 'sent', issuedAt: daysAgo(10) })
      const racy = dbWithHook('SELECT created_by FROM profiles', 'get', () => markDeleted('del-atomic-suspend'))
      process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE = 'true'

      const res = await processDunning(racy, { now: NOW })

      expect(res.suspended).toBe(0)
      expect(invoice('del-atomic-suspend-inv').status).toBe('sent')
      expect(profileStatus('del-atomic-suspend')).toBe('deleted')
      expect(notifyProfile).not.toHaveBeenCalled()
    })

    it('the shared pro bono reconcile/settle never converts a deleted profile\'s invoice to pro_bono', async () => {
      const link = 'https://checkout.stripe.com/c/pay/cs_test_ProBono01#fid'
      await seedProfile('del-pb-direct', { status: 'deleted' })
      db.prepare('UPDATE billing_accounts SET is_pro_bono = 1 WHERE profile_id = ?').run('del-pb-direct')
      seedInvoice({ id: 'del-pb-direct-inv', profileId: 'del-pb-direct', status: 'sent', issuedAt: daysAgo(3), link })

      const rec = await reconcileProBonoAccounts(db, { now: NOW })

      expect(rec.settled).toBe(0)
      const inv = invoice('del-pb-direct-inv')
      expect(inv.status).toBe('void')
      expect(inv.settled_reason).toBe('profile_deleted')
      expect(vi.mocked(expireCheckoutSessionForUrl).mock.calls.map((c) => c[0])).toContain(link)
      const direct = await settleInvoicesAsProBono(db, { profileId: 'del-pb-direct', now: NOW })
      expect(direct).toEqual(expect.objectContaining({ settled: 0, skipped: 'profile_deleted' }))
    })

    it('round three: a payment racing a delete that voids the invoice after the read stays void and alerts the owner to refund', async () => {
      process.env.BILLING_OWNER_CC = 'owner-alerts@example.com'
      try {
        await seedProfile('del-paid-race')
        seedInvoice({ id: 'del-paid-race-inv', profileId: 'del-paid-race', status: 'sent', issuedAt: daysAgo(3) })
        const racy = dbWithHook('SELECT * FROM billing_invoices WHERE id = ?', 'get', () => {
          markDeleted('del-paid-race')
          db.prepare("UPDATE billing_invoices SET status = 'void', settled_reason = 'profile_deleted' WHERE id = ?").run('del-paid-race-inv')
        })

        const r = await markInvoicePaid(racy, { invoiceId: 'del-paid-race-inv', source: 'stripe_webhook' })

        expect(r).toEqual(expect.objectContaining({ ok: true, status: 'void', payment_on_void: true, refund_needed: true, reactivated: false }))
        const inv = invoice('del-paid-race-inv')
        expect(inv.status).toBe('void')
        expect(inv.paid_at).toBeTruthy()
        expect(profileStatus('del-paid-race')).toBe('deleted')
        const alert = vi.mocked(sendEmail).mock.calls.map((c) => c[0]).find((m) => m?.to === 'owner-alerts@example.com')
        expect(alert?.subject).toMatch(/refund/i)
      } finally {
        delete process.env.BILLING_OWNER_CC
      }
    })

    it('round three: an invoice voided mid-settlement stays void and keeps its link for the retry scan', async () => {
      const link = 'https://checkout.stripe.com/c/pay/cs_test_SettleRace1#fid'
      await seedProfile('del-settle-race')
      db.prepare('UPDATE billing_accounts SET is_pro_bono = 1 WHERE profile_id = ?').run('del-settle-race')
      seedInvoice({ id: 'del-settle-race-inv', profileId: 'del-settle-race', status: 'sent', issuedAt: daysAgo(3), link })
      const racy = dbWithHook('SELECT id, status, amount_cents, gross_amount_cents FROM billing_invoices', 'all', () => {
        markDeleted('del-settle-race')
        db.prepare("UPDATE billing_invoices SET status = 'void', settled_reason = 'profile_deleted' WHERE id = ?").run('del-settle-race-inv')
      })

      const r = await settleInvoicesAsProBono(racy, { profileId: 'del-settle-race', now: NOW })

      expect(r.settled).toBe(0)
      const inv = invoice('del-settle-race-inv')
      expect(inv.status).toBe('void')
      expect(inv.settled_reason).toBe('profile_deleted')
      expect(inv.stripe_payment_link).toBe(link)
    })

    it('round three: POST /api/admin/profiles/:id/hard-delete voids the profile\'s open invoices and expires the link', async () => {
      const link = 'https://checkout.stripe.com/c/pay/cs_test_HardDel01#fid'
      await seedProfile('del-hard-admin')
      seedInvoice({ id: 'del-hard-admin-inv', profileId: 'del-hard-admin', status: 'second_notice', issuedAt: daysAgo(5), link })

      const res = await request(app)
        .post('/api/admin/profiles/del-hard-admin/hard-delete')
        .set(TEST_ADMIN_AUTH_HEADER)
        .send({ force: true, tombstone: false, reason: 'test' })

      expect(res.status).toBeLessThan(300)
      expect(profileStatus('del-hard-admin')).toBeUndefined()
      expect(invoice('del-hard-admin-inv').status).toBe('void')
      expect(invoice('del-hard-admin-inv').settled_reason).toBe('profile_deleted')
      expect(vi.mocked(expireCheckoutSessionForUrl).mock.calls.map((c) => c[0])).toContain(link)
    })

    it('a zero-row guarded status write is a refusal: missing profiles and an unreadable follow-up read get no notices', async () => {
      const s = await suspendProfile(db, { profileId: 'del-missing-profile', reason: 'admin_suspend', suspendedBy: 'admin' })
      expect(s).toEqual(expect.objectContaining({ ok: false, error: 'profile_not_found' }))
      const r = await reactivateProfile(db, { profileId: 'del-missing-profile', reactivatedBy: 'admin' })
      expect(r).toEqual(expect.objectContaining({ ok: false, error: 'profile_not_found' }))

      const blind = dbWithUnreadableLifecycle()
      const b = await suspendProfile(blind, { profileId: 'del-missing-profile-2', reason: 'admin_suspend', suspendedBy: 'admin' })
      expect(b).toEqual(expect.objectContaining({ ok: false, error: 'not_updated' }))

      expect(notifyProfile).not.toHaveBeenCalled()
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('a non-Checkout payment link is terminal (never retried), and a missing Stripe key is not', async () => {
      const actual = await vi.importActual('../services/stripeService.js')
      expect(await actual.expireCheckoutSessionForUrl('https://pay.example/invoice/123'))
        .toEqual(expect.objectContaining({ ok: false, reason: 'no_session_id', terminal: true }))
      const saved = process.env.STRIPE_SECRET_KEY
      delete process.env.STRIPE_SECRET_KEY
      try {
        const r = await actual.expireCheckoutSessionForUrl('https://checkout.stripe.com/c/pay/cs_test_Zz09')
        expect(r.terminal).toBeUndefined()
      } finally {
        if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved
      }
    })
  })

  describe('DELETE /api/profiles/:id voids open invoices', () => {
    it('designated soft delete: status deleted, open invoices voided, history kept, and the next billing cycle leaves it alone', async () => {
      const id = 'del-designated-1'
      await seedProfile(id)
      seedInvoice({ id: 'del-r-sent', profileId: id, status: 'sent', issuedAt: daysAgo(2) })
      seedInvoice({ id: 'del-r-second', profileId: id, status: 'second_notice', issuedAt: daysAgo(5) })
      seedInvoice({ id: 'del-r-susp', profileId: id, status: 'suspended', issuedAt: daysAgo(12) })
      seedInvoice({ id: 'del-r-paid', profileId: id, status: 'paid', issuedAt: daysAgo(20) })

      const res = await request(app).delete(`/api/profiles/${id}`).set(TEST_ADMIN_AUTH_HEADER)
      expect(res.status).toBe(204)
      expect(profileStatus(id)).toBe('deleted')
      // The soft delete keeps the billing account (no cascade) — the defect's precondition.
      expect(db.prepare('SELECT id FROM billing_accounts WHERE profile_id = ?').get(id)).toBeTruthy()
      for (const inv of ['del-r-sent', 'del-r-second', 'del-r-susp']) {
        expect(invoice(inv).status).toBe('void')
        expect(invoice(inv).settled_reason).toBe('profile_deleted')
      }
      expect(invoice('del-r-paid').status).toBe('paid')

      process.env.BILLING_ALLOW_SUSPEND_WITHOUT_STRIPE = 'true'
      vi.mocked(sendEmail).mockClear()
      const cycle = await runBillingCycle(db, { now: NOW, force: true })
      expect(cycle.generated).toBe(0)
      expect(cycle.suspended).toBe(0)
      expect(cycle.reminded).toBe(0)
      expect(invoicesFor(id)).toHaveLength(4)
      expect(profileStatus(id)).toBe('deleted')
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('non-designated delete voids open invoices whether the hard delete or the soft-delete fallback ran', async () => {
      const id = 'del-plain-1'
      await seedProfile(id)
      seedInvoice({ id: 'del-r-plain', profileId: id, status: 'sent', issuedAt: daysAgo(2) })

      const res = await request(app).delete(`/api/profiles/${id}`).set(TEST_ADMIN_AUTH_HEADER)
      expect(res.status).toBe(204)
      const after = profileStatus(id)
      expect(after === undefined || after === 'deleted').toBe(true)
      expect(invoice('del-r-plain').status).toBe('void')
      expect(invoice('del-r-plain').settled_reason).toBe('profile_deleted')
    })
  })
})
