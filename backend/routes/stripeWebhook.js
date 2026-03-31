import express from 'express'
import { verifyAndConstructStripeEvent, recordStripeEventIfNew } from '../services/stripeService.js'
import { ensureServiceCatalogSchema } from '../services/serviceCatalogStore.js'

const router = express.Router()

// Stripe requires the *raw* request body for signature verification.
// This router MUST be mounted with express.raw({ type: 'application/json' }).
router.post('/', async (req, res) => {
  await ensureServiceCatalogSchema(req.db)

  const signature = req.headers['stripe-signature']
  if (!signature) {
    return res.status(400).json({ ok: false, error: 'missing_stripe_signature' })
  }

  let event = null
  try {
    event = verifyAndConstructStripeEvent({ rawBody: req.body, signatureHeader: signature })
  } catch (error) {
    return res.status(400).json({ ok: false, error: 'invalid_signature', message: error?.message || String(error) })
  }

  // Idempotency: only process once per event id.
  const record = await recordStripeEventIfNew(req.db, event)
  if (record?.ok && record.inserted === false) {
    return res.json({ ok: true, received: true, duplicate: true })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object
      const metadata = session?.metadata || {}
      const kind = String(metadata.kind || '')

      const paymentIntent = session?.payment_intent ? String(session.payment_intent) : null
      const checkoutSessionId = session?.id ? String(session.id) : null

      if (kind === 'milestone_payment') {
        const purchaseId = String(metadata.purchase_id || '').trim()
        const phase = String(metadata.milestone_phase || '').trim()
        if (purchaseId && phase) {
          const transaction = req.db.transaction(() => {
            req.db.prepare(
              `UPDATE milestone_payments SET status = 'paid', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE purchase_id = ? AND phase = ?`
            ).run(paymentIntent, purchaseId, phase)
            // Additional updates within same transaction
          })
          transaction()
          // Mark purchase in_progress once kickoff is paid
          if (phase === 'kickoff') {
            await req.db.prepare(
              `
                UPDATE service_purchases
                SET status = 'in_progress',
                    stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `,
            ).run(paymentIntent, purchaseId)
          }
          // Mark purchase completed once submission is paid
          if (phase === 'submission') {
            await req.db.prepare(
              `
                UPDATE service_purchases
                SET status = 'paid',
                    stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `,
            ).run(paymentIntent, purchaseId)
          }
        }
      } else if (kind === 'hourly_invoice') {
        const invoiceId = String(metadata.hourly_invoice_id || '').trim()
        const purchaseId = String(metadata.purchase_id || '').trim()
        if (invoiceId) {
          await req.db.prepare(
            `
              UPDATE hourly_invoices
              SET status = 'paid',
                  stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                  paid_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
          ).run(paymentIntent, invoiceId)
        }
        if (purchaseId) {
          await req.db.prepare(
            `
              UPDATE service_purchases
              SET status = 'paid',
                  stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
          ).run(paymentIntent, purchaseId)
        }
      } else if (kind === 'service_purchase') {
        const purchaseId = String(metadata.purchase_id || '').trim()
        if (purchaseId) {
          await req.db.prepare(
            `
              UPDATE service_purchases
              SET status = 'paid',
                  stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                  stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
          ).run(paymentIntent, checkoutSessionId, purchaseId)
        }
      }
    }
  } catch (error) {
    console.error('Stripe webhook processing failed:', {
      eventType: event?.type,
      eventId: event?.id,
      error: error.message,
      stack: error.stack
    })
    return res.status(500).json({
      ok: false,
      error: 'webhook_handler_failed',
      type: event?.type || null,
      message: error.message
    })
  }

  return res.json({ ok: true, received: true })
})

export default router

