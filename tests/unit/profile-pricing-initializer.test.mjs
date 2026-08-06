import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

// The pricing engine defaults to PRICING_REQUIRE_ADMIN_APPROVAL=true,
// which forces every new quote into admin review. For the happy-path
// initializer tests we want the user to land directly at the agreement
// step.
process.env.PRICING_REQUIRE_ADMIN_APPROVAL = 'false'

import {
  initializeProfilePricing,
  getProfilePricing,
  adminWaiveProfile,
  PROFILE_PRICING_TABLE,
  ADMIN_NOTIFICATIONS_TABLE,
  PAYMENT_EVENTS_TABLE,
  SERVICE_AGREEMENTS_TABLE,
} from '../../backend/services/pricing/profilePricingInitializer.js'
import {
  ACCESS_STATUS,
  ADMIN_NOTIFICATION_TYPE,
  PAYMENT_ACCESS_EVENT,
  adminNotificationEmail,
} from '../../backend/services/pricing/pricingTypes.js'

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
      id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, service_key TEXT NOT NULL,
      service_name TEXT NOT NULL, client_category TEXT NOT NULL,
      base_price REAL NOT NULL DEFAULT 0, quantity REAL NOT NULL DEFAULT 1,
      subtotal REAL NOT NULL DEFAULT 0, reason TEXT, confidence REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE pricing_quote_discounts (
      id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, discount_key TEXT NOT NULL,
      label TEXT, discount_type TEXT NOT NULL DEFAULT 'percent',
      discount_value REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0,
      reason TEXT, requires_admin_approval INTEGER NOT NULL DEFAULT 1,
      approved INTEGER NOT NULL DEFAULT 0, approved_by_user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ${PROFILE_PRICING_TABLE} (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, user_id TEXT, quote_id TEXT,
      pricing_catalog_version TEXT NOT NULL, client_category TEXT NOT NULL,
      category_confidence TEXT, recommended_package_name TEXT, primary_service_key TEXT,
      subtotal_cents INTEGER NOT NULL DEFAULT 0, discount_total_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'usd',
      payment_required INTEGER NOT NULL DEFAULT 1, agreement_required INTEGER NOT NULL DEFAULT 1,
      access_status TEXT NOT NULL DEFAULT 'pending_pricing', admin_review_required INTEGER NOT NULL DEFAULT 1,
      discount_eligible INTEGER NOT NULL DEFAULT 0, discount_summary_json TEXT,
      reasons_json TEXT, missing_inputs_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX ux_profile_pricing_profile ON ${PROFILE_PRICING_TABLE}(profile_id);
    CREATE TABLE ${SERVICE_AGREEMENTS_TABLE} (
      id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT NOT NULL, quote_id TEXT,
      agreement_version TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0,
      accepted_at DATETIME, accepted_ip TEXT, accepted_user_agent TEXT,
      agreement_text_snapshot TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ${PAYMENT_EVENTS_TABLE} (
      id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, quote_id TEXT,
      event_type TEXT NOT NULL, details_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ${ADMIN_NOTIFICATIONS_TABLE} (
      id TEXT PRIMARY KEY, admin_email TEXT NOT NULL, user_id TEXT, profile_id TEXT, quote_id TEXT,
      notification_type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      delivered_at DATETIME, dismissed_at DATETIME
    );
  `)
  return db
}

test('initializeProfilePricing creates pricing, agreement, notification, and events for a new non-admin user', async () => {
  const db = createDb()
  const r = await initializeProfilePricing(db, {
    profile: { id: 'p1', display_name: 'Acme Nonprofit', primary_type: 'small_org' },
    intakeAnswers: { wants_research_only: true, annual_budget: 80_000 },
    user: { id: 'u1', email: 'jane@example.com', is_admin: false },
    source: 'manual_profile',
  })

  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.ok(r.profile_pricing_id)
  assert.ok(r.quote_id)
  assert.ok(r.agreement_id)
  assert.ok(r.admin_notification_id)
  assert.equal(r.access_status, ACCESS_STATUS.PENDING_AGREEMENT)

  const pp = await getProfilePricing(db, 'p1')
  assert.ok(pp, 'profile_pricing row should exist')
  assert.equal(pp.access_status, ACCESS_STATUS.PENDING_AGREEMENT)
  assert.ok(pp.recommended_package_name)
  assert.ok(pp.primary_service_key)
  assert.ok(pp.total_cents > 0, 'total_cents must reflect quote total')

  const notifs = db.prepare(`SELECT * FROM ${ADMIN_NOTIFICATIONS_TABLE}`).all()
  assert.equal(notifs.length, 1)
  assert.equal(notifs[0].admin_email, adminNotificationEmail())
  assert.equal(notifs[0].notification_type, ADMIN_NOTIFICATION_TYPE.NEW_USER_PRICING)
  assert.equal(notifs[0].profile_id, 'p1')
  assert.equal(notifs[0].status, 'queued')

  const events = db.prepare(`SELECT * FROM ${PAYMENT_EVENTS_TABLE} ORDER BY created_at`).all()
  const eventTypes = events.map((e) => e.event_type)
  assert.ok(eventTypes.includes(PAYMENT_ACCESS_EVENT.PRICING_CREATED))
  assert.ok(eventTypes.includes(PAYMENT_ACCESS_EVENT.ADMIN_NOTIFIED))

  const agreement = db.prepare(`SELECT * FROM ${SERVICE_AGREEMENTS_TABLE} WHERE profile_id = ?`).get('p1')
  assert.ok(agreement)
  assert.equal(agreement.accepted, 0)
})

test('initializeProfilePricing is idempotent for the same profile_id', async () => {
  const db = createDb()
  const a = await initializeProfilePricing(db, {
    profile: { id: 'p1', display_name: 'A', primary_type: 'individual' },
    user: { id: 'u1', email: 'a@example.com', is_admin: false },
  })
  const b = await initializeProfilePricing(db, {
    profile: { id: 'p1', display_name: 'A', primary_type: 'individual' },
    user: { id: 'u1', email: 'a@example.com', is_admin: false },
  })
  assert.equal(a.created, true)
  assert.equal(b.created, false, 'second call must update, not insert')
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${PROFILE_PRICING_TABLE}`).get()
  assert.equal(rows.n, 1)
})

test('admin profile is automatically waived and gets no admin notification', async () => {
  const db = createDb()
  const r = await initializeProfilePricing(db, {
    profile: { id: 'admin1', display_name: 'Admin', primary_type: 'individual' },
    user: { id: 'admin', email: 'owner@example.invalid', is_admin: true },
  })
  assert.equal(r.ok, true)
  assert.equal(r.access_status, ACCESS_STATUS.ADMIN_WAIVED)
  assert.equal(r.admin_notification_id, null)
  const notifs = db.prepare(`SELECT * FROM ${ADMIN_NOTIFICATIONS_TABLE}`).all()
  assert.equal(notifs.length, 0)
})

test('adminWaiveProfile flips access_status and records an event', async () => {
  const db = createDb()
  await initializeProfilePricing(db, {
    profile: { id: 'p1', display_name: 'A', primary_type: 'individual' },
    user: { id: 'u1', email: 'a@example.com', is_admin: false },
  })
  const r = await adminWaiveProfile(db, 'p1', { actor: { email: 'owner@example.invalid' } })
  assert.equal(r.ok, true)
  assert.equal(r.access_status, ACCESS_STATUS.ADMIN_WAIVED)
  const pp = await getProfilePricing(db, 'p1')
  assert.equal(pp.access_status, ACCESS_STATUS.ADMIN_WAIVED)
  const events = db.prepare(`SELECT * FROM ${PAYMENT_EVENTS_TABLE} WHERE event_type = ?`).all(PAYMENT_ACCESS_EVENT.ADMIN_WAIVED)
  assert.equal(events.length, 1)
})

test('graceful degradation when access-gate tables are missing', async () => {
  const db = new Database(':memory:')
  // Only the pricing_quote tables; intentionally NO profile_pricing.
  db.exec(`
    CREATE TABLE pricing_quotes (
      id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, intake_session_id TEXT,
      pricing_catalog_version TEXT, client_category TEXT, category_confidence TEXT,
      recommended_package_name TEXT, subtotal REAL, discount_total REAL, total REAL,
      currency TEXT, payment_terms_json TEXT, admin_review_required INTEGER,
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
  `)
  const r = await initializeProfilePricing(db, {
    profile: { id: 'p1' },
    user: { id: 'u1', email: 'a@example.com' },
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'pricing_tables_not_installed')
})
