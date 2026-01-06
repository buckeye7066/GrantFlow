import { useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'
import AuthMethodTabs from '@/components/auth/AuthMethodTabs'
import AuthErrorBoundary from '@/components/auth/AuthErrorBoundary'
import { useAuthStore } from '@/stores/authStore'

const AUTH_TABS = new Set(['email'])

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    isAuthenticated,
    sessionExpired,
    closeSessionExpired,
  } = useAuthStore((state) => ({
    isAuthenticated: state.isAuthenticated,
    sessionExpired: state.sessionExpired,
    closeSessionExpired: state.closeSessionExpired,
  }))

  useEffect(() => {
    if (sessionExpired) {
      closeSessionExpired()
    }
  }, [sessionExpired, closeSessionExpired])

  const redirectTarget = useMemo(() => {
    const fallback = '/Dashboard'
    const from = location.state?.from
    const fromPath = typeof from?.pathname === 'string' ? from.pathname : null
    if (!fromPath) return fallback
    return fromPath.toLowerCase().startsWith('/login') ? fallback : fromPath
  }, [location.state])

  useEffect(() => {
    if (isAuthenticated) {
      navigate(redirectTarget, { replace: true })
    }
  }, [isAuthenticated, navigate, redirectTarget])

  const handleComplete = (result) => {
    if (result?.tokenType && result?.accessToken) {
      navigate(redirectTarget, { replace: true })
    }
  }

  const handleErrorReset = () => {
    // Optional: Add any cleanup or state reset logic here
    console.log('[Login] Error boundary reset')
  }

  return (
    <AuthErrorBoundary onReset={handleErrorReset}>
      <AuthShell
        title="Sign in to GrantFlow"
        subtitle="Enter your email address to get started."
      >
        <AuthMethodExpiryNotice />
        <AuthMethodTabs onComplete={handleComplete} />
      </AuthShell>
    </AuthErrorBoundary>
  )
}

function AuthMethodExpiryNotice() {
  return (
    <div className="mb-6 rounded-lg border border-blue-100 bg-blue-50/70 p-3 text-sm text-slate-700">
      We'll send a 6-digit verification code to your email for secure authentication. The code expires after 10 minutes.
    </div>
  )
}
