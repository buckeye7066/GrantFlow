import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '@/App.jsx'
import '@/index.css'
import { DashboardPreferencesProvider } from '@/contexts/DashboardPreferencesContext.jsx'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <DashboardPreferencesProvider>
      <App />
    </DashboardPreferencesProvider>
  </QueryClientProvider>,
)