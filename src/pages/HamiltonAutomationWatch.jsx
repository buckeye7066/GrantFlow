/**
 * HamiltonAutomationWatch — the window that shows the work.
 *
 * OWNER ORDER 2026-08-21: "Let the work Hamilton is doing, once automation
 * begins, pop open in its own window and the user can watch if they chose to."
 *
 * Pressing "Begin automation" used to produce a toast reading "Watch the
 * Automation tab for progress" — the run was real, but seeing it was homework,
 * on a surface the user had to go find. This page is that surface, opened for
 * them, in its own window, and it shows the STEPS rather than a spinner.
 *
 * HONESTY RULES THIS PAGE KEEPS:
 *  - It never claims work is happening. Every line comes from a task row or a
 *    task event the orchestrator actually wrote. An empty run says it is empty.
 *  - "Needs you" is louder than "running". A blocked task is the thing the user
 *    can act on, so it sorts first and keeps its own colour.
 *  - Polling backs off when nothing is live, and says when it last looked. A
 *    stale panel that looks live is the failure mode this page exists to avoid.
 *  - Closing the window does not stop the run, and the page says so.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Loader2, RefreshCw, CheckCircle2, AlertTriangle, Clock } from 'lucide-react'
import client from '@/api/client'

/** Statuses that mean Hamilton is actively working the row right now. */
const LIVE_STATUSES = new Set(['queued', 'ready', 'in_progress', 'running'])
/** Statuses that mean the run stopped and a human is the next actor. */
const NEEDS_YOU_PREFIXES = ['blocked']
// Keep this explicit rather than treating every `waiting_for_*` state as a
// handoff: `waiting_for_window` is scheduled automation and must not accuse the
// user of blocking Hamilton. These are the actionable states emitted by
// applicationTaskStore / hamiltonAuthBackupPlan. In particular, authentication
// deferrals used to render as the neutral "Waiting" state, hiding the exact
// login/2FA/CAPTCHA/email-verification work this window exists to surface.
const NEEDS_YOU_STATUSES = new Set([
  'waiting_for_user',
  'waiting_for_admin',
  'waiting_for_login',
  'waiting_for_2fa',
  'waiting_for_captcha',
  'waiting_for_email_verification',
  'waiting_for_missing_info',
  'waiting_for_review',
  'needs_user',
  'needs_info',
  'needs_authorization',
  'submission_verification_required',
])
/** Statuses that are finished, for better or worse. */
const DONE_STATUSES = new Set(['submitted', 'draft_completed', 'awarded', 'declined', 'cancelled', 'failed'])

function classify(status) {
  const s = String(status || '').toLowerCase()
  if (NEEDS_YOU_STATUSES.has(s) || NEEDS_YOU_PREFIXES.some((p) => s.startsWith(p))) return 'needs'
  if (LIVE_STATUSES.has(s)) return 'live'
  if (DONE_STATUSES.has(s)) return 'done'
  return 'idle'
}

const TONE = {
  needs: { dot: 'bg-rose-400', text: 'text-rose-300', label: 'Needs you' },
  live: { dot: 'bg-emerald-400 animate-pulse', text: 'text-emerald-300', label: 'Working' },
  done: { dot: 'bg-amber-300', text: 'text-amber-200', label: 'Finished' },
  idle: { dot: 'bg-slate-500', text: 'text-slate-300', label: 'Waiting' },
}
const ORDER = { needs: 0, live: 1, idle: 2, done: 3 }

function humanStatus(status) {
  return String(status || 'unknown').replace(/_/g, ' ')
}

function timeOf(value) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString()
}

