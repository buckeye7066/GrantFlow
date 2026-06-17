import React from 'react'
import { Play, Square, AlertCircle, CheckCircle, Bot, Search, Workflow, Mail, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const ICONS = {
  sam: ShieldCheck,
  robert: Search,
  yana: Bot,
  john: Mail,
  hamilton: Workflow,
}

const LABELS = {
  sam: 'Sam',
  robert: 'Robert',
  yana: 'Yana',
  john: 'John',
  hamilton: 'Hamilton',
}

const TAGLINES = {
  sam: 'Production readiness / audit',
  robert: 'Funding discovery',
  yana: 'Client discovery (lead intelligence)',
  john: 'Outreach drafts',
  hamilton: 'Application autopilot / completion',
}

function healthBadge(health) {
  switch (health) {
    case 'healthy':
      return <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:text-emerald-300">healthy</Badge>
    case 'warning':
      return <Badge variant="outline" className="border-amber-300 text-amber-700 dark:text-amber-300">warning</Badge>
    case 'error':
      return <Badge variant="destructive">error</Badge>
    case 'idle':
      return <Badge variant="outline">idle</Badge>
    default:
      return <Badge variant="outline">not installed</Badge>
  }
}

/**
 * Per-agent card shown inside the Agent Control Center grid. Surfaces
 * status / queue depth / last run + start/stop buttons. The buttons are
 * intentionally simple — the orchestrator handles single-flight locks
 * and run-type semantics on the backend.
 */
export default function AgentControlAgentCard({ name, status, activeRun, busy, onStart, onStop }) {
  const Icon = ICONS[name] || Bot
  const stepInActiveRun = (activeRun?.current_steps || []).find((s) => s.agent_name === name)
  const inActiveRun = Boolean(stepInActiveRun)
  const stepStatus = stepInActiveRun?.status || null

  return (
    <div className="rounded border border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-slate-900">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 text-slate-600 dark:text-slate-300 shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold text-sm text-slate-900 dark:text-slate-100">{LABELS[name]}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{TAGLINES[name]}</div>
          </div>
        </div>
        {healthBadge(status?.health)}
      </div>

      <div className="mt-2 text-xs text-slate-600 dark:text-slate-300 space-y-0.5">
        <div className="flex justify-between">
          <span>Queue:</span>
          <span className="font-mono">{Number(status?.queue_depth || 0)}</span>
        </div>
        {typeof status?.open_blockers === 'number' ? (
          <div className="flex justify-between">
            <span>Blockers:</span>
            <span className="font-mono">{status.open_blockers}</span>
          </div>
        ) : null}
        <div className="flex justify-between">
          <span>Last run:</span>
          <span className="font-mono truncate ml-1">
            {status?.last_run_at ? String(status.last_run_at).slice(0, 19) : '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Last status:</span>
          <span className="font-mono">{status?.last_status || '—'}</span>
        </div>
      </div>

      {inActiveRun ? (
        <div className="mt-2 rounded bg-blue-50 dark:bg-blue-900/20 px-2 py-1 text-xs text-blue-900 dark:text-blue-200 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          Step in active run: <span className="font-semibold">{stepStatus}</span>
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-1.5">
        <Button size="sm" variant="outline" className="flex-1" onClick={onStart} disabled={busy || inActiveRun}>
          <Play className="h-3.5 w-3.5 mr-1" /> Start
        </Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={onStop} disabled={busy || !inActiveRun}>
          <Square className="h-3.5 w-3.5 mr-1" /> Stop
        </Button>
      </div>
      <div className="mt-1 text-[10px] text-slate-400 flex items-center gap-1">
        <CheckCircle className="h-3 w-3" /> Yana = client discovery, separate from Hamilton.
      </div>
    </div>
  )
}
