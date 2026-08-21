import React, { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

import { useAuthStore } from '@/stores/authStore'
import { accessGateApi } from '@/api/accessGate'

/**
 * Wraps a route element. Until `/api/access-gate/status` confirms that the
 * server authorizes the user (paid, waived, or admin), the user is redirected
 * to `/PricingRequired?profile_id=<active>`.
 *
 * No browser-side role or email claim can bypass this check. Anonymous users
 * fall through to the existing auth redirect (this component does not handle
 * login redirect — `LayoutRoutes` already does that upstream).
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

  const [retryAttempt, setRetryAttempt] = useState(0)
  const identityKey = user?.id || user?.userId || user?.user_id || (user ? 'authenticated' : 'anonymous')
  const requestKey = `${identityKey}:${profileId || 'no-profile'}:${location.pathname}:${retryAttempt}`
  const [state, setState] = useState({ status: 'checking', payload: null, requestKey: null })

  useEffect(() => {
    let cancelled = false
    if (!user) {
      setState({ status: 'anonymous', payload: null, requestKey })
      return () => { cancelled = true }
    }

    setState({ status: 'checking', payload: null, requestKey })
    accessGateApi
      .status(profileId)
      .then((r) => {
        if (cancelled) return
        if (r?.ok !== true || r?.authenticated !== true) {
          setState({ status: 'error', payload: null, requestKey })
        } else if (r.access_granted === true) {
          setState({ status: 'allowed', payload: r, requestKey })
        } else {
          setState({ status: 'blocked', payload: r, requestKey })
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', payload: null, requestKey })
      })
    return () => { cancelled = true }
  }, [user, profileId, location.pathname, requestKey])

  if (state.requestKey !== requestKey || state.status === 'checking') return fallback
  if (state.status === 'anonymous') return null // upstream LayoutRoutes handles unauth redirect
  if (state.status === 'error') {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-6 text-slate-900 dark:text-slate-100" role="alert">
        <h2 className="text-lg font-semibold">We couldn’t verify your access</h2>
        <p className="mt-2 text-sm">
          GrantFlow is keeping this workspace locked until the server confirms your access. Check your connection and try again.
        </p>
        <button
          type="button"
          className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
          onClick={() => setRetryAttempt((attempt) => attempt + 1)}
        >
          Try again
        </button>
      </div>
    )
  }
  if (state.status === 'blocked') {
    const target = profileId
      ? `/PricingRequired?profile_id=${encodeURIComponent(profileId)}`
      : '/PricingRequired'
    return <Navigate to={target} replace state={{ from: location }} />
  }
  return children
}

export default RequirePaidAccess
