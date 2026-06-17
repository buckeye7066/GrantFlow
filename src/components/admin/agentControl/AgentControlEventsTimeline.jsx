import React from 'react'
import { Activity } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

function fmt(ts) {
  if (!ts) return ''
  return String(ts).slice(0, 19).replace('T', ' ')
}

function severityBadge(severity) {
  const map = {
    critical: 'bg-rose-600 text-white',
    high: 'bg-rose-500 text-white',
    medium: 'bg-amber-500 text-white',
    low: 'bg-slate-400 text-white',
    info: 'bg-blue-500 text-white',
  }
  return <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${map[severity] || map.info}`}>{severity}</span>
}

/**
 * Live event timeline for the active control run. Reads from
 * agent_control_events ordered by created_at DESC. Each row is colour-
 * coded by severity so emergencies stand out.
 */
export default function AgentControlEventsTimeline({ events = [] }) {
  if (!Array.isArray(events) || events.length === 0) {
    return (
      <div className="rounded border border-dashed border-slate-200 dark:border-slate-700 p-3 text-sm text-slate-500">
        <Activity className="h-4 w-4 inline mr-1" /> No events yet for this run.
      </div>
    )
  }

  return (
    <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
      <div className="text-xs font-semibold text-slate-500 mb-2 flex items-center gap-1">
        <Activity className="h-3.5 w-3.5" /> Live events ({events.length})
      </div>
      <ul className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
        {events.map((e) => (
          <li key={e.id} className="flex items-start gap-2 text-xs">
            <span className="font-mono text-slate-400 w-32 shrink-0">{fmt(e.created_at)}</span>
            {severityBadge(e.severity)}
            {e.agent_name ? (
              <Badge variant="outline" className="text-[10px]">{e.agent_name}</Badge>
            ) : null}
            <span className="font-mono text-slate-500">{e.event_type}</span>
            <span className="text-slate-700 dark:text-slate-200">{e.message}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
