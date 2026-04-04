import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Bell } from 'lucide-react'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

function formatRelativeTime(dateStr) {
  if (!dateStr) return ''
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now - date
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const dropdownRef = useRef(null)
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
        <div className="absolute right-0 mt-2 w-80 bg-background border border-border rounded-xl shadow-lg z-50 overflow-hidden">
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
              notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => !n.read && handleMarkRead(n.id)}
                  disabled={loading || n.read}
                  className={[
                    'w-full text-left px-4 py-3 border-b border-border last:border-0',
                    'hover:bg-muted/50 transition-colors duration-150',
                    n.read ? 'opacity-60' : 'bg-blue-50/30 dark:bg-blue-950/20',
                  ].join(' ')}
                >
                  <div className="flex items-start gap-2">
                    {!n.read && (
                      <span className="mt-1.5 w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                    )}
                    <div className={n.read ? 'pl-4' : ''}>
                      <p className="text-sm font-medium text-foreground leading-snug line-clamp-2">
                        {n.title}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                        {n.message}
                      </p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {formatRelativeTime(n.createdAt)}
                      </p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
