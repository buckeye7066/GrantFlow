import React, { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CreditCard, AlertTriangle } from 'lucide-react'

import { createServicePurchase, createServiceCheckout } from '@/api/services'
import { formatMoney, categoryLabel } from './pricingFormatters'
import { isNativeApp } from '@/lib/platform'

const KICKOFF_PHASE = 'kickoff'

/**
 * Maps the engine's `client_category` to the existing service-catalog
 * naming. The pricing engine uses `mid_size` while the legacy catalog
 * uses `mid`.
 */
function mapCategory(c) {
  if (!c) return ''
  if (c === 'mid_size') return 'mid'
  return c
}

/**
 * Maps the engine's `primary_service_key` (snake_case) to the catalog
 * `slug` (kebab-case).
 */
function mapSlug(serviceKey) {
  if (!serviceKey) return ''
  return String(serviceKey).replaceAll('_', '-')
}

/**
 * Checkout button + Stripe handoff. Reuses /api/services/purchases +
 * /api/stripe/checkout/service. If the catalog has no matching slug or
 * the milestone price isn't configured for this category, surfaces a
 * clear "Stripe price mapping missing" message and admin notice.
 */
export function PricingCheckoutPanel({
  profileId,
  recommendedPackageName,
  primaryServiceKey,
  clientCategory,
  totalCents,
  agreementAccepted,
  onPaymentRedirect,
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const totalDollars = Number(totalCents || 0) / 100

  async function startCheckout() {
    if (!agreementAccepted) {
      setError('Please accept the service agreement first.')
      return
    }
    if (!primaryServiceKey) {
      setError('No recommended service available yet — admin review may be required.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const purchase = await createServicePurchase({
        service_slug: mapSlug(primaryServiceKey),
        client_category: mapCategory(clientCategory),
        profile_id: profileId,
      })
      if (!purchase?.ok && !purchase?.purchase) {
        const msg = purchase?.error || 'service_purchase_failed'
        if (/missing milestone price|service not found|invalid client_category/i.test(msg)) {
          setError(
            'Stripe price mapping missing for this service/category. The admin has been notified.',
          )
        } else {
          setError(msg)
        }
        return
      }
      const purchaseId = purchase?.purchase?.id || purchase?.id
      const checkout = await createServiceCheckout({
        purchase_id: purchaseId,
        milestone_phase: KICKOFF_PHASE,
        agree: true,
      })
      if (checkout?.url) {
        if (typeof onPaymentRedirect === 'function') onPaymentRedirect(checkout.url)
        else window.location.assign(checkout.url)
        return
      }
      const msg = checkout?.error || 'stripe_checkout_failed'
      if (/missing|not found|mapping/i.test(msg)) {
        setError('Stripe price mapping missing for this service/category. The admin has been notified.')
      } else {
        setError(msg)
      }
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  // Store policy: the installed app must not offer a purchase flow or point
  // at an external one. This panel is the single checkout choke point
  // (ProfilePricingGate + CheckoutRequired both mount it), so gating here
  // covers every path to Stripe.
  if (isNativeApp()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Checkout</CardTitle>
          <CardDescription>
            Payments aren&apos;t available in this app.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          If your account already has active service, simply log in — your full
          workspace is available here.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5" /> Checkout
        </CardTitle>
        <CardDescription>
          Pay your kickoff invoice to unlock the full GrantFlow workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Recommended package</span>
            <span className="font-medium">{recommendedPackageName || 'GrantFlow Service'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Client category</span>
            <span className="font-medium">{categoryLabel(clientCategory) || '—'}</span>
          </div>
          <div className="flex justify-between border-t mt-2 pt-2">
            <span className="text-muted-foreground">Total</span>
            <span className="font-semibold">{formatMoney(totalDollars)}</span>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          Payment terms: 40% kickoff · 40% complete draft · 20% submission/handoff. Net 15. 1.5% monthly late fee.
          All fees are for professional services rendered and are not contingent on award outcomes.
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Cannot start checkout</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button onClick={startCheckout} disabled={loading || !agreementAccepted}>
          {loading ? 'Starting checkout…' : 'Pay kickoff invoice'}
        </Button>
      </CardContent>
    </Card>
  )
}

export default PricingCheckoutPanel
