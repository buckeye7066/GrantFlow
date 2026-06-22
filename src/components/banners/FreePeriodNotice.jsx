import React, { useEffect, useState } from 'react'
import { Gift, X } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { getBillingOverview } from '@/api/billing'
import { apiFetch } from '@/api/client'

/**
 * First-login notice that a free week/month has started on the active profile.
 * Driven by the backend free_notice_pending flag (set whenever the owner grants
 * a free period, individually or globally). Shown once: we acknowledge the
 * notice as soon as it renders so it doesn't reappear on the next page, while
 * staying dismissible for this session.
 *
 * Mounted exactly once in Layout.jsx (alongside ProBonoBanner). Do NOT mount
 * elsewhere or it would double-fire the acknowledgement.
 */
export default function FreePeriodNotice() {
  const activeProfileId = useAuthStore((s) => s.activeProfileId)
  const [notice, setNotice] = useState(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    // The admin "all profiles" sentinel has no single billing account.
    if (!activeProfileId || activeProfileId === '__admin__') {
      setNotice(null)
      return
    }
    setDismissed(false)
    ;(async () => {
      try {
        const overview = await getBillingOverview(activeProfileId)
        const free = overview?.free_period
        if (cancelled || !free?.active || !free?.notice_pending) return
        setNotice(free)
        // Acknowledge immediately so it shows only on this first login.
        apiFetch(`/api/billing/me/${activeProfileId}/free-notice/ack`, { method: 'POST' }).catch(() => {})
      } catch {
        // Best-effort: a billing read failure must never block the app.
      }
    })()
    return () => { cancelled = true }
  }, [activeProfileId])

  if (!notice || dismissed) return null

  const kindLabel = notice.kind === 'month' ? 'free month' : 'free week'
  const started = notice.granted_at ? new Date(notice.granted_at).toLocaleDateString() : 'today'
  const through = notice.until ? new Date(notice.until).toLocaleDateString() : null

  return (
    <div className="mx-4 mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
      <Gift className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-800">Your {kindLabel} has started! 🎉</p>
        <p className="text-xs text-amber-700 mt-0.5">
          It began on {started}{through ? ` and runs through ${through}` : ''}. You won't be invoiced during this time.
        </p>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="p-1 rounded-md hover:bg-amber-100 text-amber-700"
        title="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
