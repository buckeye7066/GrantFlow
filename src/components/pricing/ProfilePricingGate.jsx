import React, { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, Hourglass } from 'lucide-react'

import { accessGateApi } from '@/api/accessGate'
import ServiceAgreementGate from './ServiceAgreementGate'
import PricingCheckoutPanel from './PricingCheckoutPanel'
import { formatMoney, categoryLabel } from './pricingFormatters'
import { isNativeApp } from '@/lib/platform'

/**
 * Top-level gate state machine for the unpaid-user experience. Decides
 * whether to show the agreement step, the checkout step, an
 * admin-review-pending notice, or to render its own empty state once
 * access is granted.
 *
 * Children renders ONLY when `access_granted=true`.
 */
export function ProfilePricingGate({ profileId, children, onUnlocked }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [agreementAccepted, setAgreementAccepted] = useState(false)
  const isMounted = useRef(true)
  const activeProfileId = useRef(profileId)

  async function refresh(pid = profileId) {
    if (!pid) {
      if (isMounted.current) setLoading(false)
      return
    }
    try {
      const r = await accessGateApi.status(pid)
      if (!isMounted.current || activeProfileId.current !== pid) return
      setStatus(r)
      setAgreementAccepted(Boolean(r?.agreement_accepted))
      if (r?.access_granted && typeof onUnlocked === 'function') onUnlocked(r)
    } catch (err) {
      if (!isMounted.current || activeProfileId.current !== pid) return
      setStatus({ ok: false, access_granted: false, blocking_reason: 'unknown_error' })
    } finally {
      if (isMounted.current && activeProfileId.current === pid) setLoading(false)
    }
  }

  useEffect(() => {
    isMounted.current = true
    activeProfileId.current = profileId
    setLoading(true)
    refresh(profileId).catch(() => {
      if (isMounted.current && activeProfileId.current === profileId) setLoading(false)
    })
    return () => { isMounted.current = false }
  }, [profileId])

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Checking access…</span>
        </CardContent>
      </Card>
    )
  }

  if (status?.access_granted) {
    return typeof children === 'function' ? children(status) : children
  }

  if (status?.is_admin) {
    return typeof children === 'function' ? children(status) : children
  }

  if (status?.blocking_reason === 'admin_review_required') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hourglass className="h-5 w-5" /> Admin review pending
          </CardTitle>
          <CardDescription>
            Your intake has been received. Dr. White will review your recommended service package before checkout is enabled.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!status?.installed && !status?.is_admin) {
    return (
      <Alert>
        <AlertTitle>Pricing not yet available</AlertTitle>
        <AlertDescription>
          GrantFlow is finishing your pricing recommendation. Refresh in a moment.
        </AlertDescription>
      </Alert>
    )
  }

  // Store policy: the installed app must not show plans/prices or offer a
  // purchase flow. Paid + admin users already returned children above; only an
  // unpaid non-admin reaches here, where the next block would render the price
  // summary, service agreement, and Stripe checkout. In native builds, replace
  // all of that with a neutral notice — no amounts, no steering to the web.
  if (isNativeApp()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Activate your workspace</CardTitle>
          <CardDescription>
            Plan setup and payment aren&apos;t available in this app.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          If your account already has active service, simply log in — your full
          GrantFlow workspace is available here.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Your recommended GrantFlow package</CardTitle>
          <CardDescription>
            Based on your intake, we recommend the package below. Accept the
            service agreement and complete checkout to unlock the full workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Package</span>
            <span className="font-medium">{status?.recommended_package_name || '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Client category</span>
            <span className="font-medium">{categoryLabel(status?.access_status === 'admin_waived' ? '' : '') || categoryLabel(status?.client_category) || '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total</span>
            <span className="font-semibold">{formatMoney(Number(status?.total_cents || 0) / 100)}</span>
          </div>
          <div className="text-xs text-muted-foreground pt-2">
            Potential funding amounts are based on published opportunity information and are not guaranteed.
          </div>
        </CardContent>
      </Card>
      <ServiceAgreementGate
        profileId={profileId}
        alreadyAccepted={agreementAccepted}
        onAccepted={() => {
          setAgreementAccepted(true)
          refresh().catch(() => {})
        }}
      />
      <PricingCheckoutPanel
        profileId={profileId}
        recommendedPackageName={status?.recommended_package_name}
        primaryServiceKey={status?.primary_service_key}
        clientCategory={status?.client_category}
        totalCents={status?.total_cents}
        agreementAccepted={agreementAccepted}
      />
    </div>
  )
}

export default ProfilePricingGate
