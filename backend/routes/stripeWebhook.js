import express from 'express'
import { verifyAndConstructStripeEvent, recordStripeEventIfNew } from '../services/stripeService.js'
import { ensureServiceCatalogSchema } from '../services/serviceCatalogStore.js'
import { markPaid } from '../services/pricing/pricingAccessGate.js'
import { recordPaymentAccessEvent } from '../services/pricing/profilePricingInitializer.js'
import { PAYMENT_ACCESS_EVENT, QUOTE_STATUS } from '../services/pricing/pricingTypes.js'
import { updateQuoteStatus, tableExists } from '../services/pricing/quoteBuilder.js'
import { ensureInvoiceSchema, markInvoicePaid } from '../services/billing/invoiceService.js'
import { applyStripePaymentFailure, applyStripeSubscription } from '../services/billing/subscriptionSync.js'

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
  const access = await markPaid(db, { profileId })
  if (!access?.ok) throw new Error(access?.error || 'paid_access_not_recorded')
  if (quoteId && (await tableExists(db, 'pricing_quotes'))) {
    await updateQuoteStatus(db, quoteId, QUOTE_STATUS.PAID)
  }
  await recordPaymentAccessEvent(db, {
    profileId,
    quoteId: quoteId || null,
    eventType: PAYMENT_ACCESS_EVENT.PAYMENT_SUCCEEDED,
    details: { purchase_id: purchaseId || null },
  })
}

const router = express.Router()

// Stripe requires the *raw* request body for signature verification.
// This router MUST be mounted with express.raw({ type: 'application/json' }).
router.post('/', async (req, res) => {
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

  try {
    await ensureServiceCatalogSchema(req.db)
    // Schema setup can contain compatibility DDL; keep it outside the payment
    // transaction so an already-existing column cannot abort PostgreSQL work.
    if (event.data?.object?.metadata?.kind === 'recurring_invoice') {
      await ensureInvoiceSchema(req.db)
    }
    const result = await req.db.withTransaction(async (db) => {
      const record = await recordStripeEventIfNew(db, event)
      if (!record?.ok) throw new Error(record?.error || 'idempotency_check_failed')
      if (!record.inserted) return { duplicate: true }
      await fulfillStripeEvent(db, event)
      return {}
    })
    return res.json({ ok: true, received: true, ...result })
  } catch (error) {
    routeLogger.error('Stripe webhook processing failed:', {
      eventType: event?.type,
      eventId: event?.id,
      error: error.message,
    })
    return res.status(500).json({ ok: false, error: 'webhook_handler_failed', type: event?.type || null })
  }
})

