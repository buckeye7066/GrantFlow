import { useEffect, useState, useRef } from 'react'
import { BrowserRouter as Router } from 'react-router-dom'
import './App.css'
import Pages from '@/pages/index.jsx'
import { Toaster } from '@/components/ui/toaster'
import SessionExpiredDialog from '@/components/auth/SessionExpiredDialog'
import HamiltonToastBridge from '@/components/hamilton/HamiltonToastBridge'
import client from '@/api/client';
import RouteErrorBoundary from '@/components/shared/RouteErrorBoundary.jsx'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { env } from '@/config/env.js'
function App() {
  const [bootstrapped, setBootstrapped] = useState(false)
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const fetchPreferences = useSettingsStore((state) => state.fetchPreferences)
  const isPreferencesInitialized = useSettingsStore((state) => state.isInitialized)
  // Ref guard: ensures bootstrap runs exactly once, even if the component re-renders
  // before the async flow completes.
  const bootstrapAttempted = useRef(false)

  useEffect(() => {
    // Guard against re-entrant or repeated bootstrap calls.
    if (bootstrapAttempted.current) return
    bootstrapAttempted.current = true

    // Access store actions directly (not as React state) so this effect has a
    // stable, empty dependency array and never re-fires due to reference changes.
    const { hydrateFromStorage, setAuthenticatedUser, clearState } = useAuthStore.getState()

    hydrateFromStorage()

    const accessToken = client.getToken?.()
    if (!accessToken) {
      // No token present, clear any stale state and mark as bootstrapped
      clearState()
      setBootstrapped(true)
      return
    }

    // Token exists, validate it with the server.
    // auth.me() handles proactive token refresh via the single-flight
    // refreshTokens() path, so any concurrent refresh timer from
    // hydrateFromStorage's scheduleSessionRefresh shares the same promise.
    client.auth
      .me()
      .then((response) => {
        if (response) {
          setAuthenticatedUser(response)
          // Reschedule the session refresh timer based on the validated/refreshed
          // token expiry. This cancels any stale timer that hydrateFromStorage may
          // have scheduled with an outdated expiry, preventing a redundant refresh
          // call that could race with future API requests.
          const { scheduleSessionRefresh } = useAuthStore.getState()
          if (response.expiresIn || response.accessExpires || response.refreshExpires) {
            scheduleSessionRefresh(response)
          }
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
  }, []) // Empty dep array — bootstrap runs exactly once on mount

  // Load persisted UI preferences once auth bootstrap is complete and the user is
  // authenticated. Gating on `bootstrapped` prevents a race where hydrateFromStorage
  // briefly sets tokens (making isAuthenticated true in a future render) before
  // auth.me() finishes validating — firing fetchPreferences with a stale access token.
  useEffect(() => {
    if (!bootstrapped) return
    if (!isAuthenticated) return
    if (isPreferencesInitialized) return
    fetchPreferences()
  }, [bootstrapped, isAuthenticated, isPreferencesInitialized, fetchPreferences])

  if (!bootstrapped) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading your workspace…
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
      <HamiltonToastBridge />
    </Router>
  )
}

export default App