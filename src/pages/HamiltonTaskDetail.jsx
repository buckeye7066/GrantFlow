/**
 * HamiltonTaskDetail — what actually happened to ONE task.
 *
 * OWNER ORDER 2026-08-21: "Those cards that Hamilton finished should be
 * clickable with the details as to what was done."
 *
 * Before this page existed there was no URL that opened a Hamilton task at
 * all. `HamiltonTaskDrawer` renders exactly this information but it is a modal
 * owned by two other components, so the run dashboard — which opens in its own
 * popup window — had nothing to link to. Its finished cards therefore ended in
 * a dead sentence ("Hamilton is finished with this one.") shown identically for
 * a real submission and for a task a boot sweep killed, and its blocked cards
 * said "Open this task in GrantFlow to clear it" while naming no route.
 *
 * HONESTY RULES:
 *  - The timeline is the events the orchestrator actually wrote, oldest first,
 *    each stamped with a date. Nothing is summarised into a story.
 *  - Where the system recorded no reason, this page says the reason was not
 *    recorded. It never fills the gap with a plausible one.
 *  - A submission names WHO submitted it — Hamilton, a person, or "not
 *    recorded" — because in production those are three different claims that
 *    were all rendered with the same word.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import client from '@/api/client'
import { bucketForTaskStatus, terminalOutcome } from '../../shared/hamiltonTaskLifecycle.js'

const OUTCOME_COPY = {
  submitted: { label: 'Submitted', tone: 'text-emerald-300', border: 'border-emerald-500/40' },
  completed: { label: 'Completed', tone: 'text-amber-200', border: 'border-amber-500/40' },
  drafted: { label: 'Draft prepared — not submitted', tone: 'text-amber-200', border: 'border-amber-500/40' },
  failed: { label: 'Failed', tone: 'text-rose-300', border: 'border-rose-500/40' },
  cancelled: { label: 'Cancelled before it was applied for', tone: 'text-slate-300', border: 'border-slate-600' },
}

const SUBMITTED_BY_COPY = {
  hamilton: 'Hamilton submitted this itself, behind its evidence gate — a portal confirmation was captured.',
  owner: 'A person marked this submitted in the Application Tracker. GrantFlow did not transmit anything to the funder.',
  unrecorded: 'Nothing recorded who submitted this, so GrantFlow cannot say whether Hamilton or a person did it.',
}

function humanise(value) {
  return String(value || '').replace(/_/g, ' ')
}

function stamp(value) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function entryLabel(entry) {
  if (typeof entry === 'string') return entry
  return entry?.label || entry?.key || entry?.name || entry?.kind || null
}

function Section({ title, children }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
      <div className="mt-2 text-xs text-slate-300">{children}</div>
    </section>
  )
}

export default function HamiltonTaskDetail() {
  const { taskId } = useParams()
  const [state, setState] = useState({ loading: true, error: null, task: null, events: [], missing: [] })

  const load = useCallback(async () => {
    if (!taskId) return
    setState((prev) => ({ ...prev, loading: true }))
    try {
      const res = await client.get(`/api/hamilton/automation/tasks/${encodeURIComponent(taskId)}`)
      setState({
        loading: false,
        error: null,
        task: res?.task || null,
        events: Array.isArray(res?.events) ? res.events : [],
        missing: Array.isArray(res?.missing) ? res.missing : [],
      })
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err?.message || 'Could not load this task.',
      }))
    }
  }, [taskId])

  useEffect(() => { load() }, [load])

  const { loading, error, task, events, missing } = state
  const outcome = task ? terminalOutcome(task.status) : null
  const outcomeCopy = outcome ? OUTCOME_COPY[outcome] : null
  const bucket = task ? bucketForTaskStatus(task.status) : null
  const reason = task?.outcome_reason || task?.last_agent_message || null
  const openMissing = (missing || []).filter((m) => !m?.resolved)
  const needed = [
    ...asList(task?.missing_fields).map(entryLabel),
    ...asList(task?.missing_documents).map(entryLabel),
    ...asList(task?.required_user_actions).map(entryLabel),
    ...openMissing.map(entryLabel),
  ].filter(Boolean)

  return (
    <div className="min-h-screen bg-slate-900 px-6 py-5 text-slate-100">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => window.history.back()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
          </button>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
          </button>
        </div>

        {loading && !task && (
          <p className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading this task&hellip;
          </p>
        )}

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-rose-300">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> {error}
          </p>
        )}

        {task && (
          <>
            <div>
              <h1 className="text-lg font-semibold">{task.display_title || 'Unnamed source'}</h1>
              <p className="mt-1 text-xs text-slate-400">
                {humanise(task.status)}
                {task.automation_type && task.automation_type !== 'unknown' ? ` · ${humanise(task.automation_type)}` : ''}
                {task.funder_name && task.funder_name !== task.display_title ? ` · ${task.funder_name}` : ''}
                {task.updated_at ? ` · updated ${stamp(task.updated_at)}` : ''}
              </p>
              {task.title_source === 'host' && (
                <p className="mt-1 text-xs text-slate-500">
                  No funder name is stored for this source, so GrantFlow is showing the site it points at.
                </p>
              )}
              {task.title_source === 'none' && (
                <p className="mt-1 text-xs text-amber-300">
                  This task has neither a stored funder name nor a usable application URL — there is
                  nothing left to identify it by. That is a discovery defect, not a display one.
                </p>
              )}
            </div>

            {outcomeCopy && (
              <div className={`rounded-xl border ${outcomeCopy.border} bg-slate-950/40 p-4`}>
                <p className={`flex items-center gap-1.5 text-sm font-medium ${outcomeCopy.tone}`}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  {outcomeCopy.label}
                  {task.submitted_at && outcome === 'submitted' ? ` · ${stamp(task.submitted_at)}` : ''}
                  {task.cancelled_at && outcome === 'cancelled' ? ` · ${stamp(task.cancelled_at)}` : ''}
                  {task.completed_at && (outcome === 'completed' || outcome === 'drafted') ? ` · ${stamp(task.completed_at)}` : ''}
                </p>
                {outcome === 'submitted' && (
                  <p className="mt-2 text-xs text-slate-300">
                    {SUBMITTED_BY_COPY[task.submitted_by] || SUBMITTED_BY_COPY.unrecorded}
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-300">
                  {reason || (
                    outcome === 'cancelled'
                      ? 'No reason was recorded for this cancellation. GrantFlow cannot tell you why it stopped, and will not guess.'
                      : outcome === 'failed'
                        ? 'No error detail was recorded for this failure.'
                        : 'No further detail was recorded.'
                  )}
                </p>
                {task.terminal_actor_message && task.terminal_actor_message !== reason && (
                  <p className="mt-1 text-xs text-slate-400">
                    Recorded by {humanise(task.terminal_actor_role || 'an unrecorded actor')}:{' '}
                    {task.terminal_actor_message}
                  </p>
                )}
              </div>
            )}

            {bucket === 'needs_you' && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
                <p className="flex items-start gap-1.5 text-sm font-medium text-rose-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Hamilton stopped here — {humanise(task.status)}
                </p>
                {reason && <p className="mt-2 text-xs text-rose-100/90">{reason}</p>}
                {needed.length > 0 && (
                  <div className="mt-2 text-xs text-rose-100/80">
                    <p className="font-medium">To clear it, GrantFlow still needs:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {needed.slice(0, 12).map((item, i) => <li key={`${item}-${i}`}>{item}</li>)}
                    </ul>
                  </div>
                )}
                {task.apply_url && (
                  <p className="mt-2 text-xs">
                    <a
                      href={task.apply_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 text-rose-100 underline hover:text-white"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      Open the funder&rsquo;s page to finish it yourself
                    </a>
                  </p>
                )}
                {task.next_retry_at && (
                  <p className="mt-2 text-xs text-rose-100/70">
                    Hamilton will try again on its own at {stamp(task.next_retry_at)}.
                  </p>
                )}
              </div>
            )}

            <Section title="Where this goes">
              {task.apply_url ? (
                <a
                  href={task.apply_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 break-all text-emerald-300 hover:text-emerald-200"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                  {task.apply_url}
                </a>
              ) : (
                <p className="text-slate-400">
                  No application or portal URL is recorded for this task.
                </p>
              )}
            </Section>

            {(task.output_proposal_document_id || task.output_document_id || task.output_pdf_document_id || task.output_docx_document_id) && (
              <Section title="What Hamilton produced">
                <ul className="space-y-1">
                  {[
                    ['Proposal', task.output_proposal_document_id],
                    ['Document', task.output_document_id],
                    ['PDF', task.output_pdf_document_id],
                    ['DOCX', task.output_docx_document_id],
                  ]
                    .filter(([, id]) => Boolean(id))
                    .map(([label, id]) => (
                      <li key={`${label}-${id}`}>
                        <a
                          href={`/api/documents/${encodeURIComponent(id)}/download`}
                          className="inline-flex items-center gap-1.5 text-emerald-300 hover:text-emerald-200"
                        >
                          <FileText className="h-3 w-3" aria-hidden="true" /> {label}
                        </a>
                      </li>
                    ))}
                </ul>
                <p className="mt-2 text-slate-500">
                  A drafted packet is not proof of submission. Only a captured portal confirmation is.
                </p>
              </Section>
            )}

            <Section title={`Step-by-step (${events.length} event${events.length === 1 ? '' : 's'})`}>
              {events.length === 0 ? (
                <p className="text-slate-400">No events were recorded for this task.</p>
              ) : (
                <ol className="space-y-2 border-l border-slate-800 pl-3">
                  {events.map((e) => (
                    <li key={e.id || `${e.created_at}-${e.event_type}`}>
                      <p className="text-slate-200">
                        {humanise(e.step || e.event_type)}
                        {e.status ? ` — ${humanise(e.status)}` : ''}
                        {e.actor_role ? ` · ${humanise(e.actor_role)}` : ''}
                      </p>
                      {e.message && <p className="text-slate-400">{e.message}</p>}
                      <p className="text-[10px] text-slate-500">{stamp(e.created_at)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            <p className="text-xs text-slate-500">
              <Link to="/Automation" className="underline hover:text-slate-300">
                Back to the Automation tab
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