// All fulfillment writes use the transaction passed by the verified route.
// Failure rolls back both those writes and the event receipt, allowing retries.
async function fulfillStripeEvent(db, event) {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data?.object
      // A completed bank-payment checkout can still be unpaid. Stripe sends a
      // separate success event when it settles; only then may fulfillment run.
      if (!['paid', 'no_payment_required'].includes(session?.payment_status)) return
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
          // The verified route owns the transaction for all of these writes.
          {
            await db.prepare(
              `UPDATE milestone_payments SET status = 'paid', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE purchase_id = ? AND phase = ?`
            ).run(paymentIntent, purchaseId, phase)
            if (newStatus) {
              await db.prepare(
                `UPDATE service_purchases SET status = ?, stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
              ).run(newStatus, paymentIntent, purchaseId)
            }
          }

          if (phase === 'submission') {
            const purchaseRow = await db
              .prepare(`SELECT id, profile_id FROM service_purchases WHERE id = ? LIMIT 1`)
              .get(purchaseId)
            if (purchaseRow?.profile_id) {
              await grantPaidAccess(db, {
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
          const paid = await markInvoicePaid(db, { invoiceId: billingInvoiceId || null, profileId, source: 'stripe_webhook' })
          if (!paid?.ok) throw new Error(paid?.error || 'invoice_payment_not_recorded')
        }
      } else if (kind === 'hourly_invoice') {
        const invoiceId = String(metadata.hourly_invoice_id || '').trim()
        const purchaseId = String(metadata.purchase_id || '').trim()
        // Reuse the route's transaction; nested transactions are unsupported
        // by the Postgres transaction object and would deadlock SQLite.
        {
          if (invoiceId) {
            await db.prepare(
              `UPDATE hourly_invoices
               SET status = 'paid',
                   stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                   paid_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).run(paymentIntent, invoiceId)
          }
          if (purchaseId) {
            await db.prepare(
              `UPDATE service_purchases
               SET status = 'paid',
                   stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).run(paymentIntent, purchaseId)
          }
        }

        if (purchaseId) {
          const purchaseRow = await db
            .prepare(`SELECT id, profile_id FROM service_purchases WHERE id = ? LIMIT 1`)
            .get(purchaseId)
          if (purchaseRow?.profile_id) {
            await grantPaidAccess(db, {
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
          throw new Error('missing_purchase_id')
        } else {
          const purchaseRow = await db
            .prepare(`SELECT id, profile_id, user_id FROM service_purchases WHERE id = ? LIMIT 1`)
            .get(purchaseId)
          if (!purchaseRow) {
            routeLogger.error('Stripe webhook: service_purchase purchaseId not found; refusing to grant access', { purchaseId, eventId: event?.id })
            throw new Error('purchase_not_found')
          } else {
            // Cross-check quote_id (when provided) against the purchase's profile
            // so a forged metadata block cannot grant access on the wrong profile.
            let validQuoteId = null
            if (metaQuoteId) {
              const q = await db
                .prepare(`SELECT id, profile_id FROM pricing_quotes WHERE id = ? LIMIT 1`)
                .get(metaQuoteId)
              if (!q || !purchaseRow.profile_id || String(q.profile_id) !== String(purchaseRow.profile_id)) {
                routeLogger.error('Stripe webhook: quote_id metadata does not match purchase profile; NOT granting access', { purchaseId, metaQuoteId, eventId: event?.id })
                throw new Error('quote_profile_mismatch')
              }
              validQuoteId = String(q.id)
            }

            const spResult = await db.prepare(
              `UPDATE service_purchases
               SET status = 'paid',
                   stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
                   stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, ?),
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).run(paymentIntent, checkoutSessionId, purchaseId)

            if (spResult.changes === 0) {
              routeLogger.error('Stripe webhook: service_purchase UPDATE matched 0 rows; purchaseId not found in DB', { purchaseId, eventId: event?.id, checkoutSessionId })
              throw new Error('purchase_not_updated')
            } else if (purchaseRow.profile_id) {
              await grantPaidAccess(db, {
                profileId: String(purchaseRow.profile_id),
                quoteId: validQuoteId,
                purchaseId,
              })
            }
          }
        }
      }
    } else if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      // Subscription lifecycle -> billing_accounts.tier_id.
      //
      // This branch is what makes a paid plan actually unlock a capability.
      // Until it existed, tierGating.requireTierCapability enforced tiers that
      // nothing but an admin route could ever grant, so a paying customer
      // stayed on the free tier forever. subscriptionSync is the sole authority
      // for the mapping; it fails closed on an unmapped price rather than
      // guessing a tier.
      const subscription = event.data?.object
      const result = await applyStripeSubscription(db, subscription, {
        source: `stripe_webhook:${event.type}`,
        eventCreated: event.created,
      })
      if (!result.ok || result.reason === 'unmapped_price_id') {
        // Billing initialization and configuration can be repaired between
        // deliveries. Do not acknowledge a paid event whose entitlement was
        // never applied or permanently consume its retry receipt.
        routeLogger.error('subscription event could not be applied', {
          eventId: event?.id,
          eventType: event?.type,
          reason: result.reason,
          subscriptionId: subscription?.id ?? null,
        })
        throw new Error(result.reason || 'subscription_not_applied')
      }
    } else if (event.type === 'invoice.payment_failed') {
      // Surface the dunning state without revoking capability on the first
      // failed charge. Stripe retries for days; the subscription.updated event
      // that follows a terminal failure is what actually revokes the tier.
      const invoice = event.data?.object
      const subscriptionId = invoice?.subscription ? String(invoice.subscription) : null
      if (subscriptionId) {
        const failure = await applyStripePaymentFailure(db, {
          subscriptionId,
          eventCreated: event.created,
        })
        routeLogger.warn('invoice payment failed', {
          subscriptionId, eventId: event?.id, result: failure.reason,
        })
      }
    }
}

export default router
