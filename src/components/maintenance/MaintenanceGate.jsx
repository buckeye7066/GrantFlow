import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Wrench } from 'lucide-react'
import { getMaintenanceStatus } from '@/api/maintenance'
import client from '@/api/client'

/**
 * Watches the server maintenance window and protects users from a glitching app
 * during code changes / Sam's nightly sweep:
 *   - WARNING: a sticky banner with a live countdown + estimated downtime, so
 *     users get ~5 minutes to finish up.
 *   - DOWN: a full-screen overlay + the session is cleared (logged out) so no
 *     one operates a half-deployed app. Clears automatically when the window
 *     ends (reopens the app on the next poll).
 *
 * Mounted once in Layout. Admins/owners are exempt server-side (their API keeps
 * working), but they still see the banner so they know the window is live.
 */
const POLL_MS = 20_000

function fmtCountdown(seconds) {
  if (seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtTime(iso) {
  if (!iso) return null
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } catch { return null }
}

export default function MaintenanceGate() {
  const [status, setStatus] = useState(null)
  const [countdown, setCountdown] = useState(0)
  const loggedOutRef = useRef(false)

  // Poll the maintenance status.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const s = await getMaintenanceStatus()
        if (cancelled) return
        setStatus(s)
        if (s?.phase === 'warning') setCountdown(Number(s.seconds_until_down) || 0)
      } catch {
        // Best-effort: a failed poll must never block the app.
      }
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Local 1s countdown ticker during the warning phase.
  useEffect(() => {
    if (status?.phase !== 'warning') return
    const id = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000)
    return () => clearInterval(id)
  }, [status?.phase])

  // On DOWN: clear the session once so the user is logged out of the app.
  useEffect(() => {
    if (status?.phase === 'down' && !loggedOutRef.current) {
      loggedOutRef.current = true
      try { client.clearToken() } catch { /* ignore */ }
    }
    if (status?.phase !== 'down') loggedOutRef.current = false
  }, [status?.phase])

  if (!status || status.phase === 'open') return null

  const backBy = fmtTime(status.estimated_end_at)

  if (status.phase === 'down') {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/95 p-6 text-center">
        <div className="max-w-md space-y-4">
          <Wrench className="mx-auto h-12 w-12 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">We'll be right back</h1>
          <p className="text-slate-300">
            {status.message || 'GrantFlow is briefly down for a maintenance update.'}
          </p>
          {backBy ? <p className="text-sm text-slate-400">Estimated back by about <strong className="text-slate-200">{backBy}</strong>.</p> : null}
          <p className="text-xs text-slate-500">You've been signed out to protect your work. Please sign in again once we're back.</p>
        </div>
      </div>
    )
  }

  // WARNING banner.
  return (
    <div className="sticky top-0 z-[9998] flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm text-amber-950 shadow">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <div className="flex-1">
        <strong>Maintenance in {fmtCountdown(countdown)}.</strong>{' '}
        {status.message || 'Please finish what you\'re doing and save your work.'}{' '}
        {backBy ? `Expected back by about ${backBy}.` : null}
      </div>
    </div>
  )
}
