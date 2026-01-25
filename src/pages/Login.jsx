import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'
import AuthMethodTabs from '@/components/auth/AuthMethodTabs'
import AuthErrorBoundary from '@/components/auth/AuthErrorBoundary'
import { useAuthStore } from '@/stores/authStore'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

const AUTH_TABS = new Set(['email'])

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const [devLoading, setDevLoading] = useState(false)
  const {
    isAuthenticated,
    sessionExpired,
    closeSessionExpired,
    loginWithTokens,
  } = useAuthStore((state) => ({
    isAuthenticated: state.isAuthenticated,
    sessionExpired: state.sessionExpired,
    closeSessionExpired: state.closeSessionExpired,
    loginWithTokens: state.loginWithTokens,
  }))

  const showDevAdminShortcut = useMemo(() => {
    if (typeof window === 'undefined') return false
    const host = window.location.hostname
    return host === 'localhost' || host === '127.0.0.1'
  }, [])

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
  }

  const handleDevAdminLogin = async () => {
    if (!showDevAdminShortcut) return
    setDevLoading(true)
    try {
      // Local dev default (matches `backend/env.example`). Override if needed:
      // set `VITE_DEV_ADMIN_TOKEN` in your `.env.local`.
      const token = import.meta.env.VITE_DEV_ADMIN_TOKEN || 'dev-admin-token'
      await loginWithTokens({ accessToken: token })
      navigate(redirectTarget, { replace: true })
    } catch (error) {
      console.error('[Login] Dev admin login failed:', error)
      window.alert(`Dev admin login failed: ${error?.message || error}`)
    } finally {
      setDevLoading(false)
    }
  }

  return (
    <AuthErrorBoundary onReset={handleErrorReset}>
      <AuthShell
        title="Sign in to GrantFlow"
        subtitle="Enter your email address to get started."
      >
        <AuthMethodExpiryNotice />
        <AuthMethodTabs onComplete={handleComplete} />
        <div className="mt-6 pt-6 border-t border-slate-200 text-center">
          <Link
            to="/ServiceApplication"
            className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline"
          >
            New user? Apply for grant writing services
            <ArrowRight className="h-4 w-4" />
          </Link>

          {showDevAdminShortcut ? (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={handleDevAdminLogin} disabled={devLoading}>
                {devLoading ? 'Logging in…' : 'Dev: Login as Admin'}
              </Button>
            </div>
          ) : null}
        </div>
      </AuthShell>
    </AuthErrorBoundary>
  )
}

function AuthMethodExpiryNotice() {
  return (
    <div className="mb-6 rounded-lg border border-blue-100 bg-blue-50/70 p-3 text-sm text-slate-700">
      First-time sign-in uses a one-time email link to set your password. Returning users can sign in with email + password.
    </div>
  )
}
