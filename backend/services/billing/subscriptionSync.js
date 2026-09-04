/**
 * The single authority that turns a VERIFIED Stripe subscription into a
 * billing_accounts.tier_id assignment.
 *
 * WHY THIS EXISTS
 * Before this module, the tier system was assignment-only:
 *   - shared/tierCatalog.js defined tiers and their capability flags
 *   - backend/utils/tierGating.js correctly enforced them
 *   - backend/routes/billing.js (admin-only) was the ONLY writer of tier_id
 *   - backend/routes/stripeWebhook.js handled exactly one event type,
 *     "checkout.session.completed", and only for one-time service purchases
 *   - backend/services/stripeService.js only ever used mode:"payment"
 * The consequence, verified on main: a customer could pay and never unlock a
 * paid capability. Enforcement without an acquisition path is a broken funnel,
 * not a safety feature.
 *
 * DESIGN RULES
 *  - Stripe is the source of truth for subscription STATE. This module never
 *    invents an entitlement Stripe did not report.
 *  - A price id maps to a tier id via env (STRIPE_PRICE_<TIER_ID_UPPER>). An
 *    unmapped price NEVER silently grants a tier; it leaves the assignment
 *    untouched and logs the misconfiguration loudly.
 *  - Every transition writes a billing_account_events audit row, so the
 *    webhook -> tier transition is inspectable after the fact.
 *  - Admin / pro-bono assignments are protected: a Stripe downgrade will not
 *    clear an explicitly pro-bono account.
 */

import { TIERS, TIER_IDS } from '../../../shared/tierCatalog.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('billing:subscriptionSync')

/** Stripe statuses that should grant the paid tier. */
export const ACTIVE_SUBSCRIPTION_STATUSES = Object.freeze(new Set(['active', 'trialing']))

/** Stripe statuses that should revoke the paid tier back to the free tier. */
export const REVOKING_SUBSCRIPTION_STATUSES = Object.freeze(
  new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']),
)

/**
 * "past_due" deliberately does NOT revoke immediately. Stripe retries dunning
 * for days, and yanking capability on the first failed charge punishes a user
 * for an expired card. It is surfaced in subscription_status so the UI can warn.
 */
export const GRACE_SUBSCRIPTION_STATUSES = Object.freeze(new Set(['past_due', 'incomplete']))

/** The tier granted when no paid subscription is active. Lowest-cost service tier. */
export function freeTierId() {
  const free = TIERS.find((t) => t.family === 'service' && Number(t.monthly_cents) === 0)
  return free?.id ?? TIER_IDS[0]
}

/**
 * Map a Stripe price id to a canonical tier id using env configuration.
 * Env key shape: STRIPE_PRICE_GROWTH=price_123 (tier id upper-cased).
 * Returns null when the price is not mapped. Callers MUST fail closed.
 */
