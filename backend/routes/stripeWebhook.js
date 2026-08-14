import express from 'express'
import { verifyAndConstructStripeEvent, recordStripeEventIfNew } from '../services/stripeService.js'
import { ensureServiceCatalogSchema } from '../services/serviceCatalogStore.js'
import { markPaid } from '../services/pricing/pricingAccessGate.js'
import { recordPaymentAccessEvent } from '../services/pricing/profilePricingInitializer.js'
import { PAYMENT_ACCESS_EVENT, QUOTE_STATUS } from '../services/pricing/pricingTypes.js'
import { updateQuoteStatus, tableExists } from '../services/pricing/quoteBuilder.js'
import { markInvoicePaid } from '../services/billing/invoiceService.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:stripeWebhook')

/**
 * Grant paid access to a profile after a verified Stripe payment.
 * Updates the profile_pricing access_status, marks the linked quote as
 * paid (when present), and records a payment_access_event so Sam can
 * audit the full webhook -> access transition.
 */
async function grantPaidAccess(db, { profileId, quoteId, purchaseId }) {
  if (!profileId) return
  try {
    await markPaid(db, { profileId })
  } catch (err) {
    routeLogger.error('webhook: markPaid failed', { profileId, error: err?.message })
  }
  try {
    if (quoteId && (await tableExists(db, 'pricing_quotes'))) {
      await updateQuoteStatus(db, quoteId, QUOTE_STATUS.PAID)
    }
  } catch (err) {
    routeLogger.error('webhook: updateQuoteStatus failed', { quoteId, error: err?.message })
  }
  try {
    await recordPaymentAccessEvent(db, {
      profileId,
      quoteId: quoteId || null,
      eventType: PAYMENT_ACCESS_EVENT.PAYMENT_SUCCEEDED,
      details: { purchase_id: purchaseId || null },
    })
  } catch (err) {
    routeLogger.error('webhook: recordPaymentAccessEvent failed', { profileId, error: err?.message })
  }
}

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
  let record
  try {
    record = await recordStripeEventIfNew(req.db, event)
  } catch (recordErr) {
    routeLogger.error('Stripe webhook: failed to record event idempotency key', { eventId: event?.id, error: recordErr?.message })
    return res.status(500).json({ ok: false, error: 'idempotency_check_failed', message: recordErr?.message })
  }
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
          // Only `kickoff` and `submission` should drive purchase status; `draft`
          // is a mid-cycle update we record as paid on the milestone but leave
          // the purchase status alone for so the UI shows the project still in
          // progress.
          const MILESTONE_PHASE_TO_STATUS = { kickoff: 'in_progress', submission: 'paid' }
          const newStatus = MILESTONE_PHASE_TO_STATUS[phase] ?? null
          const knownPhases = Object.keys(MILESTONE_PHASE_TO_STATUS)
          if (!knownPhases.includes(phase)) {
            console.warn('Stripe webhook: unrecognised milestone_phase; skipping purchase state update', { purchaseId, phase, eventId: event?.id })
          }
          // dialect-divergence fix (the ingestionService/#946 class): use
          // withTransaction with an async, tx-bound callback so the writes are
          // truly atomic and awaited on both the SQLite and Postgres shims.
          await req.db.withTransaction(async (tx) => {
            await tx.prepare(
              `UPDATE milestone_payments SET status = 'paid', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE purchase_id = ? AND phase = ?`
            ).run(paymentIntent, purchaseId, phase)
            if (newStatus) {
              await tx.prepare(
                `UPDATE service_purchases SET status = ?, stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
              ).run(newStatus, paymentIntent, purchaseId)
            }
          })

          if (phase === 'submission') {
            const purchaseRow = await req.db
              .prepare(`SELECT id, profile_id FROM service_purchases WHERE id = ? LIMIT 1`)
              .get(purchaseId)
            if (purchaseRow?.profile_id) {
              await grantPaidAccess(req.db, {
                profileId: String(purchaseRow.profile_id),
                quoteId: String(metadata.quote_id || '') || null,
                purchaseId,
              })
            }
          }
        }
      } else if (kind === 'recurring_invoice') {
        // Automated recurring billing invoice (invoiceService). Mark it paid +
        // lift any suspension.
        const billingInvoiceId = String(metadata.billing_invoice_id || '').trim()
        const profileId = String(metadata.profile_id || '').trim() || null
        if (billingInvoiceId || profileId) {
          await markInvoicePaid(req.db, { invoiceId: billingInvoiceId || null, profileId, source: 'stripe_webhook' })
        }
      } else if (kind === 'hourly_invoice') {
        const invoiceId = String(metadata.hourly_invoice_id || '').trim()
        const purchaseId = String(metadata.purchase_id || '').trim()
        // dialect-divergence fix (the ingestionService/#946 class): same as
        // the milestone_payment branch above — withTransaction + tx-bound,
        // awaited statements instead of the sync `db.transaction(fn)()` shape.
        await req.db.withTransaction(async (tx) => {
          if (invoiceId) {
            await tx.prepare(
              `UPDATE hourly_invoices
               SET status = 'paid',
                   stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                   paid_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).run(paymentIntent, invoiceId)
          }
          if (purchaseId) {
            await tx.prepare(
              `UPDATE service_purchases
               SET status = 'paid',
                   stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).run(paymentIntent, purchaseId)
          }
        })

        if (purchaseId) {
          const purchaseRow = await req.db
            .prepare(`SELECT id, profile_id FROM service_purchases WHERE id = ? LIMIT 1`)
            .get(purchaseId)
          if (purchaseRow?.profile_id) {
            await grantPaidAccess(req.db, {
              profileId: String(purchaseRow.profile_id),
              quoteId: String(metadata.quote_id || '') || null,
              purchaseId,
            })
          }
        }
      } else if (kind === 'service_purchase') {
        const purchaseId = String(metadata.purchase_id || '').trim()
        const metaQuoteId = String(metadata.quote_id || '').trim()
        if (!purchaseId) {
          routeLogger.error('Stripe webhook: service_purchase missing purchase_id metadata; refusing to grant access', { eventId: event?.id, checkoutSessionId })
        } else {
          const purchaseRow = await req.db
            .prepare(`SELECT id, profile_id, user_id FROM service_purchases WHERE id = ? LIMIT 1`)
            .get(purchaseId)
          if (!purchaseRow) {
            routeLogger.error('Stripe webhook: service_purchase purchaseId not found; refusing to grant access', { purchaseId, eventId: event?.id })
          } else {
            // Cross-check quote_id (when provided) against the purchase's profile
            // so a forged metadata block cannot grant access on the wrong profile.
            let validQuoteId = null
            if (metaQuoteId) {
              try {
                const q = await req.db
                  .prepare(`SELECT id, profile_id FROM pricing_quotes WHERE id = ? LIMIT 1`)
                  .get(metaQuoteId)
                if (q && (!purchaseRow.profile_id || String(q.profile_id) === String(purchaseRow.profile_id))) {
                  validQuoteId = String(q.id)
                } else {
                  routeLogger.error('Stripe webhook: quote_id metadata does not match purchase profile; NOT granting access', { purchaseId, metaQuoteId, eventId: event?.id })
                }
              } catch {
                // pricing_quotes table not installed; proceed without quote linkage.
              }
            }

            const spResult = await req.db.prepare(
              `UPDATE service_purchases
               SET status = 'paid',
                   stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                   stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, ?),
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).run(paymentIntent, checkoutSessionId, purchaseId)

            if (spResult.changes === 0) {
              routeLogger.error('Stripe webhook: service_purchase UPDATE matched 0 rows; purchaseId not found in DB', { purchaseId, eventId: event?.id, checkoutSessionId })
            } else if (purchaseRow.profile_id) {
              await grantPaidAccess(req.db, {
                profileId: String(purchaseRow.profile_id),
                quoteId: validQuoteId,
                purchaseId,
              })
            }
          }
        }
      }
    }
  } catch (error) {
    routeLogger.error('Stripe webhook processing failed:', {
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
