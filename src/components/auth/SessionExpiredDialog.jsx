import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useAuthStore } from '@/stores/authStore'
import AuthMethodTabs from './AuthMethodTabs'
import { AlertCircle } from 'lucide-react'

const AUTH_TABS = new Set(['email', 'phone', 'social'])

export default function SessionExpiredDialog() {
  const appBase = useMemo(() => import.meta.env.VITE_APP_BASE ?? '/grantflow', [])
  const {
    sessionExpired,
    sessionMessage,
    closeSessionExpired,
    preferredAuthMethod,
    setPreferredAuthMethod,
  } = useAuthStore((state) => ({
    sessionExpired: state.sessionExpired,
    sessionMessage: state.sessionMessage,
    closeSessionExpired: state.closeSessionExpired,
    preferredAuthMethod: state.preferredAuthMethod,
    setPreferredAuthMethod: state.setPreferredAuthMethod,
  }))
  const [activeTab, setActiveTab] = useState(
    AUTH_TABS.has(preferredAuthMethod) ? preferredAuthMethod : 'email',
  )

  useEffect(() => {
    const preferred = AUTH_TABS.has(preferredAuthMethod) ? preferredAuthMethod : 'email'
    setActiveTab(preferred)
  }, [preferredAuthMethod])

  useEffect(() => {
    if (AUTH_TABS.has(activeTab) && activeTab !== preferredAuthMethod) {
      setPreferredAuthMethod(activeTab)
    }
  }, [activeTab, preferredAuthMethod, setPreferredAuthMethod])

  const handleLoginRedirect = () => {
    closeSessionExpired()
    const normalized = appBase.endsWith('/') ? appBase.slice(0, -1) : appBase
    window.location.href = `${normalized}/login`
  }

  const handleReauthComplete = () => {
    closeSessionExpired()
  }

  return (
    <Dialog open={sessionExpired} onOpenChange={(open) => !open && closeSessionExpired()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            Session expired
          </DialogTitle>
          <DialogDescription>
            {sessionMessage ?? 'Your session has expired. Sign in again to keep working without losing progress.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <AuthMethodTabs value={activeTab} onValueChange={setActiveTab} onComplete={handleReauthComplete} />

          <div className="flex flex-col gap-2 text-xs text-slate-500">
            <p>
              Prefer to start fresh?{' '}
              <button onClick={handleLoginRedirect} className="text-blue-600 hover:underline">
                Return to the login page.
              </button>
            </p>
            <p>Need help? Contact the GrantFlow admin team and reference code GF-401.</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
