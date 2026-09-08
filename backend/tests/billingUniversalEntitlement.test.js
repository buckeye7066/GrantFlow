/**
 * UNIVERSAL ENTITLEMENT (owner order 2026-09-07, "make these changes global
 * and permanent" — "(highest non-admin tier)").
 *
 * Prod evidence: end user GeneMac (a senior, billed the $0 'individual' tier)
 * was locked out of pipeline automation because the entitlement tier was the
 * BILLED tier, whose capabilities exclude it; an admin had to hand-grant an
 * add-on. This proves, against the real in-memory schema and the real
 * entitlement choke point, that:
 *   - an individual-type profile with NO add-on is allowed every capability
 *     (document AI, item funding, pipeline automation), now and in the future;
 *   - its BILL is untouched (net_monthly_cents stays the individual tier's $0,
 *     and the reported tier_id is still the billed tier);
 *   - the payment prerequisite, suspension, and admin paths are unchanged.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { getAppAndDb } from './testServer.js'
import {
  resolveAllProfileEntitlements,
  resolveProfileEntitlement,
  listActiveBillingAddons,
  UNIVERSAL_ENTITLEMENT_TIER,
} from '../services/billing/entitlementService.js'
import { computeEffectiveBilling, ensureBillingAccount, ensureBillingSchema, mapAccountRow } from '../services/billingAccounts.js'
import { CAPABILITY_KEYS, tierById } from '../../shared/tierCatalog.js'

const NOW = new Date('2026-09-08T01:00:00Z')
const LATER = new Date('2026-12-01T00:00:00Z')
const ALL_KEYS = Object.values(CAPABILITY_KEYS)

describe('universal entitlement: every non-admin profile holds the highest non-admin tier capabilities', () => {
  let db
  let savedFreeWeek

  beforeAll(async () => {
    db = (await getAppAndDb()).db
    await ensureBillingSchema(db)
    // The in-memory harness boots schema.sql only; profile_pricing (read for
    // the payment prerequisite) comes from a numbered migration. Apply it
    // verbatim so the authority sees the real table instead of failing closed.
    const migration = readFileSync(fileURLToPath(new URL('../db/migrations/080_pricing_access_gate.sql', import.meta.url)), 'utf8')
    for (const stmt of migration.replace(/^\s*--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) {
      db.prepare(stmt).run()
    }
    // A live Free Week would grant via 'promotion' and mask the tier decision.
    savedFreeWeek = process.env.FREE_WEEK_ENABLED
    delete process.env.FREE_WEEK_ENABLED
  }, 60_000)

  afterAll(() => {
    if (savedFreeWeek === undefined) delete process.env.FREE_WEEK_ENABLED
    else process.env.FREE_WEEK_ENABLED = savedFreeWeek
  })

  beforeEach(() => {
    for (const sql of [
      "DELETE FROM billing_entitlement_events WHERE profile_id LIKE 'uni-%'",
      "DELETE FROM billing_addon_entitlements WHERE profile_id LIKE 'uni-%'",
      "DELETE FROM profile_pricing WHERE profile_id LIKE 'uni-%'",
      'DELETE FROM billing_account_events',
      "DELETE FROM billing_accounts WHERE profile_id LIKE 'uni-%'",
      "DELETE FROM profiles WHERE id LIKE 'uni-%'",
    ]) {
      try { db.prepare(sql).run() } catch { /* table variance */ }
    }
  })

  async function seedProfile(id, { primaryType = 'individual', status = 'active', customMonthlyCents = null } = {}) {
    db.prepare('INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, ?, ?)')
      .run(id, `Profile ${id}`, primaryType, status)
    await ensureBillingAccount(db, id)
    if (customMonthlyCents !== null) {
      db.prepare('UPDATE billing_accounts SET custom_monthly_cents = ? WHERE profile_id = ?').run(customMonthlyCents, id)
    }
  }

  it('the policy tier is the highest non-admin tier in the catalog with every capability on', () => {
    expect(UNIVERSAL_ENTITLEMENT_TIER.id).toBe('large_org')
    for (const key of ALL_KEYS) expect(UNIVERSAL_ENTITLEMENT_TIER.capabilities[key]).toBe(true)
  })

  it('an individual-type profile with NO add-on is allowed pipeline automation (and the other two) now and later', async () => {
    await seedProfile('uni-individual')
    expect(await listActiveBillingAddons(db, 'uni-individual', { now: NOW })).toEqual([])

    for (const now of [NOW, LATER]) {
      const ent = await resolveAllProfileEntitlements(db, { profileId: 'uni-individual', isAdmin: false, now })
      expect(ent.locked).toEqual([])
      expect(ent.allowed.sort()).toEqual([...ALL_KEYS].sort())
      const pipeline = ent.capabilities[CAPABILITY_KEYS.PIPELINE_AUTOMATION]
      expect(pipeline).toMatchObject({
        allowed: true,
        source: 'tier',
        reason: null,
        tier_id: 'individual',
        entitlement_tier_id: 'large_org',
        active_addons: [],
      })
    }
  })

  it('what the profile is BILLED does not move: net_monthly_cents stays the individual tier amount', async () => {
    await seedProfile('uni-individual')
    const before = await computeEffectiveBilling(db, 'uni-individual', mapAccountRow(await ensureBillingAccount(db, 'uni-individual')))
    await resolveProfileEntitlement(db, { profileId: 'uni-individual', capabilityKey: CAPABILITY_KEYS.PIPELINE_AUTOMATION, now: NOW })
    const after = await computeEffectiveBilling(db, 'uni-individual', mapAccountRow(await ensureBillingAccount(db, 'uni-individual')))
    expect(after).toEqual(before)
    expect(after.tier_id).toBe('individual')
    expect(after.net_monthly_cents).toBe(tierById('individual').monthly_cents)
    expect(after.net_monthly_cents).toBe(0)
    expect(after.basis).toBe('profile_type')
  })

  it('the payment prerequisite is untouched: a paying profile with no payment decision is still payment_not_active', async () => {
    await seedProfile('uni-paying', { primaryType: 'organization', customMonthlyCents: 14900 })
    const decision = await resolveProfileEntitlement(db, {
      profileId: 'uni-paying', capabilityKey: CAPABILITY_KEYS.PIPELINE_AUTOMATION, now: NOW,
    })
    expect(decision).toMatchObject({ allowed: false, reason: 'payment_not_active', payment_required: true })
  })

  it('a suspended profile stays locked and an admin still resolves as source admin', async () => {
    await seedProfile('uni-suspended', { status: 'suspended' })
    const suspended = await resolveProfileEntitlement(db, {
      profileId: 'uni-suspended', capabilityKey: CAPABILITY_KEYS.DOCUMENT_AI, now: NOW,
    })
    expect(suspended).toMatchObject({ allowed: false, reason: 'profile_suspended' })

    const admin = await resolveProfileEntitlement(db, {
      profileId: 'uni-suspended', capabilityKey: CAPABILITY_KEYS.DOCUMENT_AI, isAdmin: true, now: NOW,
    })
    expect(admin).toMatchObject({ allowed: true, source: 'admin' })
  })
})
