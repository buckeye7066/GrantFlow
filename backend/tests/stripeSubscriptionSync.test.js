import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  applyStripeSubscription,
  resolveTierIdFromStripePrice,
  freeTierId,
} from '../services/billing/subscriptionSync.js'

/**
 * These tests pin the behaviour that was MISSING on main: a verified Stripe
 * subscription must move billing_accounts.tier_id. Before subscriptionSync.js
 * existed, stripeWebhook.js handled only 'checkout.session.completed' and no
 * code path anywhere wrote tier_id from a Stripe event, so paying for a plan
 * never unlocked enable_item_funding / enable_document_ai /
 * enable_pipeline_automation.
 *
 * The negative cases matter as much as the positive one: an unmapped price must
 * NOT be allowed to guess a tier, and a pro-bono grant must survive a lapsed card.
 */

function schema(sqlite) {
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE billing_tiers (
      id TEXT PRIMARY KEY, name TEXT,
      enable_pipeline_automation BOOLEAN DEFAULT 0,
      enable_item_funding BOOLEAN DEFAULT 0,
      enable_document_ai BOOLEAN DEFAULT 0
    );
    CREATE TABLE billing_accounts (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, tier_id TEXT NOT NULL,
      assigned_by TEXT, assigned_reason TEXT,
      discount_type TEXT, discount_percent REAL DEFAULT 0,
      is_pro_bono BOOLEAN DEFAULT 0, pro_bono_reason TEXT,
      custom_monthly_cents INTEGER, custom_hourly_cents INTEGER, metadata TEXT,
      stripe_customer_id TEXT, stripe_subscription_id TEXT, stripe_price_id TEXT,
      subscription_status TEXT, subscription_current_period_end DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Shaped like the REAL schema.sql (line 1764), not a convenient fiction:
    -- the column is account_id (NOT billing_account_id) and notes (NOT note).
    -- An earlier draft of this fixture invented those names; the test then
    -- passed against a table prod does not have. Same class of bug the
    -- billingAccounts.test.js header warns about.
    CREATE TABLE billing_account_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
      changed_by TEXT,
      previous_tier_id TEXT, new_tier_id TEXT,
      previous_discount_type TEXT, new_discount_type TEXT,
      previous_discount_percent REAL, new_discount_percent REAL,
      previous_pro_bono BOOLEAN, new_pro_bono BOOLEAN,
      notes TEXT
    );
    INSERT INTO billing_tiers (id, name) VALUES ('foundation', 'Foundation'), ('growth', 'Growth');
    INSERT INTO profiles (id, display_name) VALUES ('p1', 'Test Profile');
    INSERT INTO billing_accounts (id, profile_id, tier_id) VALUES ('acct-1', 'p1', 'foundation');
  `)
}

function subscription(overrides = {}) {
  return {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    current_period_end: 1893456000,
    metadata: { profile_id: 'p1' },
    items: { data: [{ price: { id: 'price_growth_live' } }] },
    ...overrides,
  }
}

let sqlite
const PRICE_ENV = 'STRIPE_PRICE_GROWTH'
let priorEnv

beforeEach(() => {
  sqlite = new Database(':memory:')
  schema(sqlite)
  priorEnv = process.env[PRICE_ENV]
  process.env[PRICE_ENV] = 'price_growth_live'
})

afterEach(() => {
  sqlite.close()
  if (priorEnv === undefined) delete process.env[PRICE_ENV]
  else process.env[PRICE_ENV] = priorEnv
})

const accountRow = () => sqlite.prepare('SELECT * FROM billing_accounts WHERE id = ?').get('acct-1')

describe('resolveTierIdFromStripePrice', () => {
  it('maps a configured price id to its tier', () => {
    expect(resolveTierIdFromStripePrice('price_growth_live')).toBe('growth')
  })

  it('returns null for an unmapped price rather than guessing', () => {
    expect(resolveTierIdFromStripePrice('price_never_configured')).toBeNull()
    expect(resolveTierIdFromStripePrice('')).toBeNull()
    expect(resolveTierIdFromStripePrice(null)).toBeNull()
  })
})

describe('applyStripeSubscription', () => {
  it('upgrades the tier when an active subscription carries a mapped price', async () => {
    const result = await applyStripeSubscription(sqlite, subscription())
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.previous_tier_id).toBe('foundation')
    expect(result.new_tier_id).toBe('growth')

    const row = accountRow()
    expect(row.tier_id).toBe('growth')
    expect(row.stripe_subscription_id).toBe('sub_123')
    expect(row.stripe_customer_id).toBe('cus_123')
    expect(row.subscription_status).toBe('active')
  })

  it('treats trialing as active', async () => {
    await applyStripeSubscription(sqlite, subscription({ status: 'trialing' }))
    expect(accountRow().tier_id).toBe('growth')
  })

  it('writes an audit row on a tier change', async () => {
    await applyStripeSubscription(sqlite, subscription())
    const events = sqlite.prepare('SELECT * FROM billing_account_events').all()
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].new_tier_id).toBe('growth')
    expect(events[0].previous_tier_id).toBe('foundation')
    expect(events[0].account_id).toBe('acct-1')
    // The reason + subscription/price provenance must survive into the audit
    // row. This assertion is what caught the note/notes key mismatch that was
    // silently discarding it.
    expect(events[0].notes).toContain('stripe_subscription_active')
    expect(events[0].notes).toContain('sub_123')
  })

  it('FAILS CLOSED on an unmapped price — never guesses a paid tier', async () => {
    const sub = subscription({ items: { data: [{ price: { id: 'price_unknown' } }] } })
    const result = await applyStripeSubscription(sqlite, sub)
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(result.reason).toBe('unmapped_price_id')
    expect(accountRow().tier_id).toBe('foundation')
  })

  it('revokes to the free tier when the subscription is canceled', async () => {
    await applyStripeSubscription(sqlite, subscription())
    expect(accountRow().tier_id).toBe('growth')

    const result = await applyStripeSubscription(sqlite, subscription({ status: 'canceled' }))
    expect(result.new_tier_id).toBe(freeTierId())
    expect(accountRow().tier_id).toBe('foundation')
  })

  it('does NOT revoke a pro-bono account when the card lapses', async () => {
    sqlite.prepare('UPDATE billing_accounts SET tier_id = ?, is_pro_bono = 1 WHERE id = ?').run('growth', 'acct-1')
    const result = await applyStripeSubscription(sqlite, subscription({ status: 'canceled' }))
    expect(result.reason).toBe('revocation_skipped_pro_bono')
    expect(accountRow().tier_id).toBe('growth')
  })

  it('holds the tier during past_due dunning but records the status', async () => {
    await applyStripeSubscription(sqlite, subscription())
    const result = await applyStripeSubscription(sqlite, subscription({ status: 'past_due' }))
    expect(result.changed).toBe(false)
    const row = accountRow()
    expect(row.tier_id).toBe('growth')
    expect(row.subscription_status).toBe('past_due')
  })

  it('resolves the profile from an existing subscription link when metadata is absent', async () => {
    await applyStripeSubscription(sqlite, subscription())
    const result = await applyStripeSubscription(
      sqlite,
      subscription({ metadata: {}, status: 'canceled' }),
    )
    expect(result.ok).toBe(true)
    expect(result.profile_id).toBe('p1')
  })

  it('refuses to touch any account when the profile cannot be resolved', async () => {
    const orphan = subscription({ id: 'sub_orphan', customer: 'cus_orphan', metadata: {} })
    const result = await applyStripeSubscription(sqlite, orphan)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unresolved_profile')
    expect(accountRow().tier_id).toBe('foundation')
  })
})
