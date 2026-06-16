import React from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import ProfilePricingGate from '@/components/pricing/ProfilePricingGate'

/**
 * The page non-admin unpaid users land on whenever they try to reach a
 * gated route. Renders the agreement + checkout flow via
 * ProfilePricingGate.
 */
export default function PricingRequired() {
  const [params] = useSearchParams()
  const { user, profiles } = useAuthStore((s) => ({
    user: s.user,
    profiles: s.profiles,
  }))
  const profileId =
    params.get('profile_id') ||
    user?.activeProfileId ||
    user?.profile_id ||
    profiles?.[0]?.id ||
    null

  return (
    <div className="container mx-auto max-w-3xl space-y-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Activate your GrantFlow workspace</h1>
        <p className="text-sm text-muted-foreground">
          Review the recommended service package, accept the service agreement,
          and complete payment to unlock your full GrantFlow workspace.
        </p>
      </header>
      <ProfilePricingGate profileId={profileId} />
    </div>
  )
}
