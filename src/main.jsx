import ReactDOM from 'react-dom/client'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '@/App.jsx'
import '@/index.css'
import { DashboardPreferencesProvider } from '@/contexts/DashboardPreferencesContext.jsx'
import { enforceCanonicalHost } from '@/utils/enforceCanonicalHost.js'

const queryClient = new QueryClient()

enforceCanonicalHost()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <DashboardPreferencesProvider>
        <App />
      </DashboardPreferencesProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)