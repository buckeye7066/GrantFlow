import React, { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/authStore'
import { useLanguage } from '@/i18n'

export default function LogoutButton({ className }) {
  const logout = useAuthStore(state => state.logout)
  const navigate = useNavigate()
  const { t } = useLanguage()
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)

  async function handleLogout() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await logout()
    } catch {
      // The auth store clears local credentials and caches in its finally
      // block even when the server cannot be reached.
    } finally {
      navigate('/login', { replace: true })
    }
  }

  return <Button type="button" variant="outline" size="sm" className={className}
    onClick={handleLogout} disabled={busy} aria-busy={busy}>
    <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
    {t('layout.logout')}
  </Button>
}
