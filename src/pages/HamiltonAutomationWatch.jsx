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
 *  - EVERY task is in exactly one visible bucket and the buckets sum to the
 *    list. The first version counted only ten of the thirty-four real statuses
 *    and swept the rest into a counter it never rendered — on production data
 *    that hid 523 of 931 tasks, including two actively filling a portal while
 *    the header read "Hamilton is not working right now · 0 working". The
 *    bucket map now lives in `shared/hamiltonTaskLifecycle.js` and is
 *    totality-tested against the canonical status list.
 *  - A card says WHAT happened, not that something happened. "Finished" is not
 *    a result — submitted and cancelled are opposite results wearing that word
 *    — so a terminal card shows its outcome and the reason the system actually
 *    recorded. It never invents one: a row with no recorded reason says so.
 *  - Times carry a DATE unless they are from today. Without one, a sweep that
 *    cancelled 295 tasks on 2026-08-03 read as if it had happened overnight.
 *  - "Needs you" is louder than "running", sorts first, and names the actual
 *    wall plus the page to open. "Open this task in GrantFlow to clear it" is
 *    not an instruction if it neither says what is wrong nor links anywhere.
 *  - Polling backs off when nothing is live, and says when it last looked. A
 *    stale panel that looks live is the failure mode this page exists to avoid.
 *  - Closing the window does not stop the run, and the page says so.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, RefreshCw, CheckCircle2, AlertTriangle, Clock, ExternalLink, ChevronRight } from 'lucide-react'
import client from '@/api/client'
import {
  BUCKET_ORDER,
  bucketForTaskStatus,
  countTaskBuckets,
  isRecognisedTaskStatus,
  terminalOutcome,
} from '../../shared/hamiltonTaskLifecycle.js'

const TONE = {
  needs_you: { dot: 'bg-rose-400', text: 'text-rose-300', label: 'Needs you' },
  working: { dot: 'bg-emerald-400 animate-pulse', text: 'text-emerald-300', label: 'Working' },
  waiting: { dot: 'bg-slate-500', text: 'text-slate-300', label: 'Waiting' },
  finished: { dot: 'bg-amber-300', text: 'text-amber-200', label: 'Finished' },
}

/**
 * What a terminal card leads with. The plain English differs per outcome
 * because the outcomes differ — the previous single sentence, "Hamilton is
 * finished with this one", was shown identically for a real submission and for
 * a task a boot sweep killed.
 */
const OUTCOME_COPY = {
  submitted: { label: 'Submitted', tone: 'text-emerald-300' },
  completed: { label: 'Completed', tone: 'text-amber-200' },
  drafted: { label: 'Draft prepared — not submitted', tone: 'text-amber-200' },
  failed: { label: 'Failed', tone: 'text-rose-300' },
  cancelled: { label: 'Cancelled before it was applied for', tone: 'text-slate-300' },
}

/** Who a submission is attributed to. "We do not know" is an honest answer. */
const SUBMITTED_BY_COPY = {
  hamilton: 'Submitted by Hamilton, with a captured portal confirmation.',
  owner: 'Marked submitted by a person in the Application Tracker — GrantFlow did not transmit it.',
  unrecorded: 'Nothing recorded who submitted this, so GrantFlow cannot say whether Hamilton or a person did.',
}

function humanStatus(status) {
  return String(status || 'unknown').replace(/_/g, ' ')
}

function sameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  )
}

/**
 * A timestamp a reader can place. Today's rows stay short; anything older
 * carries its date, because a list mixing several days with time-only stamps
 * is unreadable and actively misleading.
 */
