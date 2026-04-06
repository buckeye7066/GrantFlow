import ReactDOM from 'react-dom/client'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '@/App.jsx'
import '@/index.css'
import { DashboardPreferencesProvider } from '@/contexts/DashboardPreferencesContext.jsx'
import { enforceCanonicalHost } from '@/utils/enforceCanonicalHost.js'
import { enforceBasename } from '@/utils/enforceBasename.js'

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