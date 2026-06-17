import React from 'react'
import { Clock, User, Workflow, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

function fmt(ts) {
  if (!ts) return '—'
  return String(ts).slice(0, 19).replace('T', ' ')
}

function elapsed(startedAt, completedAt) {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const ms = Math.max(0, end - start)
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function statusBadge(status) {
  const variant = status === 'completed' ? 'default'
    : status === 'failed' || status === 'stop_failed' ? 'destructive'
    : status === 'running' ? 'default'
    : 'secondary'
  return <Badge variant={variant}>{status}</Badge>
}

function stepBadge(status) {
  const map = {
    completed: 'border-emerald-300 text-emerald-700 dark:text-emerald-300',
    running: 'border-blue-300 text-blue-700 dark:text-blue-300',
    failed: 'border-rose-300 text-rose-700 dark:text-rose-300',
    blocked: 'border-amber-300 text-amber-700 dark:text-amber-300',
    skipped: 'border-slate-200 text-slate-500',
    stopped: 'border-slate-300 text-slate-700 dark:text-slate-300',
    queued: 'border-slate-200 text-slate-500',
  }
  return <Badge variant="outline" className={map[status] || ''}>{status}</Badge>
}

/**
 * Run-detail panel: started by, run type, runtime, selected agents, and
 * a step-by-step timeline of the current run. Used inside
 * AgentControlCenter when an active_run exists.
 */
export default function AgentControlRunDetails({ run, highlights }) {
  if (!run) return null
  const steps = Array.isArray(run.current_steps) ? run.current_steps : []

  return (
    <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="text-sm font-semibold flex items-center gap-2 text-slate-900 dark:text-slate-100">
            <Workflow className="h-4 w-4 text-blue-600" /> Run {String(run.id).slice(0, 8)}
            <span className="ml-2">{statusBadge(run.status)}</span>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {run.run_type === 'full_cycle' ? 'Full agent cycle' : run.run_type}
            {Array.isArray(run.requested_agents) && run.requested_agents.length > 0
              ? ` · ${run.requested_agents.join(', ')}`
              : ''}
          </div>
        </div>
        <div className="text-xs text-slate-600 dark:text-slate-300 grid grid-cols-2 gap-x-3 gap-y-0.5">
          <div className="flex items-center gap-1"><User className="h-3 w-3" /> {run.started_by_email || run.admin_email || '—'}</div>
          <div className="flex items-center gap-1"><Clock className="h-3 w-3" /> Started {fmt(run.started_at || run.created_at)}</div>
          <div>Runtime: <span className="font-mono">{elapsed(run.started_at, run.completed_at)}</span></div>
          <div>Steps: <span className="font-mono">{steps.length}</span></div>
        </div>
      </div>

      {steps.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs font-semibold text-slate-500 mb-1">Timeline</div>
          <ol className="space-y-1">
            {steps.map((s, idx) => (
              <li key={s.id} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-slate-400 w-5">{idx + 1}</span>
                <ChevronRight className="h-3 w-3 text-slate-400" />
                <span className="font-medium text-slate-800 dark:text-slate-100">{s.agent_name}</span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-500">{s.step_name}</span>
                <span className="ml-auto">{stepBadge(s.status)}</span>
                <span className="font-mono text-xs text-slate-400 w-16 text-right">
                  {elapsed(s.started_at, s.completed_at)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {highlights ? (
        <div className="mt-3 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
          {highlights.last_full_cycle ? (
            <div>Last full cycle: <span className="font-mono">{fmt(highlights.last_full_cycle.completed_at || highlights.last_full_cycle.started_at)}</span> ({highlights.last_full_cycle.status})</div>
          ) : null}
          {highlights.last_failure ? (
            <div className="text-rose-700 dark:text-rose-300">Last failure: {fmt(highlights.last_failure.completed_at)} {highlights.last_failure.error_message ? `· ${highlights.last_failure.error_message}` : ''}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
