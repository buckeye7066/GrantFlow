import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

process.env.PRICING_REQUIRE_ADMIN_APPROVAL = 'false'

import {
  initializeProfilePricing,
} from '../../backend/services/pricing/profilePricingInitializer.js'
import {
  getAccessStatus,
  acceptAgreement,
  markPaid,
  isAlwaysAllowedPath,
  isPaymentGatedPath,
  ALWAYS_ALLOWED_ROUTES,
  PAYMENT_GATED_ROUTES,
} from '../../backend/services/pricing/pricingAccessGate.js'
import { ACCESS_STATUS } from '../../backend/services/pricing/pricingTypes.js'
import { deriveGateFindings } from '../../backend/services/pricing/samPricingGateAuditor.js'

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

const ADMIN = { id: 'admin', email: 'owner@example.invalid', is_admin: true }
const USER = { id: 'u1', email: 'jane@example.com', is_admin: false }
const ADMIN_PRINCIPAL = { userId: ADMIN.id, identityResolved: true, isAdmin: true }
const USER_PRINCIPAL = { userId: USER.id, identityResolved: true, isAdmin: false }

test('PricingRequired and AnyaOnboarding are always allowed; Pipeline is gated', () => {
  for (const p of ['/login', '/AnyaOnboarding', '/AnyaOnboarding/q-2', '/PricingRequired', '/ServiceAgreement', '/Checkout', '/Admin', '/Admin/Pricing', '/Pricing', '/services?purchase_id=abc']) {
    assert.equal(isAlwaysAllowedPath(p), true, p)
    assert.equal(isPaymentGatedPath(p), false, p)
  }
  for (const p of ['/Dashboard', '/Pipeline', '/Documents', '/Apply', '/DiscoverGrants', '/FundingOpportunities', '/Reports']) {
    assert.equal(isPaymentGatedPath(p), true, p)
    assert.equal(isAlwaysAllowedPath(p), false, p)
  }
})

test('the spec-mandated allow-list and gate-list are non-overlapping', () => {
  for (const a of ALWAYS_ALLOWED_ROUTES) {
    for (const g of PAYMENT_GATED_ROUTES) {
      assert.notEqual(a, g, `${a} must not be in both lists`)
    }
  }
})

test('getAccessStatus blocks new unpaid user, allows admin', async () => {
  const db = createDb()
  await initializeProfilePricing(db, {
    profile: { id: 'p1', display_name: 'A', primary_type: 'individual' },
    intakeAnswers: { wants_research_only: true },
    user: USER,
  })
  const userStatus = await getAccessStatus(db, { principal: USER_PRINCIPAL, profileId: 'p1' })
  assert.equal(userStatus.access_granted, false)
  assert.equal(userStatus.blocking_reason, 'agreement_required')

  const adminStatus = await getAccessStatus(db, { principal: ADMIN_PRINCIPAL, profileId: 'p1' })
  assert.equal(adminStatus.access_granted, true)
  assert.equal(adminStatus.is_admin, true)
})

test('agreement acceptance flips status from PENDING_AGREEMENT to PENDING_PAYMENT', async () => {
  const db = createDb()
  await initializeProfilePricing(db, {
    profile: { id: 'p1', display_name: 'A', primary_type: 'individual' },
    intakeAnswers: { wants_research_only: true },
    user: USER,
  })
  await acceptAgreement(db, { profileId: 'p1', userId: USER.id, ip: '127.0.0.1', userAgent: 'test' })
  const status = await getAccessStatus(db, { principal: USER_PRINCIPAL, profileId: 'p1' })
  assert.equal(status.access_status, ACCESS_STATUS.PENDING_PAYMENT)
  assert.equal(status.checkout_available, true)
  assert.equal(status.access_granted, false)
})

test('markPaid flips status to ACTIVE_PAID and grants access', async () => {
  const db = createDb()
  await initializeProfilePricing(db, {
    profile: { id: 'p1', display_name: 'A', primary_type: 'individual' },
    intakeAnswers: { wants_research_only: true },
    user: USER,
  })
  await markPaid(db, { profileId: 'p1' })
  const status = await getAccessStatus(db, { principal: USER_PRINCIPAL, profileId: 'p1' })
  assert.equal(status.access_status, ACCESS_STATUS.ACTIVE_PAID)
  assert.equal(status.access_granted, true)
})

test('Sam: deriveGateFindings flags missing pricing', () => {
  const findings = deriveGateFindings({
    profile: { id: 'p9' },
    profilePricing: null,
  })
  assert.ok(findings.some((f) => f.category === 'profile_missing_pricing'))
})

test('Sam: deriveGateFindings flags admin blocked', () => {
  const findings = deriveGateFindings({
    profile: { id: 'p1' },
    profilePricing: { access_status: ACCESS_STATUS.PENDING_PAYMENT, subtotal_cents: 1000, discount_total_cents: 0, total_cents: 1000, pricing_catalog_version: '2026-06-15' },
    user: { email: 'owner@example.invalid', is_admin: true },
  })
  assert.ok(findings.some((f) => f.category === 'admin_blocked_by_payment_gate'))
})

test('Sam: deriveGateFindings flags total mismatch', () => {
  const findings = deriveGateFindings({
    profile: { id: 'p1' },
    profilePricing: {
      access_status: ACCESS_STATUS.PENDING_AGREEMENT,
      subtotal_cents: 1000,
      discount_total_cents: 100,
      total_cents: 1234,
      pricing_catalog_version: '2026-06-15',
    },
    user: { email: 'jane@example.com' },
    notifications: [{ admin_email: 'owner@example.invalid', notification_type: 'new_user_pricing', profile_id: 'p1' }],
  })
  assert.ok(findings.some((f) => f.category === 'profile_pricing_total_mismatch'))
})

test('Sam: deriveGateFindings flags wrong admin notification target', () => {
  const findings = deriveGateFindings({
    profile: { id: 'p1' },
    profilePricing: {
      access_status: ACCESS_STATUS.PENDING_AGREEMENT,
      subtotal_cents: 100,
      discount_total_cents: 0,
      total_cents: 100,
      pricing_catalog_version: '2026-06-15',
    },
    user: { email: 'jane@example.com' },
    notifications: [
      { id: 'n1', admin_email: 'attacker@example.com', notification_type: 'new_user_pricing', profile_id: 'p1' },
    ],
  })
  assert.ok(findings.some((f) => f.category === 'wrong_admin_notification_target'))
})

test('Sam: deriveGateFindings flags missing admin notification', () => {
  const findings = deriveGateFindings({
    profile: { id: 'p1' },
    profilePricing: {
      access_status: ACCESS_STATUS.PENDING_AGREEMENT,
      subtotal_cents: 100,
      discount_total_cents: 0,
      total_cents: 100,
      pricing_catalog_version: '2026-06-15',
      created_at: new Date().toISOString(),
    },
    user: { email: 'jane@example.com' },
    notifications: [],
  })
  assert.ok(findings.some((f) => f.category === 'admin_notification_missing'))
})
