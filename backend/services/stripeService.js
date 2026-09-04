import crypto from 'node:crypto'
import Stripe from 'stripe'
import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('services:stripeService')

function safeHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

function getStripeSecretKeyOrNull() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim()
  return key || null
}

export function isStripeConfigured() {
  return Boolean(getStripeSecretKeyOrNull() && String(process.env.STRIPE_WEBHOOK_SECRET || '').trim())
}

function createStripe() {
  const key = getStripeSecretKeyOrNull()
  if (!key) return null
  return new Stripe(key, {
    // Keep to Stripe’s SDK defaults; do not log secrets.
    // apiVersion is optional; Stripe SDK pins a default.
    telemetry: false,
  })
}

function isTruthy(value) {
  const v = String(value || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on'
}

export async function getOrCreateStripeCustomerId(db, { userId, email, name } = {}) {
  const uid = String(userId || '').trim()
  if (!uid) return { ok: false, error: 'missing_user_id' }

  let row = null
  try {
    row = await db.prepare('SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ? LIMIT 1').get(uid)
  } catch (error) {
    qualityLog.error('Database error checking existing stripe customer:', error)
    return { ok: false, error: 'database_error' }
  }
  if (row?.stripe_customer_id) {
    return { ok: true, stripe_customer_id: String(row.stripe_customer_id) }
  }

  const stripe = createStripe()
  if (!stripe) return { ok: false, error: 'stripe_not_configured' }

  // In tests we allow a deterministic fake customer without making network calls.
  if (isTruthy(process.env.STRIPE_MOCK)) {
    const customerId = `cus_mock_${safeHash(uid).slice(0, 10)}`
    try {
      await db
        .prepare('INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES (?, ?)')
        .run(uid, customerId)
    } catch (error) {
      qualityLog.error('Failed to insert stripe customer:', error)
      return { ok: false, error: 'database_insert_failed' }
    }
    return { ok: true, stripe_customer_id: customerId, mocked: true }
  }

  let customer
  try {
    customer = await stripe.customers.create({
      email: email || undefined,
      name: name || undefined,
      metadata: { user_id: uid },
    })
  } catch (error) {
    qualityLog.error('Stripe customer creation failed:', error.message)
    return { ok: false, error: 'stripe_customer_creation_failed' }
  }

  try {
    await db
      .prepare('INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES (?, ?)')
      .run(uid, customer.id)
  } catch (error) {
    qualityLog.error('Failed to save stripe customer to database:', error)
    return { ok: false, error: 'database_save_failed' }
  }

  return { ok: true, stripe_customer_id: customer.id }
}

/**
 * A hosted Stripe Checkout URL for one recurring billing invoice (ad-hoc
 * amount, no pre-created Price). Carries metadata.kind='recurring_invoice' +
 * billing_invoice_id + profile_id so the webhook (routes/stripeWebhook.js) can
 * mark it paid. Returns null when Stripe isn't configured (invoice email then
 * just asks the user to reply for a link). Never throws.
 */
export async function createInvoicePaymentLink(_db, { profileId, amountCents, invoiceId = null, currency = 'usd' } = {}) {
  const stripe = createStripe()
  if (!stripe || !amountCents || amountCents <= 0) return null
  const base = String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'https://app.axiombiolabs.org').replace(/\/$/, '')
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: Math.round(Number(amountCents)),
          product_data: { name: 'GrantFlow service invoice' },
        },
      }],
      success_url: `${base}/Billing?paid=1`,
      cancel_url: `${base}/Billing`,
      metadata: { kind: 'recurring_invoice', billing_invoice_id: invoiceId || '', profile_id: String(profileId || '') },
    })
    return session?.url || null
  } catch (error) {
    console.warn('[stripeService] createInvoicePaymentLink failed:', error?.message)
    return null
  }
}

export async function createCheckoutSessionForPrice({
  priceId,
  quantity = 1,
  customerId,
  successUrl,
  cancelUrl,
  metadata = {},
  idempotencyKey,
  // 'payment' (one-time service work) or 'subscription' (a recurring tier).
  // Subscription mode is what lets a purchase reach
  // services/billing/subscriptionSync.js and actually move billing_accounts.tier_id;
  // before it existed every checkout was one-time and no plan could ever be bought.
  mode = 'payment',
}) {
  const stripe = createStripe()
  if (!stripe) {
    const err = new Error('Stripe is not configured (missing STRIPE_SECRET_KEY)')
    err.code = 'STRIPE_NOT_CONFIGURED'
    throw err
  }

  const checkoutMode = mode === 'subscription' ? 'subscription' : 'payment'
  const qty = Math.max(1, Math.floor(Number(quantity) || 1))
  const idem = idempotencyKey ? String(idempotencyKey) : undefined

  if (isTruthy(process.env.STRIPE_MOCK)) {
    const sid = `cs_mock_${safeHash(`${priceId}:${qty}:${customerId || ''}:${successUrl || ''}`).slice(0, 12)}`
    return {
      id: sid,
      url: `https://checkout.stripe.test/session/${sid}`,
      payment_intent: `pi_mock_${safeHash(sid).slice(0, 12)}`,
      customer: customerId || null,
    }
  }

  let session
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: checkoutMode,
        customer: customerId || undefined,
        line_items: [{ price: priceId, quantity: qty }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        // Stripe copies session metadata onto the Session, not onto the
        // Subscription it creates. subscriptionSync resolves a profile from
        // subscription.metadata.profile_id first, so it must be propagated
        // explicitly or every subscription event would arrive unattributable.
        ...(checkoutMode === 'subscription'
          ? { subscription_data: { metadata } }
          : {}),
      },
      idem ? { idempotencyKey: idem } : undefined,
    )
  } catch (error) {
    qualityLog.error('Stripe checkout session creation failed:', error.message)
    throw new Error('Failed to create payment session')
  }
  return session
}

export function verifyAndConstructStripeEvent({ rawBody, signatureHeader }) {
  const secret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim()
  if (!secret) {
    const err = new Error('Missing STRIPE_WEBHOOK_SECRET')
    err.code = 'MISSING_WEBHOOK_SECRET'
    throw err
  }

  const stripe = createStripe()
  if (!stripe) {
    const err = new Error('Stripe is not configured (missing STRIPE_SECRET_KEY)')
    err.code = 'STRIPE_NOT_CONFIGURED'
    throw err
  }

  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret)
}

export async function recordStripeEventIfNew(db, event) {
  const eventId = String(event?.id || '').trim()
  if (!eventId) return { ok: false, error: 'missing_event_id' }

  try {
    await db.prepare('INSERT INTO stripe_webhook_events (event_id, type) VALUES (?, ?)').run(eventId, String(event?.type || ''))
    return { ok: true, inserted: true }
  } catch (error) {
    const msg = String(error?.message || error)
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
      return { ok: true, inserted: false, duplicate: true }
    }
    throw error
  }
}

