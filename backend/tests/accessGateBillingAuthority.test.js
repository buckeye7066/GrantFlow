/**
 * The page-level access gate must honor the billing authority.
 *
 * Prod evidence (2026-09-07): profile_pricing had ZERO rows (pricing only
 * materializes when Anya intake completes), so every non-admin user got
 * blocking_reason=no_pricing_yet, was redirected to /PricingRequired, and
 * "Accept and continue" answered 400 no_pricing. The owner's free month +
 * pro bono flag on billing_accounts unlocked nothing because getAccessStatus
 * never read billing_accounts. adminWaiveProfile was a silent no-op UPDATE
 * for the same profiles.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

import { getAppAndDb } from './testServer.js'
import { getAccessStatus, acceptAgreement } from '../services/pricing/pricingAccessGate.js'
import { adminWaiveProfile, getProfilePricing } from '../services/pricing/profilePricingInitializer.js'
import { ensureBillingAccount } from '../services/billingAccounts.js'
import { ensureInvoiceSchema } from '../services/billing/invoiceService.js'

const NOW = new Date('2026-09-07T23:45:00Z')
const principal = { identityResolved: true, isAdmin: false, userId: 'user-gate' }

describe('access gate honors the billing authority', () => {
  let db

  beforeAll(async () => {
    db = (await getAppAndDb()).db
    await ensureInvoiceSchema(db)
    // The in-memory harness boots schema.sql only; the pricing gate tables come
    // from a numbered migration. Apply it verbatim so the gate sees real tables.
    const migration = readFileSync(fileURLToPath(new URL('../db/migrations/080_pricing_access_gate.sql', import.meta.url)), 'utf8')
    for (const stmt of migration.replace(/^\s*--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) {
      db.prepare(stmt).run()
    }
  }, 60_000)

  beforeEach(() => {
    for (const sql of [
      "DELETE FROM payment_access_events WHERE profile_id LIKE 'gate-%'",
      "DELETE FROM service_agreements WHERE profile_id LIKE 'gate-%'",
      "DELETE FROM profile_pricing WHERE profile_id LIKE 'gate-%'",
      "DELETE FROM billing_account_events",
      "DELETE FROM billing_accounts WHERE profile_id LIKE 'gate-%'",
      "DELETE FROM profiles WHERE id LIKE 'gate-%'",
    ]) {
      try { db.prepare(sql).run() } catch { /* table variance */ }
    }
  })

  async function seedProfile(id, { proBono = false, monthlyCents = 14900, status = 'active', freeUntil = null } = {}) {
    db.prepare("INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, 'organization', ?)").run(id, `Org ${id}`, status)
    await ensureBillingAccount(db, id)
    db.prepare('UPDATE billing_accounts SET is_pro_bono = ?, custom_monthly_cents = ?, free_until = ? WHERE profile_id = ?')
      .run(proBono ? 1 : 0, monthlyCents, freeUntil, id)
  }

  it('a pro bono profile with no pricing row is granted access and owes no agreement', async () => {
    await seedProfile('gate-pro-bono', { proBono: true })
    const status = await getAccessStatus(db, { principal, profileId: 'gate-pro-bono', now: NOW })
    expect(status.authenticated).toBe(true)
    expect(status.access_granted).toBe(true)
    expect(status.blocking_reason).toBeNull()
    expect(status.payment_required).toBe(false)
    expect(status.agreement_required).toBe(false)
    expect(status.payment_status).toBe('pro_bono')
    expect(status.access_source).toBe('billing')
  })

  it('an active free period grants access to a paying tier with no pricing row', async () => {
    await seedProfile('gate-free', { freeUntil: '2026-10-13T02:41:12.839Z' })
    const status = await getAccessStatus(db, { principal, profileId: 'gate-free', now: NOW })
    expect(status.access_granted).toBe(true)
    expect(status.payment_status).toBe('free_period')
    expect(status.agreement_required).toBe(false)
  })

  it('a $0 tier grants access with no pricing row', async () => {
    await seedProfile('gate-zero', { monthlyCents: 0 })
    const status = await getAccessStatus(db, { principal, profileId: 'gate-zero', now: NOW })
    expect(status.access_granted).toBe(true)
    expect(status.payment_status).toBe('free_tier')
  })

  it('an expired free period on a paying tier stays blocked', async () => {
    await seedProfile('gate-expired', { freeUntil: '2026-09-01T00:00:00.000Z' })
    const status = await getAccessStatus(db, { principal, profileId: 'gate-expired', now: NOW })
    expect(status.access_granted).toBe(false)
    expect(status.blocking_reason).toBe('no_pricing_yet')
    expect(status.access_source).toBeUndefined()
  })

  it('a suspended profile is never unlocked by pro bono or a free period', async () => {
    await seedProfile('gate-suspended', { proBono: true, status: 'suspended', freeUntil: '2026-10-13T02:41:12.839Z' })
    const status = await getAccessStatus(db, { principal, profileId: 'gate-suspended', now: NOW })
    expect(status.access_granted).toBe(false)
  })

  it('billing never overrides an explicit blocked/expired pricing status', async () => {
    await seedProfile('gate-blocked', { proBono: true })
    db.prepare(`INSERT INTO profile_pricing (id, profile_id, pricing_catalog_version, client_category, access_status)
                VALUES ('pp-blocked', 'gate-blocked', '2026-06-15', 'organization', 'blocked')`).run()
    const status = await getAccessStatus(db, { principal, profileId: 'gate-blocked', now: NOW })
    expect(status.access_granted).toBe(false)
    expect(status.blocking_reason).toBe('blocked')
  })

  it('an unresolved identity is still not authenticated regardless of billing', async () => {
    await seedProfile('gate-anon', { proBono: true })
    const status = await getAccessStatus(db, { principal: null, profileId: 'gate-anon', now: NOW })
    expect(status.authenticated).toBe(false)
    expect(status.access_granted).toBe(false)
  })

  it('adminWaiveProfile creates the pricing row it needs instead of silently doing nothing', async () => {
    await seedProfile('gate-waive', { monthlyCents: 14900 })
    expect(await getProfilePricing(db, 'gate-waive')).toBeFalsy()
    const r = await adminWaiveProfile(db, 'gate-waive', { actor: { email: 'owner@example.test' } })
    expect(r.ok).toBe(true)
    const pricing = await getProfilePricing(db, 'gate-waive')
    expect(pricing?.access_status).toBe('admin_waived')
    const status = await getAccessStatus(db, { principal, profileId: 'gate-waive', now: NOW })
    expect(status.access_granted).toBe(true)
    expect(status.payment_status).toBe('admin_waived')
  })

  it('acceptAgreement still reports no_pricing for a paying profile without pricing', async () => {
    await seedProfile('gate-accept', { monthlyCents: 14900 })
    const r = await acceptAgreement(db, { profileId: 'gate-accept', userId: 'user-gate', ip: '1.1.1.1', userAgent: 'test', agreementText: '' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('no_pricing')
  })
})
