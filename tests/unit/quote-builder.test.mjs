import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  persistQuote,
  getQuote,
  listQuotes,
  approveQuote,
  approveDiscount,
  removeDiscount,
  addManualDiscount,
} from '../../backend/services/pricing/quoteBuilder.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE pricing_quotes (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      profile_id TEXT NOT NULL,
      intake_session_id TEXT,
      pricing_catalog_version TEXT NOT NULL,
      client_category TEXT NOT NULL,
      category_confidence TEXT,
      recommended_package_name TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      discount_total REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      payment_terms_json TEXT,
      admin_review_required INTEGER NOT NULL DEFAULT 1,
      quote_status TEXT NOT NULL DEFAULT 'internal_recommendation',
      reasons_json TEXT,
      missing_inputs_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE pricing_quote_line_items (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      service_key TEXT NOT NULL,
      service_name TEXT NOT NULL,
      client_category TEXT NOT NULL,
      base_price REAL NOT NULL DEFAULT 0,
      quantity REAL NOT NULL DEFAULT 1,
      subtotal REAL NOT NULL DEFAULT 0,
      reason TEXT,
      confidence REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE pricing_quote_discounts (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      discount_key TEXT NOT NULL,
      label TEXT,
      discount_type TEXT NOT NULL DEFAULT 'percent',
      discount_value REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      reason TEXT,
      requires_admin_approval INTEGER NOT NULL DEFAULT 1,
      approved INTEGER NOT NULL DEFAULT 0,
      approved_by_user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

const sampleQuote = {
  pricing_catalog_version: '2026-06-15',
  client_category: 'small',
  category_confidence: 'high',
  recommended_package_name: 'GrantFlow Foundation Application',
  line_items: [
    {
      service_key: 'standard_foundation_application',
      service_name: 'Standard Foundation Application',
      client_category: 'small',
      base_price: 3500,
      quantity: 1,
      subtotal: 3500,
      reason: 'Foundation grant application',
      confidence: 0.85,
    },
  ],
  discounts: [
    {
      discount_key: 'manual_admin',
      label: 'Manual admin discount',
      discount_type: 'fixed',
      discount_value: 100,
      amount: 100,
      reason: 'Beta-program courtesy',
      requires_admin_approval: true,
      approved: false,
    },
  ],
  subtotal: 3500,
  discount_total: 0,
  total: 3500,
  currency: 'USD',
  admin_review_required: true,
  reasons: ['New client'],
  missing_pricing_inputs: [],
  payment_terms: { net_days: 15 },
}

test('persistQuote writes the quote and its children', async () => {
  const db = createDb()
  const r = await persistQuote(db, { profileId: 'p1', quote: sampleQuote })
  assert.equal(r.ok, true)
  assert.match(r.id, /^quote_/)
  assert.equal(r.status, 'pending_admin_review')

  const lookup = await getQuote(db, r.id)
  assert.ok(lookup)
  assert.equal(lookup.profile_id, 'p1')
  assert.equal(lookup.line_items.length, 1)
  assert.equal(lookup.discounts.length, 1)
  assert.equal(lookup.discounts[0].requires_admin_approval, true)
  assert.equal(lookup.discounts[0].approved, false)
})

test('persistQuote returns not_installed when tables are missing', async () => {
  const db = new Database(':memory:')
  const r = await persistQuote(db, { profileId: 'p1', quote: sampleQuote })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'pricing_tables_not_installed')
})

test('listQuotes filters by status and returns installed flag', async () => {
  const db = createDb()
  const a = await persistQuote(db, { profileId: 'p1', quote: sampleQuote, status: 'pending_admin_review' })
  const b = await persistQuote(db, { profileId: 'p2', quote: sampleQuote, status: 'approved' })
  const pending = await listQuotes(db, { status: 'pending_admin_review' })
  assert.equal(pending.installed, true)
  assert.ok(pending.items.find((q) => q.id === a.id))
  assert.ok(!pending.items.find((q) => q.id === b.id))
})

test('approveQuote flips quote_status to approved', async () => {
  const db = createDb()
  const r = await persistQuote(db, { profileId: 'p1', quote: sampleQuote })
  await approveQuote(db, r.id)
  const lookup = await getQuote(db, r.id)
  assert.equal(lookup.quote_status, 'approved')
})

test('approveDiscount flips approval and recomputes total', async () => {
  const db = createDb()
  const r = await persistQuote(db, { profileId: 'p1', quote: sampleQuote })
  const lookup = await getQuote(db, r.id)
  const did = lookup.discounts[0].id
  await approveDiscount(db, r.id, did)
  const after = await getQuote(db, r.id)
  assert.equal(after.discounts[0].approved, true)
  assert.equal(after.subtotal, 3500)
  assert.equal(after.discount_total, 100)
  assert.equal(after.total, 3400)
})

test('removeDiscount deletes the row and recomputes total', async () => {
  const db = createDb()
  const r = await persistQuote(db, { profileId: 'p1', quote: sampleQuote })
  const lookup = await getQuote(db, r.id)
  await removeDiscount(db, r.id, lookup.discounts[0].id)
  const after = await getQuote(db, r.id)
  assert.equal(after.discounts.length, 0)
  assert.equal(after.total, 3500)
})

test('addManualDiscount appends and re-runs math', async () => {
  const db = createDb()
  const r = await persistQuote(db, {
    profileId: 'p1',
    quote: {
      ...sampleQuote,
      discounts: [], // start clean
      discount_total: 0,
      total: 3500,
    },
  })
  await addManualDiscount(db, r.id, {
    discount_key: 'manual_admin',
    label: 'Manual admin discount',
    type: 'fixed',
    value: 200,
    amount: 200,
    reason: 'Anniversary',
    approved: true,
  })
  const after = await getQuote(db, r.id)
  assert.equal(after.discounts.length, 1)
  assert.equal(after.discounts[0].approved, true)
  assert.equal(after.discount_total, 200)
  assert.equal(after.total, 3300)
})
