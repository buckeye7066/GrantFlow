import React, { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast as sonnerToast } from 'sonner'
import { useAuthStore } from '@/stores/authStore'
import { pricingApi } from '@/api/pricing'

const POLL_INTERVAL_MS = 30_000

function isAdminTarget(user) {
  if (!user) return false
  return user.is_admin === true || user.is_admin === 1 || user.role === 'admin'
}

/**
 * Mount once near the app root. While the configured admin is logged in,
 * polls /api/pricing/admin-notifications and shows browser-level
 * notifications + toasts.
 *
 * The server first confirms the DB-backed account is the configured queue
 * recipient. On the first eligible mount we flush notifications that arrived
 * while that operator was offline.
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
    let pollTimer = null

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

    async function beginIfEligible() {
      try {
        const capability = await pricingApi.adminNotificationCapability()
        if (cancelled || capability?.can_receive_pricing_notifications !== true) return
        await flushQueued()
        await poll()
        if (!cancelled) pollTimer = setInterval(poll, POLL_INTERVAL_MS)
      } catch {/* fail closed: do not poll a queue the server did not authorize */}
    }

    beginIfEligible().catch(() => {})
    return () => {
      cancelled = true
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [user, navigate, toastFn])

  return null
}

export default AdminPricingToastListener
