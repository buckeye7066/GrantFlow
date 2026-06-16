import React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import ServiceAgreementGate from '@/components/pricing/ServiceAgreementGate'

/**
 * Standalone agreement page. Used when admin (or onboarding flow) wants
 * to send the user directly to "review the agreement" without showing
 * the full pricing panel.
 */
export default function ServiceAgreement() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { user, profiles } = useAuthStore((s) => ({ user: s.user, profiles: s.profiles }))
  const profileId =
    params.get('profile_id') ||
    user?.activeProfileId ||
    user?.profile_id ||
    profiles?.[0]?.id ||
    null

  return (
    <div className="container mx-auto max-w-3xl space-y-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Service agreement</h1>
        <p className="text-sm text-muted-foreground">
          Please review the GrantFlow professional service terms.
        </p>
      </header>
      <ServiceAgreementGate
        profileId={profileId}
        onAccepted={() => {
          const target = profileId
            ? `/PricingRequired?profile_id=${encodeURIComponent(profileId)}`
            : '/PricingRequired'
          navigate(target)
        }}
      />
    </div>
  )
}
