/**
 * YanaToastBridge
 *
 * Polls the same /api/notifications endpoint NotificationBell uses and
 * surfaces brand-new yana_* notifications as toasts. Every notification
 * is also still visible in the bell — toasts are immediate UI feedback;
 * persistent notifications are the source of truth (per the
 * spec "toast helper logic so Yana alerts do not vanish if a toast
 * times out").
 *
 * The bridge tracks notification ids it has already toasted in
 * sessionStorage so refreshing the page doesn't re-toast everything; we
 * still re-show toasts on a brand-new browser session.
 */

import React, { useEffect, useRef } from 'react'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { useToast } from '@/components/ui/use-toast'
import { showInfoToast, showWarningToast, showErrorToast, showSuccessToast } from '@/components/shared/toastHelpers'

const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes — faster than the bell so toasts are timely
const STORAGE_KEY = 'yana_toasted_notifications_v1'

const YANA_TYPES = new Set([
  'yana_missing_info',
  'yana_login_required',
  'yana_document_required',
  'yana_review_required',
  'yana_application_ready',
  'yana_application_submitted',
  'yana_application_blocked',
  'yana_application_failed',
])

function loadSeenSet() {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveSeenSet(set) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // ignore quota errors
  }
}

function pickToaster(notification, toast) {
  const severity = notification?.data?.severity || severityForType(notification?.type)
  switch (severity) {
    case 'error': return showErrorToast.bind(null, toast)
    case 'warning': return showWarningToast.bind(null, toast)
    case 'success': return showSuccessToast.bind(null, toast)
    default: return showInfoToast.bind(null, toast)
  }
}

function severityForType(type) {
  switch (type) {
    case 'yana_application_submitted': return 'success'
    case 'yana_application_failed': return 'error'
    case 'yana_application_blocked':
    case 'yana_login_required':
    case 'yana_document_required':
    case 'yana_missing_info':
      return 'warning'
    default: return 'info'
  }
}

export default function YanaToastBridge() {
  const { toast } = useToast()
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const seenRef = useRef(loadSeenSet())

  useEffect(() => {
    if (!isAuthenticated) return undefined
    let cancelled = false

    async function tick() {
      try {
        const data = await apiFetch('/api/notifications')
        if (cancelled || !Array.isArray(data?.notifications)) return
        let dirty = false
        for (const n of data.notifications) {
          if (!n || !YANA_TYPES.has(n.type)) continue
          if (n.read) continue
          if (seenRef.current.has(n.id)) continue
          const fire = pickToaster(n, toast)
          fire(n.title || 'Yana update', n.message || '')
          seenRef.current.add(n.id)
          dirty = true
        }
        if (dirty) saveSeenSet(seenRef.current)
      } catch {
        // silent — notifications are best-effort
      }
    }

    tick()
    const handle = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [isAuthenticated, toast])

  return null
}
