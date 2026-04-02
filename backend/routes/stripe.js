import express from 'express'
import crypto from 'node:crypto'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { ensureServiceCatalogSchema, MILESTONE_PHASES } from '../services/serviceCatalogStore.js'
import { createCheckoutSessionForPrice, getOrCreateStripeCustomerId } from '../services/stripeService.js'
import { roundBillableMinutes } from '../services/hourlyRounding.js'

const router = express.Router()

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
  const phase = body.milestone_phase != null ? String(body.milestone_phase).trim() : null
  const agree = body.agree === true

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

  // Determine the price row to pay
  let priceRow = null
  let idempotencyKey = null
  let metadata = {
    purchase_id: String(purchaseId),
    service_slug: String(purchase.service_slug),
    client_category: clientCategory,
    pricing_model: pricingModel,
    kind: 'service_purchase',
  }

  if (pricingModel === 'milestone') {
    if (!phase) return res.status(400).json({ ok: false, error: 'milestone_phase required' })
    if (!MILESTONE_PHASES.includes(phase)) return res.status(400).json({ ok: false, error: 'invalid milestone_phase' })

    // Enforce ordering: only next unpaid phase allowed.
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

    priceRow = await req.db
      .prepare(
        `
          SELECT amount_cents, stripe_price_id
          FROM service_prices
          WHERE service_id = ?
            AND client_category = ?
            AND milestone_phase = ?
            AND active = 1
          LIMIT 1
        `,
      )
      .get(String(purchase.service_id), clientCategory, phase)

    if (!priceRow?.stripe_price_id) {
      return res.status(409).json({ ok: false, error: 'stripe_price_not_mapped', code: 'STRIPE_PRICE_MISSING' })
    }

    idempotencyKey = `purchase:${purchaseId}:phase:${phase}`
    metadata = { ...metadata, milestone_phase: phase, kind: 'milestone_payment' }
  } else if (pricingModel === 'one_time') {
    priceRow = await req.db
      .prepare(
        `
          SELECT amount_cents, stripe_price_id
          FROM service_prices
          WHERE service_id = ?
            AND client_category = ?
            AND COALESCE(milestone_phase, '') = ''
            AND active = 1
          LIMIT 1
        `,
      )
      .get(String(purchase.service_id), clientCategory)
    if (!priceRow?.stripe_price_id) {
      return res.status(409).json({ ok: false, error: 'stripe_price_not_mapped', code: 'STRIPE_PRICE_MISSING' })
    }
    idempotencyKey = `purchase:${purchaseId}:one_time`
  } else {
    return res.status(400).json({ ok: false, error: 'unsupported pricing_model for this endpoint' })
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
    priceId: String(priceRow.stripe_price_id),
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

  // Persist checkout session id
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

  return res.json({ ok: true, url: session.url, checkout_session_id: session.id })
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

