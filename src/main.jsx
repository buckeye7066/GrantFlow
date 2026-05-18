import ReactDOM from 'react-dom/client'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '@/App.jsx'
import '@/index.css'
import { DashboardPreferencesProvider } from '@/contexts/DashboardPreferencesContext.jsx'
import { enforceCanonicalHost } from '@/utils/enforceCanonicalHost.js'
import { enforceBasename } from '@/utils/enforceBasename.js'
import { registerQueryClient } from '@/stores/authStore'
import { migrateLegacyProfileScopedKeys } from '@/utils/profileScopedStorage'

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
      <DashboardPreferencesProvider>
        <App />
      </DashboardPreferencesProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)