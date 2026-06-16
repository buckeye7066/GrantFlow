import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { accessGateApi } from '@/api/accessGate'
import PricingCheckoutPanel from '@/components/pricing/PricingCheckoutPanel'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'

/**
 * Standalone checkout page. Useful when the user has already accepted
 * the agreement and wants to retry or resume payment. Mounts only the
 * checkout panel.
 */
export default function CheckoutRequired() {
  const [params] = useSearchParams()
  const { user, profiles } = useAuthStore((s) => ({ user: s.user, profiles: s.profiles }))
  const profileId =
    params.get('profile_id') ||
    user?.activeProfileId ||
    user?.profile_id ||
    profiles?.[0]?.id ||
    null

  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    if (!profileId) { setLoading(false); return undefined }
    accessGateApi.status(profileId).then((r) => {
      if (cancelled) return
      setStatus(r)
      setLoading(false)
    }).catch(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [profileId])

  return (
    <div className="container mx-auto max-w-3xl space-y-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Complete your payment</h1>
        <p className="text-sm text-muted-foreground">
          Pay the kickoff invoice to unlock your full GrantFlow workspace.
        </p>
      </header>
      {loading ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading checkout…
            </CardTitle>
          </CardHeader>
          <CardContent />
        </Card>
      ) : (
        <PricingCheckoutPanel
          profileId={profileId}
          recommendedPackageName={status?.recommended_package_name}
          primaryServiceKey={status?.primary_service_key}
          clientCategory={status?.client_category}
          totalCents={status?.total_cents}
          agreementAccepted={Boolean(status?.agreement_accepted)}
        />
      )}
    </div>
  )
}