export function resolveTierIdFromStripePrice(priceId, env = process.env) {
  const wanted = String(priceId || '').trim()
  if (!wanted) return null
  for (const tierId of TIER_IDS) {
    const key = `STRIPE_PRICE_${String(tierId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    const configured = String(env[key] || '').trim()
    if (configured && configured === wanted) return tierId
  }
  return null
}

/** Extract the first price id from a Stripe subscription object. */
export function priceIdFromSubscription(subscription) {
  const item = subscription?.items?.data?.[0]
  return item?.price?.id ? String(item.price.id) : null
}

function toIsoOrNull(unixSeconds) {
  const n = Number(unixSeconds)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

/**
 * Resolve which profile a Stripe subscription belongs to.
 * Priority: explicit metadata.profile_id (set at checkout), then an account
 * already linked to this subscription id, then one linked to the customer id.
 * Never guesses.
 */
async function resolveProfileId(db, subscription) {
  const metaProfileId = String(subscription?.metadata?.profile_id || '').trim()
  if (metaProfileId) return metaProfileId

  const subId = subscription?.id ? String(subscription.id) : null
  if (subId) {
    const row = await db
      .prepare('SELECT profile_id FROM billing_accounts WHERE stripe_subscription_id = ? LIMIT 1')
      .get(subId)
    if (row?.profile_id) return String(row.profile_id)
  }

  const customerId = subscription?.customer ? String(subscription.customer) : null
  if (customerId) {
    const row = await db
      .prepare('SELECT profile_id FROM billing_accounts WHERE stripe_customer_id = ? LIMIT 1')
      .get(customerId)
    if (row?.profile_id) return String(row.profile_id)
  }

  return null
}

/**
 * Apply a Stripe subscription to a profile billing account.
 *
 * @returns {Promise<{ok:boolean, reason?:string, profile_id?:string,
 *   previous_tier_id?:string, new_tier_id?:string, status?:string, changed?:boolean}>}
 */
export async function applyStripeSubscription(db, subscription, { source = 'stripe_webhook' } = {}) {
  if (!db || !subscription) return { ok: false, reason: 'missing_input' }

  const status = String(subscription.status || '').trim()
  const subscriptionId = subscription.id ? String(subscription.id) : null
  const customerId = subscription.customer ? String(subscription.customer) : null
  const priceId = priceIdFromSubscription(subscription)

  const profileId = await resolveProfileId(db, subscription)
  if (!profileId) {
    // Fail loudly rather than silently dropping a paid subscription.
    log.error('subscription has no resolvable profile; tier NOT changed', {
      subscriptionId,
      customerId,
      status,
    })
    return { ok: false, reason: 'unresolved_profile', status }
  }

  const account = await db
    .prepare('SELECT * FROM billing_accounts WHERE profile_id = ? LIMIT 1')
    .get(profileId)
  if (!account) {
    log.error('no billing account for profile; tier NOT changed', { profileId, subscriptionId })
    return { ok: false, reason: 'no_billing_account', profile_id: profileId, status }
  }

  const previousTierId = account.tier_id ? String(account.tier_id) : null
  const paidTierId = resolveTierIdFromStripePrice(priceId)

  let nextTierId = previousTierId
  let reason = null

  if (ACTIVE_SUBSCRIPTION_STATUSES.has(status)) {
    if (paidTierId) {
      nextTierId = paidTierId
      reason = `stripe_subscription_${status}`
    } else {
      // Unmapped price: do NOT guess a tier. Leave the existing assignment and
      // report it, so a misconfiguration is visible instead of silently
      // granting or silently denying a capability the customer paid for.
      reason = 'unmapped_price_id'
      log.error('active subscription has an UNMAPPED price id; tier left unchanged', {
        profileId,
        subscriptionId,
        priceId,
        hint: 'set STRIPE_PRICE_<TIER_ID_UPPER> for this price',
      })
    }
  } else if (REVOKING_SUBSCRIPTION_STATUSES.has(status)) {
    if (account.is_pro_bono) {
      // An explicit pro-bono grant outranks a lapsed card.
      reason = 'revocation_skipped_pro_bono'
    } else {
      nextTierId = freeTierId()
      reason = `stripe_subscription_${status}`
    }
  } else if (GRACE_SUBSCRIPTION_STATUSES.has(status)) {
    reason = `stripe_subscription_${status}_grace`
  } else {
    reason = `stripe_subscription_unknown_status_${status || 'empty'}`
    log.warn('unrecognised Stripe subscription status; tier left unchanged', { profileId, status })
  }

  const changed = Boolean(nextTierId) && nextTierId !== previousTierId

  await db
    .prepare(
      `UPDATE billing_accounts
         SET tier_id = COALESCE(?, tier_id),
             stripe_customer_id = COALESCE(?, stripe_customer_id),
             stripe_subscription_id = COALESCE(?, stripe_subscription_id),
             stripe_price_id = COALESCE(?, stripe_price_id),
             subscription_status = ?,
             subscription_current_period_end = ?,
             assigned_by = CASE WHEN ? = 1 THEN ? ELSE assigned_by END,
             assigned_reason = CASE WHEN ? = 1 THEN ? ELSE assigned_reason END,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(
      nextTierId ?? null,
      customerId,
      subscriptionId,
      priceId,
      status || null,
      toIsoOrNull(subscription.current_period_end),
      changed ? 1 : 0,
      source,
      changed ? 1 : 0,
      reason,
      account.id,
    )

  if (changed) {
    try {
      const { logBillingAccountEvent } = await import('../billingAccounts.js')
      await logBillingAccountEvent(db, account.id, {
        changed_by: source,
        previous_tier_id: previousTierId,
        new_tier_id: nextTierId,
        previous_discount_type: account.discount_type ?? 'none',
        new_discount_type: account.discount_type ?? 'none',
        previous_discount_percent: account.discount_percent ?? 0,
        new_discount_percent: account.discount_percent ?? 0,
        previous_pro_bono: Boolean(account.is_pro_bono),
        new_pro_bono: Boolean(account.is_pro_bono),
        notes: `${reason} (subscription ${subscriptionId ?? 'unknown'}, price ${priceId ?? 'none'})`,
      })
    } catch (err) {
      // An audit-log failure must not roll back a tier the customer paid for.
      log.error('billing_account_events write failed after tier change', {
        profileId,
        error: err?.message,
      })
    }
  }

  log.info('stripe subscription applied', {
    profileId,
    subscriptionId,
    status,
    priceId,
    previous_tier_id: previousTierId,
    new_tier_id: nextTierId,
    changed,
    reason,
  })

  return {
    ok: true,
    profile_id: profileId,
    previous_tier_id: previousTierId,
    new_tier_id: nextTierId,
    status,
    changed,
    reason,
  }
}
