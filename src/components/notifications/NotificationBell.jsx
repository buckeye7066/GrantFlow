import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Bell } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { createPageUrl } from '@/utils'
import { buildProfileSectionLink } from '@/config/missingInfoTargets'
import { openAnyaPanel } from '@/lib/anyaPanel'
import { buildMissingInfoAnyaOpen } from '@/lib/hamiltonMissingInfoAnya'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

function formatRelativeTime(dateStr) {
  if (!dateStr) return ''
  const now = new Date()
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return ''
  const diffMs = now - date
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

function resolveNotificationTarget(notification) {
  const data = notification?.data || {}
  const type = String(notification?.type || '')
  const explicitRoute = data.route_to_resolve || data.add_credential_link || data.route_to_admin_task
  if (typeof explicitRoute === 'string' && explicitRoute.startsWith('/') && !explicitRoute.startsWith('//')) {
    return explicitRoute
  }
  const profileId = data.profile_id || data.profileId || notification?.profile_id || null
  if (!profileId) return null

  // A wall only a human can clear live (2FA push/SMS/hardware, CAPTCHA, identity
  // proofing) → the Portals tab with the exact portal flagged, so it shows a
  // clickable "Open side-by-side login" card.
  if (/2fa_required|captcha_required|identity_proof/.test(type)) {
    const raw = data.portal_host || data.host || data.portal_url || data.login_url || ''
    let host = ''
    try { host = raw ? new URL(String(raw).startsWith('http') ? raw : `https://${raw}`).hostname : '' } catch { host = String(raw).replace(/^https?:\/\//, '').split('/')[0] }
    const params = { id: profileId, tab: 'pipeline' }
    if (host) params.cobrowse = host
    return createPageUrl('ProfileDetail', params)
  }

  if (/login_required|portal_blocked/.test(type)) {
    return createPageUrl('ProfileDetail', { id: profileId, tab: 'pipeline', focus: 'portal-logins' })
  }

  // Email verification needed → the Portals tab (the user's step is in their
  // inbox; the tab shows the account's status and auto-resumes once verified).
  if (/email_verification/.test(type)) {
    return createPageUrl('ProfileDetail', { id: profileId, tab: 'pipeline', focus: 'portal-logins' })
  }

  if (/missing_info/.test(type)) {
    const key = data.field || data.missing_info_key || data.key || data.missing_field || data.blocker_key
    const link = key ? buildProfileSectionLink(profileId, key) : null
    return link || createPageUrl('ProfileDetail', { id: profileId, tab: 'profile' })
  }

  if (/document_required/.test(type)) {
    return createPageUrl('ProfileDetail', { id: profileId, tab: 'documents' })
  }

  if (/hamilton_/.test(type)) {
    return createPageUrl('Pipeline', { id: profileId })
  }

  return null
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const dropdownRef = useRef(null)
  const navigate = useNavigate()
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)

  const fetchNotifications = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const data = await apiFetch('/api/notifications')
      if (data && Array.isArray(data.notifications)) {
        setNotifications(data.notifications)
        setUnreadCount(data.unreadCount ?? 0)
      }
    } catch {
      // Non-fatal: notifications are best-effort
    }
  }, [isAuthenticated])

  // Initial fetch + periodic poll
  useEffect(() => {
    if (!isAuthenticated) return
    fetchNotifications()
    const handle = setInterval(fetchNotifications, POLL_INTERVAL_MS)
    return () => clearInterval(handle)
  }, [isAuthenticated, fetchNotifications])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  const handleToggle = () => {
    setOpen((prev) => !prev)
  }

  const handleMarkRead = useCallback(
    async (id) => {
      try {
        setLoading(true)
        await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' })
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
        )
        setUnreadCount((prev) => Math.max(0, prev - 1))
      } catch {
        // Ignore
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const handleMarkAllRead = useCallback(async () => {
    try {
      setLoading(true)
      await apiFetch('/api/notifications/read-all', { method: 'POST' })
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch {
      // Ignore
    } finally {
      setLoading(false)
    }
  }, [])

  const handleNotificationOpen = useCallback(
    async (notification) => {
      if (!notification) return
      if (!notification.read) {
        await handleMarkRead(notification.id)
      }
      // Conversational missing-info: open Anya prefilled to gather the exact
      // field(s) and save them to the profile (Hamilton then auto-resumes),
      // instead of dropping the user on the raw section editor.
      const anyaOpen = buildMissingInfoAnyaOpen(notification)
      if (anyaOpen) {
        setOpen(false)
        openAnyaPanel(anyaOpen)
        return
      }
      const target = resolveNotificationTarget(notification)
      if (target) {
        setOpen(false)
        navigate(target)
      }
    },
    [handleMarkRead, navigate],
  )

  // Anya Match Scout actions on a notification of type 'anya_high_match'.
  // The notification's `data.suggestion_id` points at the row in
  // anya_match_suggestions. Accept forwards through the existing trust-
  // gated /api/grants/from-opportunity path; dismiss just records the
  // dismissal (the suggestion row is retained for the learning loop).
  const handleSuggestionAccept = useCallback(
    async (notification) => {
      const suggestionId = notification?.data?.suggestion_id
      if (!suggestionId) return
      try {
        setLoading(true)
        await apiFetch(`/api/anya/match-suggestions/${encodeURIComponent(suggestionId)}/accept`, {
          method: 'POST',
        })
        // Mark the notification read and remove it from the local list so
        // the bell count stays accurate (count maps 1:1 to backend state).
        await apiFetch(`/api/notifications/${notification.id}/read`, { method: 'POST' }).catch(() => {})
        setNotifications((prev) => prev.filter((n) => n.id !== notification.id))
        setUnreadCount((prev) => Math.max(0, prev - (notification.read ? 0 : 1)))
      } catch {
        // Non-fatal — the suggestion remains pending and the user can retry.
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const handleSuggestionDismiss = useCallback(
    async (notification) => {
      const suggestionId = notification?.data?.suggestion_id
      if (!suggestionId) return
      try {
        setLoading(true)
        await apiFetch(`/api/anya/match-suggestions/${encodeURIComponent(suggestionId)}/dismiss`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'bell_dismiss' }),
        })
        await apiFetch(`/api/notifications/${notification.id}/read`, { method: 'POST' }).catch(() => {})
        setNotifications((prev) => prev.filter((n) => n.id !== notification.id))
        setUnreadCount((prev) => Math.max(0, prev - (notification.read ? 0 : 1)))
      } catch {
        // Best-effort
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  if (!isAuthenticated) return null

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <button
        type="button"
        onClick={handleToggle}
        className="relative p-2 rounded-lg hover:bg-muted transition-colors duration-200"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell className="w-5 h-5 text-muted-foreground" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-0.5 leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 mt-2 w-[min(92vw,26rem)] bg-background border border-border rounded-xl shadow-lg z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-sm text-foreground">Notifications</h3>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={loading}
                className="text-xs text-blue-600 hover:text-blue-700 disabled:opacity-50"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No notifications
              </div>
            ) : (
              notifications.map((n) => {
                const isAnyaHighMatch =
                  n.type === 'anya_high_match' && n.data && n.data.suggestion_id
                const baseClass = [
                  'w-full text-left px-4 py-3 border-b border-border last:border-0',
                  'hover:bg-muted/50 transition-colors duration-150',
                  n.read ? 'opacity-60' : 'bg-blue-50/30 dark:bg-blue-950/20',
                ].join(' ')

                if (isAnyaHighMatch) {
                  // Special-case render: not a single clickable row, because
                  // the row contains two action buttons. Mark-read fires
                  // only when the user clicks Accept or Dismiss (see
                  // handleSuggestionAccept / handleSuggestionDismiss).
                  return (
                    <div key={n.id} className={baseClass}>
                      <div className="flex items-start gap-2">
                        {!n.read && (
                          <span className="mt-1.5 w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                        )}
                        <div className={n.read ? 'pl-4 w-full' : 'w-full'}>
                          <p className="text-sm font-medium text-foreground leading-snug line-clamp-2">
                            {n.title}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-3">
                            {n.message}
                          </p>
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            {formatRelativeTime(n.createdAt)}
                          </p>
                          <div className="mt-2 flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleSuggestionAccept(n)}
                              disabled={loading}
                              className="text-xs px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              Add to Pipeline
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSuggestionDismiss(n)}
                              disabled={loading}
                              className="text-xs px-2.5 py-1 rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50"
                            >
                              Not right now
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                }

                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleNotificationOpen(n)}
                    disabled={loading}
                    className={baseClass}
                    title={resolveNotificationTarget(n) ? "Open the work item" : "Mark as read"}
                  >
                    <div className="flex items-start gap-2">
                      {!n.read && (
                        <span className="mt-1.5 w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                      )}
                      <div className={`${n.read ? 'pl-4' : ''} min-w-0`}>
                        <p className="break-words text-sm font-medium text-foreground leading-snug">
                          {n.title}
                        </p>
                        <p className="mt-0.5 break-words text-xs text-muted-foreground">
                          {n.message}
                        </p>
                        {resolveNotificationTarget(n) ? (
                          <p className="mt-1 text-xs font-medium text-blue-600">Open work item</p>
                        ) : null}
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {formatRelativeTime(n.createdAt)}
                        </p>
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
