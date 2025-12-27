import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import { ExperienceProvider } from './contexts/ExperienceContext.tsx'
import { AdminProvider } from './contexts/AdminContext.tsx'
import './index.css'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <ExperienceProvider>
          <AdminProvider>
            <App />
          </AdminProvider>
        </ExperienceProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
