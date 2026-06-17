import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

process.env.PRICING_REQUIRE_ADMIN_APPROVAL = 'false'

import {
  initializeProfilePricing,
  ADMIN_NOTIFICATIONS_TABLE,
} from '../../backend/services/pricing/profilePricingInitializer.js'
import {
  listForAdmin,
  markDelivered,
  dismiss,
  flushQueuedOnLogin,
} from '../../backend/services/pricing/pricingNotificationService.js'
import {
  ADMIN_NOTIFICATION_STATUS,
  adminNotificationEmail,
} from '../../backend/services/pricing/pricingTypes.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE pricing_quotes (
      id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT NOT NULL, intake_session_id TEXT,
      pricing_catalog_version TEXT NOT NULL, client_category TEXT NOT NULL,
      category_confidence TEXT, recommended_package_name TEXT,
      subtotal REAL, discount_total REAL, total REAL, currency TEXT,
      payment_terms_json TEXT, admin_review_required INTEGER,
      quote_status TEXT, reasons_json TEXT, missing_inputs_json TEXT,
      created_at DATETIME, updated_at DATETIME);
    CREATE TABLE pricing_quote_line_items (
      id TEXT PRIMARY KEY, quote_id TEXT, service_key TEXT, service_name TEXT,
      client_category TEXT, base_price REAL, quantity REAL, subtotal REAL,
      reason TEXT, confidence REAL, created_at DATETIME);
    CREATE TABLE pricing_quote_discounts (
      id TEXT PRIMARY KEY, quote_id TEXT, discount_key TEXT, label TEXT,
      discount_type TEXT, discount_value REAL, discount_amount REAL,
      reason TEXT, requires_admin_approval INTEGER, approved INTEGER,
      approved_by_user_id TEXT, created_at DATETIME);
    CREATE TABLE profile_pricing (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, user_id TEXT, quote_id TEXT,
      pricing_catalog_version TEXT NOT NULL, client_category TEXT NOT NULL,
      category_confidence TEXT, recommended_package_name TEXT, primary_service_key TEXT,
      subtotal_cents INTEGER, discount_total_cents INTEGER, total_cents INTEGER,
      currency TEXT, payment_required INTEGER, agreement_required INTEGER,
      access_status TEXT, admin_review_required INTEGER, discount_eligible INTEGER,
      discount_summary_json TEXT, reasons_json TEXT, missing_inputs_json TEXT,
      created_at DATETIME, updated_at DATETIME);
    CREATE UNIQUE INDEX ux_profile_pricing_profile ON profile_pricing(profile_id);
    CREATE TABLE service_agreements (
      id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT NOT NULL, quote_id TEXT,
      agreement_version TEXT NOT NULL, accepted INTEGER, accepted_at DATETIME,
      accepted_ip TEXT, accepted_user_agent TEXT, agreement_text_snapshot TEXT,
      created_at DATETIME);
    CREATE TABLE payment_access_events (
      id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, quote_id TEXT,
      event_type TEXT NOT NULL, details_json TEXT, created_at DATETIME);
    CREATE TABLE admin_pricing_notifications (
      id TEXT PRIMARY KEY, admin_email TEXT NOT NULL, user_id TEXT, profile_id TEXT, quote_id TEXT,
      notification_type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued', created_at DATETIME, delivered_at DATETIME, dismissed_at DATETIME);
  `)
  return db
}

const adminUser = { id: 'admin', email: 'buckeye7066@gmail.com', is_admin: true }
const otherAdmin = { id: 'other-admin', email: 'someone-else@example.com', is_admin: true }
const normalUser = { id: 'u', email: 'jane@example.com', is_admin: false }

async function seedNotification(db) {
  await initializeProfilePricing(db, {
    profile: { id: 'p1', display_name: 'Acme', primary_type: 'small_org' },
    user: normalUser,
  })
}

test('listForAdmin returns notifications for the configured admin email only', async () => {
  const db = createDb()
  await seedNotification(db)

  const r = await listForAdmin(db, { user: adminUser })
  assert.equal(r.ok, true)
  assert.ok(r.items.length >= 1)
  assert.equal(r.items[0].admin_email, adminNotificationEmail())
  assert.equal(r.items[0].title, 'New GrantFlow client priced')
})

test('listForAdmin refuses non-target admin (is_admin=true but wrong email)', async () => {
  const db = createDb()
  await seedNotification(db)
  const r = await listForAdmin(db, { user: otherAdmin })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_admin_notification_target')
})

test('listForAdmin refuses normal users', async () => {
  const db = createDb()
  await seedNotification(db)
  const r = await listForAdmin(db, { user: normalUser })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_admin_notification_target')
})

test('markDelivered flips status to delivered_live', async () => {
  const db = createDb()
  await seedNotification(db)
  const list = await listForAdmin(db, { user: adminUser })
  const id = list.items[0].id
  const r = await markDelivered(db, { user: adminUser, id, mode: 'live' })
  assert.equal(r.ok, true)
  assert.equal(r.status, ADMIN_NOTIFICATION_STATUS.DELIVERED_LIVE)
  const updated = db.prepare(`SELECT * FROM ${ADMIN_NOTIFICATIONS_TABLE} WHERE id = ?`).get(id)
  assert.equal(updated.status, ADMIN_NOTIFICATION_STATUS.DELIVERED_LIVE)
  assert.ok(updated.delivered_at)
})

test('dismiss flips status to dismissed', async () => {
  const db = createDb()
  await seedNotification(db)
  const list = await listForAdmin(db, { user: adminUser })
  const id = list.items[0].id
  const r = await dismiss(db, { user: adminUser, id })
  assert.equal(r.ok, true)
  assert.equal(r.status, ADMIN_NOTIFICATION_STATUS.DISMISSED)
})

test('flushQueuedOnLogin returns queued items and marks them delivered_on_login', async () => {
  const db = createDb()
  await seedNotification(db)
  await seedNotification(db) // idempotent re-init shouldn't add duplicate notif
  // Add a second profile to ensure 2 queued items
  await initializeProfilePricing(db, {
    profile: { id: 'p2', display_name: 'Beta', primary_type: 'individual' },
    user: { ...normalUser, id: 'u2', email: 'bob@example.com' },
  })

  const r = await flushQueuedOnLogin(db, { user: adminUser })
  assert.equal(r.ok, true)
  assert.ok(r.items.length >= 1)
  for (const row of db.prepare(`SELECT status FROM ${ADMIN_NOTIFICATIONS_TABLE}`).all()) {
    assert.equal(row.status, ADMIN_NOTIFICATION_STATUS.DELIVERED_ON_LOGIN)
  }
})

test('all queued notifications target ONLY the configured admin email', async () => {
  const db = createDb()
  for (const i of [1, 2, 3]) {
    await initializeProfilePricing(db, {
      profile: { id: `p${i}`, display_name: `User ${i}`, primary_type: 'individual' },
      user: { id: `u${i}`, email: `user${i}@example.com`, is_admin: false },
    })
  }
  const all = db.prepare(`SELECT DISTINCT admin_email FROM ${ADMIN_NOTIFICATIONS_TABLE}`).all()
  assert.equal(all.length, 1)
  assert.equal(all[0].admin_email, adminNotificationEmail())
})
