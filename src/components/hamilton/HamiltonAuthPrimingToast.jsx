/**
 * HamiltonAuthPrimingToast
 *
 * Shows ONE priming toast per browser session, shortly after the user logs in,
 * so they know to watch for Hamilton authentication requests. This is the
 * "automation is king" companion to the credential vault: when Hamilton hits a
 * portal sign-in / 2FA / CAPTCHA she can't clear unattended, she keeps retrying
 * on a backoff schedule — but she resumes fastest if the user logs in once when
 * prompted. This toast primes them to expect that.
 *
 * Two flavours:
 *   - If Hamilton is actively waiting on the user right now (pending auth
 *     notifications or waiting-for-login tasks), a WARNING toast with a count
 *     and a deep link to act.
 *   - Otherwise a gentle INFO heads-up that verification requests may appear
 *     here, so they keep an eye on GrantFlow.
 *
 * The per-event toasts themselves are handled by HamiltonToastBridge; this is
 * purely the login-time priming the user asked for.
 */

import { useEffect, useRef } from 'react'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { useToast } from '@/components/ui/use-toast'
import { showInfoToast, showWarningToast } from '@/components/shared/toastHelpers'
import { createPageUrl } from '@/utils'

const SESSION_FLAG = 'hamilton_auth_primed_v1'

export default function HamiltonAuthPrimingToast() {
  const { toast } = useToast()
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const firedRef = useRef(false)

  useEffect(() => {
    if (!isAuthenticated || firedRef.current) return undefined
    // Once per browser session.
    try {
      if (window.sessionStorage.getItem(SESSION_FLAG)) { firedRef.current = true; return undefined }
    } catch { /* sessionStorage unavailable — still prime once via firedRef */ }

    let cancelled = false
    // Small delay so it doesn't collide with the login transition / other toasts.
    const handle = setTimeout(async () => {
      if (cancelled) return
      firedRef.current = true
      try { window.sessionStorage.setItem(SESSION_FLAG, '1') } catch { /* ignore */ }
      try {
        const s = await apiFetch('/api/hamilton/automation/auth-watch')
        if (cancelled) return
        const pending = (Number(s?.pending_notifications) || 0) + (Number(s?.waiting_tasks) || 0)
        const firstProfile = s?.items?.[0]?.profile_id || null
        const target = firstProfile
          ? { navigateTo: createPageUrl('Pipeline', { profile_id: firstProfile }), flash: 'human-review' }
          : {}
        if (s?.has_any && pending > 0) {
          showWarningToast(
            toast,
            `Hamilton needs you to sign in to ${pending} portal${pending === 1 ? '' : 's'}`,
            'Open the verification request to log in once — Hamilton resumes automatically and keeps working the rest.',
            target,
          )
        } else {
          showInfoToast(
            toast,
            'Hamilton is applying on your behalf',
            'If a portal asks for a sign-in or verification code, you’ll get a request here. Keep an eye on GrantFlow so Hamilton can finish without delay.',
          )
        }
      } catch {
        // best-effort priming — never block the app on it
      }
    }, 3500)

    return () => { cancelled = true; clearTimeout(handle) }
  }, [isAuthenticated, toast])

  return null
}
