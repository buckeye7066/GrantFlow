import express from 'express'
import crypto from 'node:crypto'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { ensureServiceCatalogSchema, MILESTONE_PHASES } from '../services/serviceCatalogStore.js'
import { createCheckoutSessionForPrice, getOrCreateStripeCustomerId } from '../services/stripeService.js'
import { roundBillableMinutes } from '../services/hourlyRounding.js'
import { resolveChargeForQuote } from '../services/pricing/chargeResolver.js'
import { getQuote } from '../services/pricing/quoteBuilder.js'
import { PRICING_CATALOG_VERSION } from '../services/pricing/pricingTypes.js'
import { markInvoicePaid } from '../services/billing/invoiceService.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:stripe')

const router = express.Router()

/**
 * Stripe webhook → flips an invoice to PAID (and lifts any suspension) when
 * Stripe reports payment. Dormant until STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
 * are configured. NOTE: for signature verification this route must receive the
 * RAW request body (mount express.raw on this path in server.js before the JSON
 * parser); until Stripe is wired we accept the parsed body and skip verification.
 * Payment → invoice mapping uses Stripe metadata.profile_id / the stripe invoice id.
 */
router.post('/webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  // HARD REQUIREMENT: never act on an unverified event. We require the secret
  // key, the webhook signing secret, AND a raw (Buffer) body (mount
  // express.raw on this path before the JSON parser). No signature, no action —
  // this prevents a forged invoice.paid from faking payment / lifting suspension.
  if (!process.env.STRIPE_SECRET_KEY || !secret) {
    return res.status(503).json({ ok: false, error: 'webhook_not_configured' })
  }
  if (!Buffer.isBuffer(req.body)) {
    routeLogger.warn('stripe webhook rejected: body not raw (mount express.raw on /api/stripe/webhook)')
    return res.status(400).json({ ok: false, error: 'raw_body_required' })
  }
  let event
  try {
    const { default: Stripe } = await import('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret)
  } catch (err) {
    routeLogger.warn('stripe webhook signature verification failed', { error: err?.message })
    return res.status(400).json({ ok: false, error: 'invalid_signature' })
  }
  try {
    const obj = event?.data?.object || {}
    const profileId = obj?.metadata?.profile_id || null
    const stripeInvoiceId = obj?.invoice || obj?.id || null
    if (['invoice.paid', 'checkout.session.completed', 'payment_intent.succeeded'].includes(event?.type)) {
      await markInvoicePaid(req.db, { profileId, stripeInvoiceId, source: 'stripe_webhook' })
    }
    return res.json({ received: true })
  } catch (err) {
    routeLogger.warn('stripe webhook handler failed', { error: err?.message })
    return res.status(400).json({ ok: false, error: 'webhook_error' })
  }
})

function getPublicAppUrl() {
  // Prefer the same envs used by auth flows.
  const raw =
    process.env.AUTH_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    'http://localhost:5173/grantflow'
  return String(raw).replace(/\/+$/, '')
}

function buildSuccessUrl(purchaseId) {
  // We route users back to /services; UI can fetch purchases and show status.
  return `${getPublicAppUrl()}/services?purchase_id=${encodeURIComponent(String(purchaseId))}&status=success`
}

function buildCancelUrl(purchaseId) {
  return `${getPublicAppUrl()}/services?purchase_id=${encodeURIComponent(String(purchaseId))}&status=cancel`
}

