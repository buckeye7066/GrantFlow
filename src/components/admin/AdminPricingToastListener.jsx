import React, { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast as sonnerToast } from 'sonner'
import { useAuthStore } from '@/stores/authStore'
import { pricingApi } from '@/api/pricing'

const POLL_INTERVAL_MS = 30_000
const ADMIN_EMAIL = 'buckeye7066@gmail.com'

function isAdminTarget(user) {
  if (!user) return false
  return String(user.email || '').toLowerCase().trim() === ADMIN_EMAIL
}

/**
 * Mount once near the app root. While the configured admin is logged in,
 * polls /api/pricing/admin-notifications and shows browser-level
 * notifications + toasts.
 *
 * On the FIRST mount after login we also call the flush-queued endpoint
 * so the admin sees notifications that arrived while they were offline.
 */
export function AdminPricingToastListener({ toast }) {
  const user = useAuthStore((s) => s.user)
  const toastFn = typeof toast === 'function'
    ? toast
    : ({ title, description, action }) => {
        sonnerToast(title || 'New GrantFlow client priced', {
          description: description || '',
          action: action ? { label: action.label, onClick: action.onClick } : undefined,
        })
      }
  const navigate = useNavigate()
  const seenRef = useRef(new Set())
  const flushedRef = useRef(false)

  useEffect(() => {
    if (!isAdminTarget(user)) return undefined

    let cancelled = false

    async function flushQueued() {
      if (flushedRef.current) return
      flushedRef.current = true
      try {
        const r = await pricingApi.flushQueuedAdminNotifications()
        if (cancelled || !r?.ok) return
        for (const n of r.items || []) {
          if (seenRef.current.has(n.id)) continue
          seenRef.current.add(n.id)
          showToast(n, 'on_login')
        }
      } catch {/* ignore */}
    }

    async function poll() {
      try {
        const r = await pricingApi.listAdminNotifications({ status: 'queued', limit: 25 })
        if (cancelled || !r?.ok) return
        for (const n of r.items || []) {
          if (seenRef.current.has(n.id)) continue
          seenRef.current.add(n.id)
          showToast(n, 'live')
        }
      } catch {/* ignore */}
    }

    function showToast(n, mode) {
      toastFn({
        title: n.title || 'New GrantFlow client priced',
        description: n.body || '',
        action: {
          label: 'View Quote',
          onClick: () => {
            const qid = n.quote_id
            if (qid) navigate(`/Admin/Pricing?quote_id=${encodeURIComponent(qid)}`)
            else navigate('/Admin/Pricing')
            pricingApi.dismissAdminNotification(n.id).catch(() => {})
          },
        },
      })
      pricingApi.markAdminNotificationDelivered(n.id, mode).catch(() => {})
    }

    flushQueued().then(poll).catch(() => {})
    const id = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [user, navigate, toastFn])

  return null
}

export default AdminPricingToastListener
