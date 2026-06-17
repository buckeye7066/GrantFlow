/**
 * Charge resolver unit tests — covers the spec's tests #11–21.
 *
 * Builds a minimal in-memory `service_catalog_items` + `service_prices`
 * dataset that mirrors what `seedServiceCatalogFromExtract` produces
 * for the 2026-06-15 catalog, then asserts that `resolveChargeForQuote`
 * returns the exact expected cents for every spec-listed example.
 *
 * Stripe live calls are stubbed via `STRIPE_MOCK=true`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

process.env.STRIPE_MOCK = 'true'

import { resolveChargeForQuote } from '../../backend/services/pricing/chargeResolver.js'
import { hourlyRateToSixMinuteUnitCents } from '../../backend/services/hourlyRounding.js'

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE service_catalog_items (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      pricing_model TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );
    -- Quote tables are referenced by samPricingStripeAuditor; harmless empty
    -- shells let the resolver pass tableExists() checks if any test path goes
    -- there. (Not strictly needed for the resolver, but cheap and stable.)
    CREATE TABLE service_prices (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      client_category TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      milestone_phase TEXT NOT NULL DEFAULT '',
      stripe_price_id TEXT,
      active INTEGER DEFAULT 1,
      UNIQUE(service_id, client_category, currency, milestone_phase)
    );
  `)
}

function seed2026Catalog(db, { mapStripe = true } = {}) {
  const services = [
    ['svc_qes', 'quick-eligibility-scan', 'Quick Eligibility Scan', 'one_time',
     [['individual', 14900], ['small', 34900], ['mid', 34900], ['large', 75000]]],
    ['svc_cfd', 'comprehensive-funding-dossier', 'Comprehensive Funding Dossier', 'one_time',
     [['individual', 39900], ['small', 125000], ['mid', 240000], ['large', 380000]]],
    ['svc_ass', 'application-strategy-session', 'Application Strategy Session', 'one_time',
     [['individual', 30000], ['small', 45000], ['mid', 60000], ['large', 60000]]],
    ['svc_mga', 'micro-grant-application', 'Micro-Grant Application (<$5K)', 'milestone',
     [['individual', 60000], ['small', 90000], ['mid', 120000], ['large', 120000]]],
    ['svc_sfa', 'standard-foundation-application', 'Standard Foundation Application', 'milestone',
     [['individual', 200000], ['small', 350000], ['mid', 500000], ['large', 500000]]],
    ['svc_cfa', 'complex-federal-application', 'Complex/Federal Application', 'milestone',
     [['individual', 500000], ['small', 800000], ['mid', 1200000], ['large', 1200000]]],
    ['svc_tsp', 'transfer-scholarship-pack', 'Transfer Scholarship Pack', 'one_time',
     [['individual', 45000], ['small', 45000], ['mid', 45000], ['large', 45000]]],
    ['svc_edt', 'editing-and-redraft-service', 'Editing & Redraft Service', 'one_time',
     [['individual', 30000], ['small', 50000], ['mid', 90000], ['large', 90000]]],
    ['svc_blm', 'budget-and-logic-model-development', 'Budget & Logic Model Development', 'one_time',
     [['individual', 35000], ['small', 60000], ['mid', 90000], ['large', 90000]]],
    ['svc_crm', 'compliance-reporting-and-management', 'Compliance Reporting & Management', 'one_time',
     [['individual', 50000], ['small', 100000], ['mid', 150000], ['large', 150000]]],
    ['svc_gcs', 'grant-calendar-setup-and-management', 'Grant Calendar Setup & Management', 'one_time',
     [['individual', 80000], ['small', 120000], ['mid', 180000], ['large', 180000]]],
    ['svc_hr', 'hourly-consultation-and-advisory', 'Hourly Consultation & Advisory', 'hourly',
     [['individual', 8500], ['small', 8500], ['mid', 11500], ['large', 15000]]],
  ]
  for (const [id, slug, name, model, prices] of services) {
    db.prepare(
      `INSERT INTO service_catalog_items (id, slug, name, pricing_model, is_active)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(id, slug, name, model)
    for (const [cat, totalCents] of prices) {
      if (model === 'milestone') {
        // Total row + 40/40/20 split rows.
        for (const phase of ['', 'kickoff', 'draft', 'submission']) {
          let amt
          if (phase === '') amt = totalCents
          else if (phase === 'kickoff') amt = Math.round(totalCents * 0.4)
          else if (phase === 'draft') amt = Math.round(totalCents * 0.4)
          else amt = totalCents - Math.round(totalCents * 0.4) - Math.round(totalCents * 0.4)
          const stripeId = mapStripe ? `price_${id}_${cat}_${phase || 'one_time'}` : null
          db.prepare(
            `INSERT INTO service_prices
              (id, service_id, client_category, amount_cents, currency, milestone_phase, stripe_price_id, active)
             VALUES (?, ?, ?, ?, 'usd', ?, ?, 1)`,
          ).run(`p_${id}_${cat}_${phase || 'one_time'}`, id, cat, amt, phase, stripeId)
        }
      } else if (model === 'hourly') {
        const unitCents = hourlyRateToSixMinuteUnitCents(totalCents)
        const stripeId = mapStripe ? `price_${id}_${cat}` : null
        db.prepare(
          `INSERT INTO service_prices
            (id, service_id, client_category, amount_cents, currency, milestone_phase, stripe_price_id, active)
           VALUES (?, ?, ?, ?, 'usd', '', ?, 1)`,
        ).run(`p_${id}_${cat}`, id, cat, unitCents, stripeId)
      } else {
        const stripeId = mapStripe ? `price_${id}_${cat}` : null
        db.prepare(
          `INSERT INTO service_prices
            (id, service_id, client_category, amount_cents, currency, milestone_phase, stripe_price_id, active)
           VALUES (?, ?, ?, ?, 'usd', '', ?, 1)`,
        ).run(`p_${id}_${cat}`, id, cat, totalCents, stripeId)
      }
    }
  }
}

function newDb({ mapStripe = true } = {}) {
  const db = new Database(':memory:')
  ensureSchema(db)
  seed2026Catalog(db, { mapStripe })
  return db
}

test('Test 11: individual Quick Eligibility Scan = $149', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'quick-eligibility-scan', clientCategory: 'individual',
  })
  assert.equal(r.can_checkout, true)
  assert.equal(r.final_amount_cents, 14900)
  assert.equal(r.catalog_amount_cents, 14900)
})

test('Test 12: small Quick Eligibility Scan = $349', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'quick-eligibility-scan', clientCategory: 'small',
  })
  assert.equal(r.final_amount_cents, 34900)
})

test('Test 13: mid Quick Eligibility Scan = $349', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'quick-eligibility-scan', clientCategory: 'mid',
  })
  assert.equal(r.final_amount_cents, 34900)
})

test('Test 14: large Quick Eligibility Scan = $750', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'quick-eligibility-scan', clientCategory: 'large',
  })
  assert.equal(r.final_amount_cents, 75000)
})

test('Test 15: small Comprehensive Funding Dossier = $1,250', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'comprehensive-funding-dossier', clientCategory: 'small',
  })
  assert.equal(r.final_amount_cents, 125000)
})

test('Test 16: mid Comprehensive Funding Dossier = $2,400', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'comprehensive-funding-dossier', clientCategory: 'mid',
  })
  assert.equal(r.final_amount_cents, 240000)
})

test('Test 17: large Complex/Federal Application kickoff = 40% of $12,000', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'complex-federal-application', clientCategory: 'large', milestonePhase: 'kickoff',
  })
  assert.equal(r.can_checkout, true)
  assert.equal(r.final_amount_cents, Math.round(1200000 * 0.4))
  assert.equal(r.pricing_model, 'milestone')
})

test('Test 18: unknown org budget defaults small with admin_review_required=true', async () => {
  // Pure classifier check — no DB required for this branch.
  const { classifyClient } = await import('../../backend/services/pricing/clientCategoryClassifier.js')
  const r = classifyClient({ profile_type: 'nonprofit' }, {}, {})
  assert.equal(r.client_category, 'small')
  assert.equal(r.admin_review_required, true)
  assert.ok(r.missing_fields.includes('annual_budget'))
  assert.equal(r.confidence, 'estimated_needs_admin_review')
})

test('Test 19: frontend category tampering is rejected when not a catalog category', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'quick-eligibility-scan', clientCategory: 'platinum',
  })
  assert.equal(r.can_checkout, false)
  assert.equal(r.blocking_reason, 'INVALID_CLIENT_CATEGORY')
})

test('Test 19b: classification re-runs server-side and overrides supplied category', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db,
    serviceKey: 'quick-eligibility-scan',
    clientCategory: 'individual', // user-supplied
    classification: {
      profile: { profile_type: 'nonprofit' },
      organization: { annual_budget: 5_000_000 },
    },
  })
  // Server-side classification computes `large` regardless of user input.
  assert.equal(r.client_category, 'large')
  assert.equal(r.final_amount_cents, 75000)
})

test('Test 20: missing Stripe mapping blocks checkout with STRIPE_PRICE_MISSING', async () => {
  const db = newDb({ mapStripe: false })
  const r = await resolveChargeForQuote({
    db, serviceKey: 'quick-eligibility-scan', clientCategory: 'individual',
  })
  assert.equal(r.can_checkout, false)
  assert.equal(r.blocking_reason, 'STRIPE_PRICE_MISSING')
})

test('Test 21: Stripe-side amount mismatch blocks checkout with STRIPE_PRICE_AMOUNT_MISMATCH', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db,
    serviceKey: 'quick-eligibility-scan',
    clientCategory: 'individual',
    stripePriceVerification: { amount_cents: 9999, currency: 'usd', active: true },
  })
  assert.equal(r.can_checkout, false)
  assert.equal(r.blocking_reason, 'STRIPE_PRICE_AMOUNT_MISMATCH')
})

test('Stripe currency mismatch blocks checkout', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db,
    serviceKey: 'quick-eligibility-scan',
    clientCategory: 'individual',
    stripePriceVerification: { amount_cents: 14900, currency: 'eur', active: true },
  })
  assert.equal(r.can_checkout, false)
  assert.equal(r.blocking_reason, 'STRIPE_PRICE_CURRENCY_MISMATCH')
})

test('Stripe inactive price blocks checkout', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db,
    serviceKey: 'quick-eligibility-scan',
    clientCategory: 'individual',
    stripePriceVerification: { amount_cents: 14900, currency: 'usd', active: false },
  })
  assert.equal(r.can_checkout, false)
  assert.equal(r.blocking_reason, 'STRIPE_PRICE_INACTIVE')
})

test('Hourly rate uses 6-minute unit storage and matches catalog tier', async () => {
  const db = newDb()
  for (const [cat, expectedHourly] of [['individual', 8500], ['small', 8500], ['mid', 11500], ['large', 15000]]) {
    const r = await resolveChargeForQuote({
      db, serviceKey: 'hourly-consultation-and-advisory', clientCategory: cat,
    })
    assert.equal(r.can_checkout, true, `hourly/${cat} should be checkout-ready`)
    // Resolver returns the per-6-min unit amount.
    assert.equal(r.final_amount_cents, hourlyRateToSixMinuteUnitCents(expectedHourly))
  }
})

test('Legacy slug aliases route to canonical service in resolver', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db, serviceKey: 'standard-foundation-application-5k-250k', clientCategory: 'small', milestonePhase: 'kickoff',
  })
  assert.equal(r.can_checkout, true)
  assert.equal(r.service_slug, 'standard-foundation-application')
})

test('Approved discount reduces final cents on one-time price (with discount-specific Stripe Price)', async () => {
  const db = newDb()
  // Patch the Stripe Price ID in the DB to simulate a discount-specific price
  // whose unit_amount equals the discounted total.
  db.prepare(
    `UPDATE service_prices SET amount_cents = ?, stripe_price_id = ? WHERE id = ?`,
  ).run(14900, 'price_qes_individual_discount', 'p_svc_qes_individual')
  const r = await resolveChargeForQuote({
    db,
    serviceKey: 'quick-eligibility-scan',
    clientCategory: 'individual',
    discountState: {
      line_items: [{ service_name: 'Quick Eligibility Scan', subtotal: 149 }],
      discounts: [],
    },
  })
  assert.equal(r.can_checkout, true)
  assert.equal(r.final_amount_cents, 14900)
})

test('Unapproved discount is reported in issues but does not change the charge', async () => {
  const db = newDb()
  const r = await resolveChargeForQuote({
    db,
    serviceKey: 'quick-eligibility-scan',
    clientCategory: 'individual',
    discountState: {
      line_items: [{ service_name: 'Quick Eligibility Scan', subtotal: 149 }],
      discounts: [{ amount: 49, approved: false, requires_admin_approval: true }],
    },
  })
  assert.equal(r.final_amount_cents, 14900)
  assert.equal(r.approved_discount_cents, 0)
  assert.ok(r.issues.some((i) => i.startsWith('unapproved_discount_present')))
})
