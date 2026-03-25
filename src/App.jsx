import { useEffect, useState } from 'react'
import { BrowserRouter as Router } from 'react-router-dom'
import './App.css'
import Pages from '@/pages/index.jsx'
import { Toaster } from '@/components/ui/toaster'
import SessionExpiredDialog from '@/components/auth/SessionExpiredDialog'
import client from '@/api/client';
import RouteErrorBoundary from '@/components/shared/RouteErrorBoundary.jsx'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { env } from '@/config/env.js'
function App() {
  const [bootstrapped, setBootstrapped] = useState(false)
  const hydrateFromStorage = useAuthStore((state) => state.hydrateFromStorage)
  const setAuthenticatedUser = useAuthStore((state) => state.setAuthenticatedUser)
  const clearState = useAuthStore((state) => state.clearState)
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const fetchPreferences = useSettingsStore((state) => state.fetchPreferences)
  const isPreferencesInitialized = useSettingsStore((state) => state.isInitialized)

  useEffect(() => {
    hydrateFromStorage()

    const accessToken = client.getToken?.()
    if (!accessToken) {
      // No token present, clear any stale state and mark as bootstrapped
      clearState()
      setBootstrapped(true)
      return
    }

    // Token exists, validate it with the server
    client.auth
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

  // Load persisted UI preferences once the user is authenticated so personalization
  // (accent color, font size, etc.) applies across the appâ€”not only on the Settings page.
  useEffect(() => {
    if (!isAuthenticated) return
    if (isPreferencesInitialized) return
    fetchPreferences()
  }, [isAuthenticated, isPreferencesInitialized, fetchPreferences])

  if (!bootstrapped) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading your workspaceâ€¦
      </div>
    )
  }

  const basename = env.appBase

  return (
    <Router basename={basename}>
      <RouteErrorBoundary routeName="app">
        <Pages />
      </RouteErrorBoundary>
      <Toaster />
      <SessionExpiredDialog />
    </Router>
  )
}

export default App