export default function HamiltonAutomationWatch() {
  const [params] = useSearchParams()
  const profileId = params.get('profile') || ''

  const [tasks, setTasks] = useState([])
  const [events, setEvents] = useState({})
  const [loadedAt, setLoadedAt] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [firstLoadDone, setFirstLoadDone] = useState(false)

  // Only the newest poll may write state: the tick can fire while a previous
  // fetch is still in flight, and a slow older response must never overwrite
  // fresher data with a stale list (the HamiltonAutomationQueue lesson).
  const runIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!profileId) return
    const runId = ++runIdRef.current
    try {
      const qs = new URLSearchParams({ profile_id: profileId })
      const res = await client.get(`/api/hamilton/automation/tasks?${qs.toString()}`)
      if (runId !== runIdRef.current) return
      const rows = Array.isArray(res?.tasks) ? res.tasks : []
      setTasks(rows)
      setLoadError(null)

      // Pull the step-by-step ONLY for the rows that are actually moving or
      // stuck. Fetching events for every finished task would turn a courtesy
      // window into a request storm.
      const watch = rows.filter((t) => classify(t.status) !== 'done').slice(0, 6)
      const detail = await Promise.all(watch.map(async (t) => {
        try {
          const d = await client.get(`/api/hamilton/automation/tasks/${encodeURIComponent(t.id)}`)
          return [t.id, Array.isArray(d?.events) ? d.events.slice(-8).reverse() : []]
        } catch {
          return [t.id, null]
        }
      }))
      if (runId !== runIdRef.current) return
      setEvents((prev) => {
        const next = { ...prev }
        // A failed detail fetch keeps the PREVIOUS steps rather than blanking
        // the panel — a momentary network blip must not read as "no work".
        for (const [id, list] of detail) if (list) next[id] = list
        return next
      })
    } catch (err) {
      if (runId !== runIdRef.current) return
      setLoadError(err?.message || 'Could not reach GrantFlow.')
    } finally {
      if (runId === runIdRef.current) {
        setLoadedAt(new Date())
        setFirstLoadDone(true)
      }
    }
  }, [profileId])

  const anyLive = useMemo(
    () => tasks.some((t) => classify(t.status) === 'live'),
    [tasks],
  )

  useEffect(() => {
    if (!profileId) return undefined
    load()
    // Fast while work is moving, slow when it is not. Polling a finished run
    // every three seconds is just noise on someone's battery.
    const interval = anyLive ? 3000 : 20000
    const t = setInterval(load, interval)
    return () => clearInterval(t)
  }, [profileId, load, anyLive])

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => ORDER[classify(a.status)] - ORDER[classify(b.status)]),
    [tasks],
  )
  const counts = useMemo(() => {
    const c = { needs: 0, live: 0, done: 0, idle: 0 }
    for (const t of tasks) c[classify(t.status)] += 1
    return c
  }, [tasks])

  if (!profileId) {
    return (
      <div className="min-h-screen bg-slate-900 p-8 text-slate-200">
        <h1 className="text-lg font-semibold">Nothing to watch</h1>
        <p className="mt-2 text-sm text-slate-400">
          This window opened without a profile, so there is no run to show. Start automation
          again from the profile and it will open with the work attached.
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${anyLive ? TONE.live.dot : TONE.idle.dot}`} aria-hidden="true" />
          <h1 className="text-base font-semibold">
            {anyLive ? 'Hamilton is working' : 'Hamilton is not working right now'}
          </h1>
          <button
            type="button"
            onClick={load}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
          </button>
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          {counts.live} working · {counts.needs} need you · {counts.done} finished
          {loadedAt ? ` · checked ${loadedAt.toLocaleTimeString()}` : ''}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          You can close this window at any time — the run keeps going without it.
        </p>
        {loadError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-rose-300">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Showing the last view I could load — {loadError}
          </p>
        )}
      </header>

      <main className="px-6 py-5">
        {!firstLoadDone && (
          <p className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Looking for the run&hellip;
          </p>
        )}

        {firstLoadDone && sorted.length === 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-5">
            <p className="text-sm font-medium">No automation tasks on this profile yet.</p>
            <p className="mt-1.5 text-xs text-slate-400">
              Hamilton creates a task per funding source when a run starts. If you pressed
              &ldquo;Begin automation&rdquo; a moment ago, the first task usually appears within a few
              seconds. If nothing appears, the profile pipeline is probably empty.
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {sorted.map((t) => {
            const kind = classify(t.status)
            const tone = TONE[kind]
            const steps = events[t.id] || []
            return (
              <li key={t.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
                  <span className="text-sm font-medium">{t.title || t.opportunity_title || 'Untitled funding source'}</span>
                  <span className={`ml-auto text-xs font-medium ${tone.text}`}>{tone.label}</span>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {humanStatus(t.status)}
                  {t.automation_type ? ` · ${humanStatus(t.automation_type)}` : ''}
                  {t.updated_at ? ` · updated ${timeOf(t.updated_at)}` : ''}
                </p>

                {kind === 'needs' && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-rose-500/10 px-2.5 py-2 text-xs text-rose-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Hamilton stopped here and needs you. Open this task in GrantFlow to clear it.
                  </p>
                )}

                {steps.length > 0 && (
                  <ol className="mt-3 space-y-1.5 border-l border-slate-800 pl-3">
                    {steps.map((e) => (
                      <li key={e.id || `${e.created_at}-${e.event_type}`} className="text-xs">
                        <span className="text-slate-200">
                          {humanStatus(e.step || e.event_type)}
                          {e.status ? ` — ${humanStatus(e.status)}` : ''}
                        </span>
                        {e.message && <span className="block text-slate-400">{e.message}</span>}
                        <span className="block text-[10px] text-slate-500">
                          <Clock className="mr-1 inline h-2.5 w-2.5" aria-hidden="true" />
                          {timeOf(e.created_at)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}

                {kind === 'done' && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-200">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Hamilton is finished with this one.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      </main>
    </div>
  )
}
