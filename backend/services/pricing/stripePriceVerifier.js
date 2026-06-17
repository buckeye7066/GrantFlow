/**
 * Stripe Price verifier.
 *
 * Walks every active `service_prices` row and confirms that the Stripe
 * Price ID configured by the operator (`stripe_price_id`) matches the
 * `amount_cents` and `currency` stored in our database. Drift here is a
 * Sam-critical finding because it means a Stripe checkout would charge
 * the user a different price than the catalog/quote shows.
 *
 * Behaviour:
 *   - When `STRIPE_MOCK=true` the verifier does NOT make network calls.
 *     Mocked Stripe Prices are deterministic: the unit amount and
 *     currency are derived from the DB row itself, so the verifier
 *     always returns "ok" except for rows that genuinely have no
 *     mapping. This is what unit tests rely on.
 *   - In production, we call `stripe.prices.retrieve(priceId)` once per
 *     unique Stripe Price ID. Results are cached for the duration of
 *     a single audit pass.
 *   - Rows without `stripe_price_id` are reported as "missing_mapping".
 *   - Rows whose Stripe Price returned a different `unit_amount` or
 *     `currency` are reported as "amount_mismatch" or "currency_mismatch".
 *   - Inactive Stripe Prices are reported as "inactive".
 *
 * The verifier never throws on a single row failure; it always returns
 * a structured report so admin dashboards / audit logs can surface every
 * issue.
 */

import Stripe from 'stripe'

function isTruthy(value) {
  const v = String(value || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on'
}

function isStripeMock() {
  return isTruthy(process.env.STRIPE_MOCK)
}

function getStripeSecretKeyOrNull() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim()
  return key || null
}

function createStripeClient() {
  const key = getStripeSecretKeyOrNull()
  if (!key) return null
  return new Stripe(key, { telemetry: false })
}

/**
 * Mock fetcher: deterministic verification used in unit tests and in
 * environments without a real Stripe connection. Returns the same
 * `unit_amount` and `currency` that the DB row claims, so all rows with
 * a stripe_price_id appear consistent. Drift can still be exercised in
 * tests by overriding the result via the optional `mockResults` map.
 *
 * @param {string} priceId
 * @param {{ amount_cents: number, currency: string }} dbRow
 * @param {Map<string, { amount_cents: number, currency: string, active: boolean }>} mockOverrides
 */
function mockFetchStripePrice(priceId, dbRow, mockOverrides) {
  if (mockOverrides && mockOverrides.has(priceId)) {
    return { ...mockOverrides.get(priceId), id: priceId }
  }
  return {
    id: priceId,
    amount_cents: Number(dbRow.amount_cents),
    currency: String(dbRow.currency || 'usd').toLowerCase(),
    active: true,
  }
}

/**
 * Live fetcher: calls `stripe.prices.retrieve` once per Price ID.
 *
 * @param {Stripe} stripe
 * @param {string} priceId
 * @returns {Promise<{ id: string, amount_cents: number|null, currency: string, active: boolean }>}
 */
async function liveFetchStripePrice(stripe, priceId) {
  try {
    const p = await stripe.prices.retrieve(priceId)
    return {
      id: p.id,
      amount_cents: typeof p.unit_amount === 'number' ? p.unit_amount : null,
      currency: String(p.currency || 'usd').toLowerCase(),
      active: Boolean(p.active),
    }
  } catch (error) {
    return {
      id: priceId,
      amount_cents: null,
      currency: 'usd',
      active: false,
      error: error?.message || String(error),
    }
  }
}

/**
 * Verify every active service_prices row against Stripe.
 *
 * @param {object} db
 * @param {{ mockOverrides?: Map<string, { amount_cents: number, currency: string, active: boolean }> }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   checked: number,
 *   missing_mapping_count: number,
 *   mismatch_count: number,
 *   inactive_count: number,
 *   rows: Array<{
 *     service_slug: string,
 *     service_name: string,
 *     client_category: string,
 *     milestone_phase: string|null,
 *     db_amount_cents: number,
 *     stripe_price_id: string|null,
 *     stripe_amount_cents: number|null,
 *     currency: string,
 *     status: string,
 *     detail?: string|null,
 *   }>
 * }>}
 */