router.post('/checkout/service', ensureAuth, async (req, res) => {
  await ensureServiceCatalogSchema(req.db)

  const body = req.body ?? {}
  const purchaseId = typeof body.purchase_id === 'string' ? body.purchase_id.trim() : ''
  const phase = (body.milestone_phase !== null && body.milestone_phase !== undefined) ? String(body.milestone_phase).trim() : null
  const agree = body.agree === true
  const explicitQuoteId = typeof body.quote_id === 'string' ? body.quote_id.trim() : ''

  if (!agree) {
    return res.status(400).json({ ok: false, error: 'terms_not_accepted', code: 'TERMS_REQUIRED' })
  }
  if (!purchaseId) return res.status(400).json({ ok: false, error: 'purchase_id required' })

  const userId = req.ctx?.userId ?? req.user?.userId
  if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' })

  const purchase = await req.db
    .prepare(
      `
        SELECT sp.*, sci.slug AS service_slug
        FROM service_purchases sp
        JOIN service_catalog_items sci ON sci.id = sp.service_id
        WHERE sp.id = ?
        LIMIT 1
      `,
    )
    .get(purchaseId)

  if (!purchase) return res.status(404).json({ ok: false, error: 'purchase not found' })
  if (String(purchase.user_id) !== String(userId)) return res.status(403).json({ ok: false, error: 'Not authorized' })

  const pricingModel = String(purchase.pricing_model)
  const clientCategory = String(purchase.client_category)

  // Milestone ordering enforcement still happens here because it depends on
  // the database state of milestone_payments; the chargeResolver covers
  // service / category / phase price math, not flow-of-payment ordering.
  if (pricingModel === 'milestone') {
    if (!phase) return res.status(400).json({ ok: false, error: 'milestone_phase required' })
    if (!MILESTONE_PHASES.includes(phase)) return res.status(400).json({ ok: false, error: 'invalid milestone_phase' })

    const milestones = await req.db
      .prepare('SELECT phase, status FROM milestone_payments WHERE purchase_id = ? ORDER BY phase ASC')
      .all(purchaseId)
    if (!milestones || milestones.length === 0) {
      return res.status(409).json({ ok: false, error: 'milestone_payments_not_initialized', code: 'MILESTONE_NOT_SETUP' })
    }
    const firstUnpaid = MILESTONE_PHASES.find((p) => milestones.find((m) => m.phase === p)?.status !== 'paid') || null
    if (firstUnpaid !== phase) {
      return res.status(409).json({
        ok: false,
        error: 'milestone_out_of_order',
        code: 'MILESTONE_ORDER',
        allowed_next_phase: firstUnpaid,
      })
    }
  } else if (pricingModel !== 'one_time') {
    return res.status(400).json({ ok: false, error: 'unsupported pricing_model for this endpoint' })
  }

  // Resolve the quote so the resolver can apply approved discounts. We tie a
  // checkout to the most recent quote on the same profile/service when the
  // request body doesn't specify `quote_id`.
  let quote = null
  let quoteIdResolved = explicitQuoteId || null
  try {
    if (explicitQuoteId) {
      quote = await getQuote(req.db, explicitQuoteId)
    } else if (purchase.profile_id) {
      const latest = await req.db
        .prepare(
          `SELECT id FROM pricing_quotes
            WHERE profile_id = ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(String(purchase.profile_id))
      if (latest?.id) {
        quoteIdResolved = String(latest.id)
        quote = await getQuote(req.db, quoteIdResolved)
      }
    }
  } catch (err) {
    routeLogger.warn('checkout: failed to load latest quote', { purchaseId, error: err?.message })
  }

  // Single source of truth: chargeResolver decides the price and Stripe ID.
  const charge = await resolveChargeForQuote({
    db: req.db,
    quoteId: quoteIdResolved,
    profileId: purchase.profile_id ? String(purchase.profile_id) : null,
    userId: String(userId),
    serviceKey: String(purchase.service_slug),
    clientCategory,
    milestonePhase: pricingModel === 'milestone' ? phase : null,
    discountState: quote
      ? { line_items: quote.line_items, discounts: quote.discounts }
      : null,
  })

  if (!charge.can_checkout) {
    const reason = charge.blocking_reason || 'CHECKOUT_BLOCKED'
    routeLogger.warn('checkout blocked by resolver', { purchaseId, reason, issues: charge.issues })
    const httpStatus =
      reason === 'STRIPE_PRICE_MISSING' ||
      reason === 'STRIPE_PRICE_AMOUNT_MISMATCH' ||
      reason === 'STRIPE_PRICE_CURRENCY_MISMATCH' ||
      reason === 'STRIPE_PRICE_INACTIVE' ||
      reason === 'DB_PRICE_CATALOG_DRIFT' ||
      reason === 'DISCOUNT_REQUIRES_DEDICATED_PRICE_OR_COUPON'
        ? 409
        : 400
    return res.status(httpStatus).json({
      ok: false,
      error: 'checkout_blocked',
      code: reason,
      charge_resolution: charge,
    })
  }

  const idempotencyKey = pricingModel === 'milestone'
    ? `purchase:${purchaseId}:phase:${phase}:v${charge.final_amount_cents}`
    : `purchase:${purchaseId}:one_time:v${charge.final_amount_cents}`

  const metadata = {
    kind: pricingModel === 'milestone' ? 'milestone_payment' : 'service_purchase',
    purchase_id: String(purchaseId),
    quote_id: quoteIdResolved || '',
    service_slug: charge.service_slug || String(purchase.service_slug),
    service_id: charge.service_id || String(purchase.service_id),
    client_category: charge.client_category || clientCategory,
    pricing_model: pricingModel,
    milestone_phase: pricingModel === 'milestone' ? String(phase) : '',
    catalog_version: PRICING_CATALOG_VERSION,
    catalog_amount_cents: String(charge.catalog_amount_cents),
    approved_discount_cents: String(charge.approved_discount_cents),
    final_amount_cents: String(charge.final_amount_cents),
  }

  // Stripe customer
  const customer = await getOrCreateStripeCustomerId(req.db, {
    userId,
    email: req.ctx?.email || req.user?.email || null,
    name: req.user?.full_name || null,
  })
  if (!customer?.ok) {
    return res.status(503).json({ ok: false, error: 'stripe_customer_unavailable', code: 'STRIPE_NOT_CONFIGURED' })
  }

  const session = await createCheckoutSessionForPrice({
    priceId: String(charge.stripe_price_id),
    quantity: 1,
    customerId: String(customer.stripe_customer_id),
    successUrl: buildSuccessUrl(purchaseId),
    cancelUrl: buildCancelUrl(purchaseId),
    metadata,
    idempotencyKey,
  })

  if (!session?.id || !session?.url) {
    return res.status(503).json({ ok: false, error: 'stripe_session_create_failed', code: 'STRIPE_SESSION_ERROR' })
  }

  if (pricingModel === 'milestone') {
    await req.db
      .prepare(
        `
          UPDATE milestone_payments
          SET stripe_checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE purchase_id = ? AND phase = ?
        `,
      )
      .run(String(session.id), purchaseId, phase)
  } else {
    await req.db
      .prepare(
        `
          UPDATE service_purchases
          SET stripe_checkout_session_id = ?, status = 'pending_payment', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(String(session.id), purchaseId)
  }

  return res.json({
    ok: true,
    url: session.url,
    checkout_session_id: session.id,
    charge_resolution: {
      service_slug: charge.service_slug,
      client_category: charge.client_category,
      pricing_model: charge.pricing_model,
      milestone_phase: charge.milestone_phase,
      catalog_amount_cents: charge.catalog_amount_cents,
      approved_discount_cents: charge.approved_discount_cents,
      final_amount_cents: charge.final_amount_cents,
      catalog_version: charge.catalog_version,
    },
  })
})

router.post('/checkout/hourly', ensureAuth, async (req, res) => {
  await ensureServiceCatalogSchema(req.db)
  const body = req.body ?? {}
  const purchaseId = typeof body.purchase_id === 'string' ? body.purchase_id.trim() : ''
  const agree = body.agree === true
  if (!agree) {
    return res.status(400).json({ ok: false, error: 'terms_not_accepted', code: 'TERMS_REQUIRED' })
  }
  if (!purchaseId) return res.status(400).json({ ok: false, error: 'purchase_id required' })

  const userId = req.ctx?.userId ?? req.user?.userId
  if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' })

  const purchase = await req.db
    .prepare('SELECT * FROM service_purchases WHERE id = ? LIMIT 1')
    .get(purchaseId)
  if (!purchase) return res.status(404).json({ ok: false, error: 'purchase not found' })
  if (String(purchase.user_id) !== String(userId)) return res.status(403).json({ ok: false, error: 'Not authorized' })
  if (String(purchase.pricing_model) !== 'hourly') return res.status(400).json({ ok: false, error: 'purchase is not hourly' })

  const totalRow = await req.db
    .prepare('SELECT COALESCE(SUM(rounded_minutes), 0) AS total FROM hourly_time_entries WHERE purchase_id = ?')
    .get(purchaseId)
  const totalRoundedMinutes = Number(totalRow?.total || 0)
  if (totalRoundedMinutes <= 0) {
    return res.status(409).json({ ok: false, error: 'no_billable_time', code: 'NO_TIME' })
  }

  // Ensure rounding rules were applied (defense-in-depth).
  const enforcedRounded = roundBillableMinutes(totalRoundedMinutes, { minimumMinutes: 15, incrementMinutes: 6 })
  const units = Math.ceil(enforcedRounded / 6)

  // Price row for hourly is stored as per-6-min unit
  const priceRow = await req.db
    .prepare(
      `
        SELECT stripe_price_id, amount_cents
        FROM service_prices
        WHERE service_id = ?
          AND client_category = ?
          AND COALESCE(milestone_phase, '') = ''
          AND active = 1
        LIMIT 1
      `,
    )
    .get(String(purchase.service_id), String(purchase.client_category))

  if (!priceRow?.stripe_price_id) {
    return res.status(409).json({ ok: false, error: 'stripe_price_not_mapped', code: 'STRIPE_PRICE_MISSING' })
  }

  // Deduplication: check for an existing pending invoice for this purchase to prevent duplicates.
  const existingInvoice = await req.db
    .prepare(`SELECT id FROM hourly_invoices WHERE purchase_id = ? AND status = 'pending' LIMIT 1`)
    .get(purchaseId)
  if (existingInvoice) {
    return res.status(409).json({ ok: false, error: 'invoice_already_pending', code: 'INVOICE_DUPLICATE', invoice_id: existingInvoice.id })
  }

  const invoiceId = crypto.randomUUID()
  const amountCents = Number(priceRow.amount_cents) * units
  await req.db.prepare(
    `
      INSERT INTO hourly_invoices (
        id, purchase_id, total_rounded_minutes, units, amount_cents, currency, status, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'usd', 'pending', CURRENT_TIMESTAMP
      )
    `,
  ).run(invoiceId, purchaseId, enforcedRounded, units, amountCents)

  const customer = await getOrCreateStripeCustomerId(req.db, {
    userId,
    email: req.ctx?.email || req.user?.email || null,
    name: req.user?.full_name || null,
  })
  if (!customer?.ok) {
    return res.status(503).json({ ok: false, error: 'stripe_customer_unavailable', code: 'STRIPE_NOT_CONFIGURED' })
  }

  let session
  try {
    session = await createCheckoutSessionForPrice({
      priceId: String(priceRow.stripe_price_id),
      quantity: units,
      customerId: String(customer.stripe_customer_id),
      successUrl: buildSuccessUrl(purchaseId),
      cancelUrl: buildCancelUrl(purchaseId),
      metadata: {
        kind: 'hourly_invoice',
        purchase_id: String(purchaseId),
        hourly_invoice_id: String(invoiceId),
        units: String(units),
        client_category: String(purchase.client_category),
        pricing_model: 'hourly',
        catalog_version: PRICING_CATALOG_VERSION,
        unit_amount_cents: String(Number(priceRow.amount_cents)),
        final_amount_cents: String(amountCents),
      },
      idempotencyKey: `hourly:${purchaseId}:${invoiceId}`,
    })
  } catch (stripeErr) {
    await req.db
      .prepare('UPDATE hourly_invoices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('failed', invoiceId)
    return res.status(503).json({ ok: false, error: 'stripe_session_create_failed', code: 'STRIPE_SESSION_ERROR' })
  }

  if (!session?.id || !session?.url) {
    await req.db
      .prepare('UPDATE hourly_invoices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('failed', invoiceId)
    return res.status(503).json({ ok: false, error: 'stripe_session_create_failed', code: 'STRIPE_SESSION_ERROR' })
  }

  await req.db
    .prepare('UPDATE hourly_invoices SET stripe_checkout_session_id = ? WHERE id = ?')
    .run(String(session.id), invoiceId)

  return res.json({ ok: true, url: session.url, invoice_id: invoiceId, checkout_session_id: session.id })
})

// Admin helper: list catalog rows that lack stripe_price_id mapping.
router.get('/admin/mapping-status', ensureAuth, ensureAdmin, async (req, res) => {
  await ensureServiceCatalogSchema(req.db)
  const rows = await req.db
    .prepare(
      `
        SELECT sci.slug, sci.name, sci.pricing_model, sp.client_category, sp.milestone_phase, sp.amount_cents, sp.stripe_price_id
        FROM service_catalog_items sci
        JOIN service_prices sp ON sp.service_id = sci.id
        WHERE sp.active = 1
        ORDER BY sci.name ASC, sp.client_category ASC, sp.milestone_phase ASC
      `,
    )
    .all()
  const missing = (rows || []).filter((r) => !r.stripe_price_id)
  res.json({ ok: true, missing_count: missing.length, missing })
})

export default router

