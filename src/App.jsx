import { useEffect, useState } from 'react'
import { BrowserRouter as Router } from 'react-router-dom'
import './App.css'
import Pages from '@/pages/index.jsx'
import { Toaster } from '@/components/ui/toaster'
import SessionExpiredDialog from '@/components/auth/SessionExpiredDialog'
import OnboardingFlow from '@/components/onboarding/OnboardingFlow'
import { base44 } from '@/api/base44Client'
import { useAuthStore } from '@/stores/authStore'

function App() {
  const [bootstrapped, setBootstrapped] = useState(false)
  const hydrateFromStorage = useAuthStore((state) => state.hydrateFromStorage)
  const setAuthenticatedUser = useAuthStore((state) => state.setAuthenticatedUser)
  const clearState = useAuthStore((state) => state.clearState)

  useEffect(() => {
    hydrateFromStorage()

    const accessToken = base44.getToken?.()
    if (!accessToken) {
      // No token present, clear any stale state and mark as bootstrapped
      clearState()
      setBootstrapped(true)
      return
    }

    // Token exists, validate it with the server
    base44.auth
      .me()
      .then((response) => {
        if (response) {
          setAuthenticatedUser(response)
        } else {
          clearState()
        }
      })
      .catch(() => {
        // Token is invalid or expired, clear state
        clearState()
      })
      .finally(() => {
        setBootstrapped(true)
      })
  }, [hydrateFromStorage, setAuthenticatedUser, clearState])

  if (!bootstrapped) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading your workspace…
      </div>
    )
  }

  const basename = import.meta.env.VITE_APP_BASE ?? '/grantflow'

  return (
    <Router basename={basename}>
      <Pages />
      <OnboardingFlow />
      <Toaster />
      <SessionExpiredDialog />
    </Router>
  )
}

export default App