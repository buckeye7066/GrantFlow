import ReactDOM from 'react-dom/client'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '@/App.jsx'
import '@/index.css'
import { DashboardPreferencesProvider } from '@/contexts/DashboardPreferencesContext.jsx'
import { LanguageProvider } from '@/i18n'
import { enforceCanonicalHost } from '@/utils/enforceCanonicalHost.js'
import { enforceBasename } from '@/utils/enforceBasename.js'
import { registerQueryClient } from '@/stores/authStore'
import { migrateLegacyProfileScopedKeys } from '@/utils/profileScopedStorage'
import { maybeReloadForStaleChunk } from '@/utils/lazyWithRetry'
import { captureFrontendException, initFrontendObservability } from '@/utils/observability.js'

initFrontendObservability()

// Global stale-chunk recovery. After a deploy, the open tab still references
// chunk hashes that no longer exist; a dynamic import() then fails. lazyWithRetry
// handles lazy routes, but raw import()s and Vite's modulepreload surface here:
//   - `vite:preloadError`  — Vite's own event for a failed modulepreload (cancelable)
//   - `unhandledrejection` — a rejected dynamic import() not caught by a boundary
// Both delegate to the same dedupe so we reload at most once, then let the
// RouteErrorBoundary show its message if the chunk is genuinely gone.
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    if (maybeReloadForStaleChunk(event?.payload ?? event)) {
      event.preventDefault?.()
      return
    }
    captureFrontendException(event?.payload ?? event, { area: 'vite_preload' })
  })
  window.addEventListener('unhandledrejection', (event) => {
    if (maybeReloadForStaleChunk(event?.reason)) {
      event.preventDefault?.()
      return
    }
    captureFrontendException(event?.reason, { area: 'unhandledrejection' })
  })
  window.addEventListener('error', (event) => {
    captureFrontendException(event?.error || event?.message || event, {
      area: 'window_error',
      source: event?.filename,
      line: event?.lineno,
      column: event?.colno,
    })
  })
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
      refetchOnReconnect: 'always',
    },
  },
})

// Register the queryClient with the auth store so profile switches and
// logout can purge profile-bound queries (Goal 3 in PROFILE_SCOPING.md).
registerQueryClient(queryClient)

// One-time migration: drop legacy unscoped versions of keys that should now
// be profile-scoped. Idempotent — safe to run on every boot.
try { migrateLegacyProfileScopedKeys() } catch { /* ignore storage errors */ }

enforceCanonicalHost()
enforceBasename()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <DashboardPreferencesProvider>
          <App />
        </DashboardPreferencesProvider>
      </LanguageProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
