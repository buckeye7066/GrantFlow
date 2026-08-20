import { useEffect, useMemo } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'
import AuthMethodTabs from '@/components/auth/AuthMethodTabs'
import AuthErrorBoundary from '@/components/auth/AuthErrorBoundary'
import { useAuthStore } from '@/stores/authStore'
import { ArrowRight } from 'lucide-react'

const AUTH_TABS = new Set(['email'])

export default function Login() {
    const navigate = useNavigate()
    const location = useLocation()


  // FIX: Use individual selectors instead of an object selector.
  // An object selector (state => ({ ... })) creates a new object reference on
  // every Zustand state change, causing infinite re-renders because Zustand's
  // default equality check (Object.is) always sees a new object.
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
    const closeSessionExpired = useAuthStore((state) => state.closeSessionExpired)

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
                        </div>
                </AuthShell>
        </AuthErrorBoundary>
      )
}

function AuthMethodExpiryNotice() {
    return (
          <div className="mb-6 rounded-lg border border-blue-100 dark:border-blue-900 bg-blue-50/70 dark:bg-blue-950/40 p-3 text-sm text-slate-700 dark:text-slate-100">
                First-time sign-in uses a one-time email link to set your password.
                Returning users can sign in with email + password.
          </div>
        )
}
