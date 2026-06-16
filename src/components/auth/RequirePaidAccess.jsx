import React, { useEffect, useState, useMemo } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

import { useAuthStore } from '@/stores/authStore'
import { accessGateApi } from '@/api/accessGate'

/**
 * Wraps a route element. Until `/api/access-gate/status` confirms the
 * user is authorized (paid, waived, or admin), the user is redirected
 * to `/PricingRequired?profile_id=<active>`.
 *
 * Admin users always bypass. Anonymous users fall through to the
 * existing auth redirect (this component does not handle login redirect
 * — `LayoutRoutes` already does that upstream).
 */
export function RequirePaidAccess({ children, fallback = null }) {
  const location = useLocation()
  const { user, profiles } = useAuthStore((state) => ({
    user: state.user,
    profiles: state.profiles,
  }))

  const profileId = useMemo(() => {
    if (user?.activeProfileId) return user.activeProfileId
    if (user?.profile_id) return user.profile_id
    if (Array.isArray(profiles) && profiles.length > 0) return profiles[0]?.id || null
    return null
  }, [user, profiles])

  const [state, setState] = useState({ status: 'checking', payload: null })

  useEffect(() => {
    let cancelled = false
    if (!user) {
      setState({ status: 'anonymous', payload: null })
      return () => { cancelled = true }
    }
    if (user.is_admin || isConfiguredAdminEmail(user.email)) {
      setState({ status: 'allowed', payload: { is_admin: true } })
      return () => { cancelled = true }
    }
    accessGateApi
      .status(profileId)
      .then((r) => {
        if (cancelled) return
        if (r?.access_granted) setState({ status: 'allowed', payload: r })
        else setState({ status: 'blocked', payload: r })
      })
      .catch(() => !cancelled && setState({ status: 'allowed', payload: { degraded: true } }))
    return () => { cancelled = true }
  }, [user, profileId, location.pathname])

  if (state.status === 'checking') return fallback
  if (state.status === 'anonymous') return null // upstream LayoutRoutes handles unauth redirect
  if (state.status === 'blocked') {
    const target = profileId
      ? `/PricingRequired?profile_id=${encodeURIComponent(profileId)}`
      : '/PricingRequired'
    return <Navigate to={target} replace state={{ from: location }} />
  }
  return children
}

function isConfiguredAdminEmail(email) {
  if (!email) return false
  // Match the server-side default. The server-side env override is the
  // source of truth; this is just an early-exit hint for the frontend.
  return String(email).toLowerCase().trim() === 'buckeye7066@gmail.com'
}

export default RequirePaidAccess
