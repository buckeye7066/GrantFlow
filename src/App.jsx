import { useEffect, useState } from 'react'
import './App.css'
import Pages from '@/pages/index.jsx'
import { Toaster } from '@/components/ui/toaster'
import SessionExpiredDialog from '@/components/auth/SessionExpiredDialog'
import { base44 } from '@/api/base44Client'
import { useAuthStore } from '@/stores/authStore'
import { AppErrorBoundary } from '@/components/shared/AppErrorBoundary.jsx'

function App() {
  const [bootstrapped, setBootstrapped] = useState(false)
  const hydrateFromStorage = useAuthStore((state) => state.hydrateFromStorage)
  const setAuthenticatedUser = useAuthStore((state) => state.setAuthenticatedUser)
  const clearState = useAuthStore((state) => state.clearState)

  useEffect(() => {
    hydrateFromStorage()

    const accessToken = base44.getToken?.()
    if (!accessToken) {
      setBootstrapped(true)
      return
    }

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

  return (
    <>
      <AppErrorBoundary fallbackMessage="Reload the page to keep working.">
        <Pages />
      </AppErrorBoundary>
      <Toaster />
      <SessionExpiredDialog />
    </>
  )
}

export default App