import { useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'
import AuthMethodTabs from '@/components/auth/AuthMethodTabs'
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

  return (
    <AuthShell
      title="Sign in to GrantFlow"
      subtitle="Enter your email to receive a secure login code."
    >
      <AuthMethodExpiryNotice />
      <AuthMethodTabs onComplete={handleComplete} />
    </AuthShell>
  )
}

function AuthMethodExpiryNotice() {
  return (
    <div className="mb-6 rounded-lg border border-blue-100 bg-blue-50/70 p-3 text-sm text-slate-700">
      Email passcodes are used for secure authentication. Enter your email to receive a verification code—tokens refresh automatically once you're signed in.
    </div>
  )
}