export async function verifyStripePriceMapping(db, { mockOverrides = null } = {}) {
  const rows = await db
    .prepare(
      `SELECT sci.slug AS service_slug,
              sci.name AS service_name,
              sci.pricing_model,
              sp.id AS service_price_id,
              sp.client_category,
              sp.amount_cents,
              sp.currency,
              sp.milestone_phase,
              sp.stripe_price_id,
              sp.active
         FROM service_catalog_items sci
         JOIN service_prices sp ON sp.service_id = sci.id
        WHERE sci.is_active = 1 AND sp.active = 1
        ORDER BY sci.name, sp.client_category, sp.milestone_phase`,
    )
    .all()

  const useMock = isStripeMock()
  const stripe = useMock ? null : createStripeClient()
  const cache = new Map()

  let missing = 0
  let mismatch = 0
  let inactive = 0
  const out = []

  for (const r of rows || []) {
    const dbAmt = Number(r.amount_cents)
    const dbCurrency = String(r.currency || 'usd').toLowerCase()
    const baseRow = {
      service_slug: String(r.service_slug),
      service_name: String(r.service_name),
      client_category: String(r.client_category),
      milestone_phase: r.milestone_phase || null,
      db_amount_cents: dbAmt,
      stripe_price_id: r.stripe_price_id ? String(r.stripe_price_id) : null,
      stripe_amount_cents: null,
      currency: dbCurrency,
      status: 'ok',
      detail: null,
    }

    if (!r.stripe_price_id) {
      baseRow.status = 'missing_mapping'
      baseRow.detail = 'service_prices.stripe_price_id is not set'
      missing += 1
      out.push(baseRow)
      continue
    }

    let priceData
    if (cache.has(r.stripe_price_id)) {
      priceData = cache.get(r.stripe_price_id)
    } else if (useMock) {
      priceData = mockFetchStripePrice(r.stripe_price_id, r, mockOverrides)
      cache.set(r.stripe_price_id, priceData)
    } else if (!stripe) {
      baseRow.status = 'verifier_unavailable'
      baseRow.detail = 'STRIPE_SECRET_KEY missing and STRIPE_MOCK is not enabled'
      out.push(baseRow)
      continue
    } else {
      priceData = await liveFetchStripePrice(stripe, String(r.stripe_price_id))
      cache.set(r.stripe_price_id, priceData)
    }

    baseRow.stripe_amount_cents = priceData.amount_cents

    if (priceData?.error) {
      baseRow.status = 'fetch_error'
      baseRow.detail = priceData.error
    } else if (priceData.active === false) {
      baseRow.status = 'inactive'
      baseRow.detail = 'Stripe price is no longer active'
      inactive += 1
    } else if (priceData.amount_cents === null || priceData.amount_cents === undefined || Number(priceData.amount_cents) !== dbAmt) {
      baseRow.status = 'amount_mismatch'
      baseRow.detail = `stripe.unit_amount=${priceData.amount_cents} db.amount_cents=${dbAmt}`
      mismatch += 1
    } else if (String(priceData.currency || 'usd').toLowerCase() !== dbCurrency) {
      baseRow.status = 'currency_mismatch'
      baseRow.detail = `stripe.currency=${priceData.currency} db.currency=${dbCurrency}`
      mismatch += 1
    }

    out.push(baseRow)
  }

  return {
    ok: missing === 0 && mismatch === 0 && inactive === 0,
    checked: out.length,
    missing_mapping_count: missing,
    mismatch_count: mismatch,
    inactive_count: inactive,
    rows: out,
  }
}

/**
 * Convenience wrapper used by `chargeResolver` to verify a single Price ID.
 * Returns `{ amount_cents, currency, active }` or `null` when unavailable.
 *
 * @param {string} priceId
 */
export async function verifyStripePrice(priceId, { mockOverrides = null } = {}) {
  if (!priceId) return null
  if (isStripeMock()) {
    return mockFetchStripePrice(priceId, { amount_cents: null, currency: 'usd' }, mockOverrides)
  }
  const stripe = createStripeClient()
  if (!stripe) return null
  return liveFetchStripePrice(stripe, String(priceId))
}

export default {
  verifyStripePriceMapping,
  verifyStripePrice,
}
