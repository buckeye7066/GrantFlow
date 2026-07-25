import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'
import AuthMethodTabs from '@/components/auth/AuthMethodTabs'
import AuthErrorBoundary from '@/components/auth/AuthErrorBoundary'
import { useAuthStore } from '@/stores/authStore'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isNativeApp } from '@/lib/platform'
import { LOGIN_MAINTENANCE, isLoginMaintenanceActive } from '@/config/maintenance'
import LoginMaintenanceNotice from '@/components/auth/LoginMaintenanceNotice'

const AUTH_TABS = new Set(['email'])

export default function Login() {
    const navigate = useNavigate()
    const location = useLocation()
    const [devLoading, setDevLoading] = useState(false)

  // FIX: Use individual selectors instead of an object selector.
  // An object selector (state => ({ ... })) creates a new object reference on
  // every Zustand state change, causing infinite re-renders because Zustand's
  // default equality check (Object.is) always sees a new object.
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
    const closeSessionExpired = useAuthStore((state) => state.closeSessionExpired)
    const loginWithTokens = useAuthStore((state) => state.loginWithTokens)

  const showDevAdminShortcut = useMemo(() => {
        if (typeof window === 'undefined') return false
        // The Capacitor app's origin IS https://localhost, so a bare
        // hostname check showed this dev-only button to every mobile-app
        // user (harmless without VITE_DEV_ADMIN_TOKEN, but it reads like a
        // debug backdoor to a store reviewer).
        if (isNativeApp()) return false
        const host = window.location.hostname
        return host === 'localhost' || host === '127.0.0.1'
  }, [])

  // Clear any stale sessionExpired state on mount only.
  // We do this once at mount (not reactively) to avoid the state oscillation
  // that causes the login-page flash: a reactive dep on sessionExpired triggers
  // closeSessionExpired() → sets it false → re-render → repeat.
  useEffect(() => {
    closeSessionExpired()

  }, [])

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
                // Dev-only convenience: requires explicit token, never a default.
          const token = import.meta.env.VITE_DEV_ADMIN_TOKEN
                if (!token) {
                          window.alert('Missing VITE_DEV_ADMIN_TOKEN. Set it in your `.env.local` to use Dev Admin Login.')
                          return
                }
                await loginWithTokens({ accessToken: token })
                navigate(redirectTarget, { replace: true })
        } catch (error) {
                console.error('[Login] Dev admin login failed:', error)
                window.alert(`Dev admin login failed: ${error?.message || error}`)
        } finally {
                setDevLoading(false)
        }
  }

  if (isLoginMaintenanceActive()) {
        return (
              <AuthErrorBoundary onReset={handleErrorReset}>
                      <AuthShell
                                title={LOGIN_MAINTENANCE.title}
                                subtitle="Thanks for your patience while we make GrantFlow better."
                              >
                              <LoginMaintenanceNotice />
                      </AuthShell>
              </AuthErrorBoundary>
            )
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
                                                to="/start"
                                                className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline"
                                              >
                                              New to GrantFlow? Take the 2-minute quiz with Anya
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
                First-time sign-in uses a one-time email link to set your password.
                Returning users can sign in with email + password.
          </div>
        )
}