function whenOf(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  if (sameCalendarDay(d, new Date())) return d.toLocaleTimeString()
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function timeValue(value) {
  const t = new Date(value || 0).getTime()
  return Number.isNaN(t) ? 0 : t
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function labelOfMissing(entry) {
  if (typeof entry === 'string') return entry
  return entry?.label || entry?.key || entry?.name || entry?.kind || null
}

/**
 * The concrete thing standing in the way, in the owner's words rather than the
 * state machine's. Everything here is already on the task row — the previous
 * card simply showed none of it.
 */
function blockerSummary(task) {
  const status = String(task?.status || '').toLowerCase()
  const named = {
    waiting_for_login: 'Hamilton needs you to sign in to this portal.',
    blocked_login_required: 'Hamilton needs you to sign in to this portal.',
    waiting_for_2fa: 'The portal asked for a two-factor code.',
    blocked_2fa: 'The portal asked for a two-factor code.',
    waiting_for_captcha: 'The portal put up a captcha Hamilton cannot answer.',
    blocked_captcha: 'The portal put up a captcha Hamilton cannot answer.',
    waiting_for_email_verification: 'A verification link was emailed and still needs clicking.',
    waiting_for_missing_info: 'Hamilton needs information the profile does not have yet.',
    blocked_missing_info: 'Hamilton needs information the profile does not have yet.',
    blocked_terms_or_policy: "This portal's terms do not permit automated submission.",
    waiting_for_review: 'This one is waiting for you to review it before it goes any further.',
    submission_verification_required: 'A submission may have gone through and could not be confirmed. Check the portal before retrying.',
    ready_to_submit: 'Everything is ready — it needs your go-ahead to submit.',
    ready_to_print_mail: 'The packet is ready to print and mail.',
    ready_to_email: 'The packet is ready to email.',
    ready_to_fax: 'The packet is ready to fax.',
  }[status]

  if (named) return named
  // `last_agent_message` is Hamilton's own explanation and it is persisted on
  // every row. Preferring it over a generic sentence is most of this fix.
  if (task?.outcome_reason) return task.outcome_reason
  if (task?.last_agent_message) return task.last_agent_message
  if (!isRecognisedTaskStatus(status)) {
    return `This task is in an unrecognised state (${humanStatus(status)}). That is a GrantFlow defect, not something you did.`
  }
  return 'Hamilton stopped here and a person is the next step.'
}

/**
 * The terminal story. Deliberately conservative: where the system recorded no
 * reason, the card SAYS the reason was not recorded rather than inventing a
 * plausible one.
 */
function outcomeSummary(task) {
  const outcome = terminalOutcome(task?.status)
  const reason = task?.outcome_reason || task?.last_agent_message || null
  if (outcome === 'submitted') {
    return SUBMITTED_BY_COPY[task?.submitted_by] || SUBMITTED_BY_COPY.unrecorded
  }
  if (reason) return reason
  if (outcome === 'cancelled') {
    return 'No reason was recorded for this cancellation, so GrantFlow cannot tell you why it stopped.'
  }
  if (outcome === 'failed') {
    return 'No error detail was recorded for this failure.'
  }
  return 'Hamilton finished with this one and recorded no further detail.'
}

// LiveView — the owner's "watch the portal" panel (2026-08-21). While a card is
// WORKING, it polls this task's latest run for a screencast FRAME (the portal
// picture, present only while a page is rendering) and a STEP (the play-by-play
// text, available even between frames), at a few frames/sec. Honest by design:
// no frame yet says so rather than showing a frozen picture; a request failure
// says it is retrying rather than looking live.
function LiveView({ taskId, active }) {
  const [live, setLive] = useState(null)
  const [runStatus, setRunStatus] = useState(null)
  const [error, setError] = useState(false)
  const busy = useRef(false)

  useEffect(() => {
    if (!active) { setLive(null); return undefined }
    let cancelled = false
    const tick = async () => {
      if (busy.current) return
      busy.current = true
      try {
        const res = await client.get(
          `/api/hamilton/automation/tasks/${encodeURIComponent(taskId)}/live-frame`,
        )
        if (!cancelled) {
          setLive(res?.data?.live || null)
          setRunStatus(res?.data?.run_status || null)
          setError(false)
        }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        busy.current = false
      }
    }
    tick()
    const id = setInterval(tick, 800)
    return () => { cancelled = true; clearInterval(id) }
  }, [taskId, active])

  if (!active) return null

  const frame = live?.frame
  const step = live?.step
  const detail = live?.step_detail
  const detailText = detail && typeof detail === 'object'
    ? Object.entries(detail)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
      .join(' · ')
    : ''

  return (
    <div className="border-t border-slate-800/70 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Live — what Hamilton is doing now
      </p>
      {frame ? (
        <img
          src={`data:image/jpeg;base64,${frame}`}
          alt="Live view of Hamilton's portal browser"
          className="w-full rounded-lg border border-slate-800"
        />
      ) : (
        <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/60 px-3 py-4 text-center text-xs text-slate-400">
          {step
            ? 'The portal picture appears while a page is on screen — Hamilton is between screens right now.'
            : 'Waiting for the next step to render…'}
        </div>
      )}
      {step && (
        <p className="mt-2 text-xs text-slate-300">
          <span className="font-medium text-slate-100">{step}</span>
          {detailText ? ` · ${detailText}` : ''}
        </p>
      )}
      {error && (
        <p className="mt-2 text-[11px] text-slate-500">Couldn&rsquo;t reach the live view just now — retrying.</p>
      )}
      {!step && !frame && runStatus && (
        <p className="mt-1 text-[11px] text-slate-500">Run status: {String(runStatus).replace(/_/g, ' ')}.</p>
      )}
    </div>
  )
}

function TaskCard({ task }) {
  const bucket = bucketForTaskStatus(task.status)
  const tone = TONE[bucket]
  const outcome = terminalOutcome(task.status)
  const outcomeCopy = outcome ? OUTCOME_COPY[outcome] : null
  const missing = [
    ...asList(task.missing_fields).map(labelOfMissing),
    ...asList(task.missing_documents).map(labelOfMissing),
    ...asList(task.required_user_actions).map(labelOfMissing),
  ].filter(Boolean)

  return (
    <li className="rounded-xl border border-slate-800 bg-slate-950/40 transition-colors hover:border-slate-700">
      <Link
        to={`/HamiltonTask/${encodeURIComponent(task.id)}`}
        className="block rounded-xl p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
          <span className="text-sm font-medium">{task.display_title || 'Unnamed source'}</span>
          {task.title_source === 'host' && (
            <span className="rounded-full border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
              no stored name — showing the site
            </span>
          )}
          <span className={`ml-auto text-xs font-medium ${tone.text}`}>{tone.label}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-600" aria-hidden="true" />
        </div>

        <p className="mt-1 text-xs text-slate-400">
          {humanStatus(task.status)}
          {task.automation_type && task.automation_type !== 'unknown'
            ? ` · ${humanStatus(task.automation_type)}`
            : ''}
          {task.funder_name && task.funder_name !== task.display_title ? ` · ${task.funder_name}` : ''}
          {task.updated_at ? ` · updated ${whenOf(task.updated_at)}` : ''}
        </p>

        {bucket === 'needs_you' && (
          <div className="mt-2 rounded-lg bg-rose-500/10 px-2.5 py-2 text-xs text-rose-200">
            <p className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{blockerSummary(task)}</span>
            </p>
            {missing.length > 0 && (
              <p className="mt-1.5 pl-5 text-rose-300/80">
                Still needed: {missing.slice(0, 6).join(', ')}
                {missing.length > 6 ? ` and ${missing.length - 6} more` : ''}
              </p>
            )}
            {task.next_retry_at && (
              <p className="mt-1.5 pl-5 text-rose-300/70">
                Hamilton will try again on its own at {whenOf(task.next_retry_at)}.
              </p>
            )}
          </div>
        )}

        {outcomeCopy && (
          <div className="mt-2 text-xs">
            <p className={`flex items-center gap-1.5 font-medium ${outcomeCopy.tone}`}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {outcomeCopy.label}
              {task.submitted_at && outcome === 'submitted' ? ` · ${whenOf(task.submitted_at)}` : ''}
            </p>
            <p className="mt-1 text-slate-400">{outcomeSummary(task)}</p>
          </div>
        )}
      </Link>

      {task.apply_url && (
        <p className="border-t border-slate-800/70 px-4 py-2 text-xs">
          <a
            href={task.apply_url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-slate-300 hover:text-emerald-300"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            Open the funder&rsquo;s page
          </a>
        </p>
      )}

      <LiveView taskId={task.id} active={bucket === 'working'} />
    </li>
  )
}

export default function HamiltonAutomationWatch() {
  const [params] = useSearchParams()
  const profileId = params.get('profile') || ''

  const [tasks, setTasks] = useState([])
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
      setTasks(Array.isArray(res?.tasks) ? res.tasks : [])
      setLoadError(null)
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

  const counts = useMemo(() => countTaskBuckets(tasks), [tasks])
  const anyLive = counts.working > 0

  useEffect(() => {
    if (!profileId) return undefined
    load()
    // Fast while work is moving, slow when it is not. Polling a finished run
    // every three seconds is just noise on someone's battery.
    const interval = anyLive ? 3000 : 20000
    const t = setInterval(load, interval)
    return () => clearInterval(t)
  }, [profileId, load, anyLive])

  const sorted = useMemo(() => {
    // Bucket first, then genuinely most-recent-first INSIDE the bucket. The
    // previous comparator had no secondary key and leaned on sort stability
    // plus whatever order the backend happened to return.
    return [...tasks].sort((a, b) => {
      const bucketDelta = BUCKET_ORDER[bucketForTaskStatus(a.status)] - BUCKET_ORDER[bucketForTaskStatus(b.status)]
      if (bucketDelta !== 0) return bucketDelta
      return timeValue(b.updated_at) - timeValue(a.updated_at)
    })
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
          <span className={`h-2.5 w-2.5 rounded-full ${anyLive ? TONE.working.dot : TONE.waiting.dot}`} aria-hidden="true" />
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
        {/*
          Every task is counted exactly once and the four numbers sum to the
          list below. If they ever do not, the totals line says so rather than
          quietly dropping the difference.
        */}
        <p className="mt-1.5 text-xs text-slate-400">
          {counts.working} working · {counts.needs_you} need you · {counts.waiting} waiting ·{' '}
          {counts.finished} finished · {counts.total} in total
          {loadedAt ? ` · checked ${loadedAt.toLocaleTimeString()}` : ''}
        </p>
        {counts.unrecognised > 0 && (
          <p className="mt-1 text-xs text-amber-300">
            {counts.unrecognised} task{counts.unrecognised === 1 ? ' is' : 's are'} in a state this
            page does not recognise. They are counted under &ldquo;need you&rdquo; so they are not
            lost, but this is a GrantFlow defect worth reporting.
          </p>
        )}
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
          {sorted.map((task) => <TaskCard key={task.id} task={task} />)}
        </ul>

        {sorted.length > 0 && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-slate-500">
            <Clock className="h-3 w-3" aria-hidden="true" />
            Open any card for its full step-by-step timeline.
          </p>
        )}
      </main>
    </div>
  )
}
