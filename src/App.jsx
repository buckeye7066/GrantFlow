import { useEffect, useState, useRef } from 'react'
import { BrowserRouter as Router } from 'react-router-dom'
import './App.css'
import Pages from '@/pages/index.jsx'
import { Toaster } from '@/components/ui/toaster'
import SessionExpiredDialog from '@/components/auth/SessionExpiredDialog'
import HamiltonToastBridge from '@/components/hamilton/HamiltonToastBridge'
import HamiltonAuthPrimingToast from '@/components/hamilton/HamiltonAuthPrimingToast'
import ProfileCompletionGate from '@/components/onboarding/ProfileCompletionGate'
import MobileUpdateWatcher from '@/components/mobile/MobileUpdateWatcher'
import client from '@/api/client';
import RouteErrorBoundary from '@/components/shared/RouteErrorBoundary.jsx'
import FlashHighlighter from '@/components/shared/FlashHighlighter.jsx'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { env } from '@/config/env.js'
import { isTransientAuthCheckError, authCheckRetryDelaySeconds } from '@/lib/authBootstrapRetry.js'
function App() {
  const [bootstrapped, setBootstrapped] = useState(false)
  // Set while GET /api/auth/me is rate limited / failing server-side: the
  // session is NOT known to be invalid, so we wait and re-check instead of
  // rendering the sign-in page.
  const [authRetrySeconds, setAuthRetrySeconds] = useState(null)
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const guidedCycleTourStatus = useAuthStore((state) => state.guidedCycleTourStatus)
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

    // Access tokens are memory-only. auth.me() first exchanges the HttpOnly
    // refresh cookie when this is a reload, then validates the resulting access
    // token against the canonical identity endpoint.
    const attempt = () => {
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
          setAuthRetrySeconds(null)
          setBootstrapped(true)
        })
        .catch((error) => {
          // A rate limit or server fault is not proof the session is invalid:
          // keep the session and re-check after the server's retry hint.
          if (isTransientAuthCheckError(error)) {
            const seconds = authCheckRetryDelaySeconds(error)
            setAuthRetrySeconds(seconds)
            setTimeout(attempt, seconds * 1000)
            return
          }
          // Token is invalid or expired, clear state
          clearState()
          setAuthRetrySeconds(null)
          setBootstrapped(true)
        })
    }
    attempt()
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
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500" role="status">
        {authRetrySeconds
          ? `GrantFlow is busy right now. Retrying in ${authRetrySeconds}s — you are still signed in.`
          : 'Loading your workspace…'}
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
      <FlashHighlighter />
      <SessionExpiredDialog />
      <HamiltonToastBridge />
      <HamiltonAuthPrimingToast />
      {/* Native-only: checks the OTA feed on launch and on every resume, raises
          a local notification, and puts the install button one tap away.
          Renders null on the web and until an update is actually found. */}
      <MobileUpdateWatcher />
      {/* Anya's login-time gap interview is NOT mounted globally any more.
          Owner order 2026-09-07 ("take away the anya interview initially"): it
          covered every page at sign-in and asked a senior whether he was a
          student before he could see where to go. The interview still runs
          where the person asks for it: the profile Overview mount
          (ProfileOverview.jsx) and the explicit ResetOnboardingFlow sequence,
          which renders its own LoginGapInterviewLauncher. */}
      {/* BLOCKING profile-completion gate: while a non-admin's profile is
          missing data points required for its type, Anya asks the numbered
          questions ("1 of N" … "N of N") before the user can proceed. Renders
          null unless the auth payload's profile_completion reports `blocked`. */}
      <ProfileCompletionGate />
    </Router>
  )
}

export default App
