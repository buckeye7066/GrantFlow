/**
 * HamiltonToastBridge
 *
 * Polls the same /api/notifications endpoint NotificationBell uses and
 * surfaces brand-new hamilton_* notifications as toasts. Every notification
 * is also still visible in the bell — toasts are immediate UI feedback;
 * persistent notifications are the source of truth (per the
 * spec "toast helper logic so Hamilton alerts do not vanish if a toast
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
import { createPageUrl } from '@/utils'
import { buildProfileSectionLink } from '@/config/missingInfoTargets'

/**
 * Turn a Hamilton notification into a click target: where in the app to go, and
 * what to flash once there. Returns { navigateTo, flash } or {} when we can't
 * resolve a profile to land on.
 */
function hostFromNotification(d) {
  const raw = d.portal_host || d.host || d.portal_url || d.login_url || ''
  if (!raw) return ''
  try {
    return new URL(String(raw).startsWith('http') ? raw : `https://${raw}`).hostname
  } catch {
    return String(raw).replace(/^https?:\/\//, '').split('/')[0]
  }
}

function resolveNotificationTarget(n) {
  const d = n?.data || {}
  const type = String(n?.type || '')
  const profileId = d.profile_id || d.profileId || n?.profile_id || null
  if (!profileId) return {}

  // A wall only a human can clear live (2FA push/SMS/hardware, CAPTCHA, identity
  // proofing) → deep-link to the profile's Portals tab and flag the exact portal
  // so it surfaces a clickable "Open side-by-side login" card. `cobrowse=<host>`
  // is read by ProfilePortalsCard to render + scroll to that card.
  if (/2fa_required|captcha_required|identity_proof/.test(type)) {
    const host = hostFromNotification(d)
    const params = { id: profileId, tab: 'pipeline' }
    if (host) params.cobrowse = host
    return { navigateTo: createPageUrl('ProfileDetail', params), flash: 'portal-cobrowse' }
  }
  // Login needed → the profile's Saved portal logins card (Pipeline tab) so the
  // user/admin can add the credential Hamilton needs to sign in.
  if (/login_required/.test(type)) {
    return { navigateTo: createPageUrl('ProfileDetail', { id: profileId, tab: 'pipeline' }), flash: 'saved-logins' }
  }
  // Missing profile info → deep-link to the exact field's section editor.
  if (/missing_info/.test(type)) {
    const key = d.field || d.missing_info_key || d.key || d.missing_field
    const link = key ? buildProfileSectionLink(profileId, key) : null
    if (link) return { navigateTo: link, flash: 'profile-section-editor' }
    return { navigateTo: createPageUrl('ProfileDetail', { id: profileId, tab: 'profile' }) }
  }
  // A document is needed → the Documents tab.
  if (/document_required/.test(type)) {
    return { navigateTo: createPageUrl('ProfileDetail', { id: profileId, tab: 'documents' }) }
  }
  // Review / blocked / payment / attestation / ready / submitted → the pipeline
  // for this profile, flashing the cards that need a person.
  return { navigateTo: createPageUrl('Pipeline', { profile_id: profileId }), flash: 'human-review' }
}

const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes — faster than the bell so toasts are timely
const STORAGE_KEY = 'hamilton_toasted_notifications_v1'

const HAMILTON_TYPES = new Set([
  // Per-grant Hamilton flow (legacy).
  'hamilton_missing_info',
  'hamilton_login_required',
  'hamilton_document_required',
  'hamilton_review_required',
  'hamilton_application_ready',
  'hamilton_application_submitted',
  'hamilton_application_blocked',
  'hamilton_application_failed',
  // Hard-Stop Resolver dual alerts (user side).
  'hamilton_hard_stop',
  'hamilton_payment_required',
  'hamilton_attestation_required',
  'hamilton_task_completed',
  // Hard-Stop Resolver dual alerts (admin / single-operator side).
  'hamilton_admin_hard_stop',
  'hamilton_admin_missing_info',
  'hamilton_admin_login_required',
  'hamilton_admin_document_required',
  'hamilton_admin_payment_required',
  'hamilton_admin_attestation_required',
  'hamilton_admin_portal_blocked',
  'hamilton_admin_task_failed',
  'hamilton_admin_task_completed',
  // Autopilot lifecycle alerts.
  'hamilton_task_started',
  'hamilton_task_blocked',
  'hamilton_generated_document_saved',
  'hamilton_submitted',
  'hamilton_failed',
  'hamilton_2fa_required',
  'hamilton_captcha_required',
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
    case 'hamilton_application_submitted':
    case 'hamilton_submitted':
    case 'hamilton_task_completed':
    case 'hamilton_admin_task_completed':
      return 'success'
    case 'hamilton_application_failed':
    case 'hamilton_failed':
    case 'hamilton_admin_task_failed':
    case 'hamilton_admin_hard_stop':
    case 'hamilton_admin_portal_blocked':
      return 'error'
    case 'hamilton_hard_stop':
    case 'hamilton_task_blocked':
    case 'hamilton_application_blocked':
    case 'hamilton_login_required':
    case 'hamilton_document_required':
    case 'hamilton_missing_info':
    case 'hamilton_payment_required':
    case 'hamilton_attestation_required':
    case 'hamilton_2fa_required':
    case 'hamilton_captcha_required':
    case 'hamilton_admin_missing_info':
    case 'hamilton_admin_login_required':
    case 'hamilton_admin_document_required':
    case 'hamilton_admin_payment_required':
    case 'hamilton_admin_attestation_required':
      return 'warning'
    default: return 'info'
  }
}

export default function HamiltonToastBridge() {
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
          if (!n || !HAMILTON_TYPES.has(n.type)) continue
          if (n.read) continue
          if (seenRef.current.has(n.id)) continue
          const fire = pickToaster(n, toast)
          const target = resolveNotificationTarget(n)
          fire(n.title || 'Hamilton update', n.message || '', target)
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
