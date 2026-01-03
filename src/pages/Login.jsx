import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'
import AuthMethodTabs from '@/components/auth/AuthMethodTabs'
import { useAuthStore } from '@/stores/authStore'

const AUTH_TABS = new Set(['email'])

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    isAuthenticated,
    sessionExpired,
    closeSessionExpired,
    preferredAuthMethod,
    setPreferredAuthMethod,
  } = useAuthStore((state) => ({
    isAuthenticated: state.isAuthenticated,
    sessionExpired: state.sessionExpired,
    closeSessionExpired: state.closeSessionExpired,
    preferredAuthMethod: state.preferredAuthMethod,
    setPreferredAuthMethod: state.setPreferredAuthMethod,
  }))

  const requestedMethod = searchParams.get('method') ?? undefined
  const fallbackMethod = useMemo(
    () => (preferredAuthMethod && AUTH_TABS.has(preferredAuthMethod) ? preferredAuthMethod : 'email'),
    [preferredAuthMethod],
  )
  const initialTab = useMemo(() => {
    if (requestedMethod && AUTH_TABS.has(requestedMethod)) {
      return requestedMethod
    }
    return fallbackMethod
  }, [requestedMethod, fallbackMethod])
  const [activeTab, setActiveTab] = useState(initialTab)

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    if (sessionExpired) {
      closeSessionExpired()
    }
  }, [sessionExpired, closeSessionExpired])

  useEffect(() => {
    const current = requestedMethod ?? 'email'
    if (current === activeTab) {
      return
    }
    const nextParams = new URLSearchParams(location.search)
    if (activeTab === 'email') {
      nextParams.delete('method')
    } else {
      nextParams.set('method', activeTab)
    }
    setSearchParams(nextParams, { replace: true })
  }, [activeTab, requestedMethod, location.search, setSearchParams])

  useEffect(() => {
    if (!sessionExpired && AUTH_TABS.has(activeTab) && activeTab !== preferredAuthMethod) {
      setPreferredAuthMethod(activeTab)
    }
  }, [activeTab, preferredAuthMethod, setPreferredAuthMethod, sessionExpired])

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
      subtitle="Access your scholarships, grants, and partner accounts."
    >
      <AuthMethodExpiryNotice />
      <AuthMethodTabs value={activeTab} onValueChange={setActiveTab} onComplete={handleComplete} />
    </AuthShell>
  )
}

function AuthMethodExpiryNotice() {
  return (
    <div className="mb-6 rounded-lg border border-blue-100 bg-blue-50/70 p-3 text-sm text-slate-700">
      Email passcodes are available for authentication. Tokens refresh automatically once you're in.
    </div>
  )
}
