import React, { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Activity, ChevronDown, ChevronRight } from 'lucide-react'

const STATUS_STYLES = {
  succeeded: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  failed: 'bg-red-100 text-red-900 border-red-200',
  blocked: 'bg-amber-100 text-amber-900 border-amber-200',
  warning: 'bg-amber-50 text-amber-900 border-amber-200',
  running: 'bg-blue-100 text-blue-900 border-blue-200',
  queued: 'bg-slate-100 text-slate-700 border-slate-200',
  info: 'bg-slate-50 text-slate-700 border-slate-200',
}

function fmt(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function EventRow({ e, expanded, onToggle }) {
  const hasMore = Boolean(e.description) || (e.data && Object.keys(e.data).length > 0)
  return (
    <li className="rounded border bg-white dark:border-slate-800 dark:bg-slate-900/40">
      <div
        className="flex cursor-pointer items-start gap-3 p-2"
        role="button"
        tabIndex={0}
        onClick={() => hasMore && onToggle(e.id)}
        onKeyDown={(ev) => { if (hasMore && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); onToggle(e.id) } }}
      >
        {hasMore ? (
          expanded ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Badge variant="outline" className="text-[10px] uppercase">
          {e.agent_name}
        </Badge>
        <Badge variant="outline" className={`text-[10px] uppercase ${STATUS_STYLES[e.status] || ''}`}>
          {e.status || 'info'}
        </Badge>
        <div className="min-w-0 flex-1">
          <div className={expanded ? 'font-medium' : 'truncate font-medium'}>{e.title || e.event_type}</div>
          {e.description ? (
            <div className={expanded ? 'whitespace-pre-wrap text-xs text-slate-500' : 'truncate text-xs text-slate-500'}>
              {e.description}
            </div>
          ) : null}
        </div>
        <span className="whitespace-nowrap text-[11px] text-slate-500">{fmt(e.created_at)}</span>
      </div>
      {expanded && e.data && Object.keys(e.data).length > 0 ? (
        <pre className="overflow-x-auto border-t bg-slate-50 p-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
          {JSON.stringify(e.data, null, 2)}
        </pre>
      ) : null}
    </li>
  )
}

export default function AgentActivityTimeline({ data }) {
  const events = Array.isArray(data?.events) ? data.events : []
  const source = data?.source || 'unified'
  const [expandedId, setExpandedId] = useState(null)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-slate-500" />
          Agent activity timeline
        </CardTitle>
        <span className="text-[10px] uppercase text-slate-500">
          source: {source}
        </span>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="rounded border bg-slate-50 p-4 text-sm text-slate-500">
            No activity yet — events will appear here once agents start emitting telemetry.
          </div>
        ) : (
          <ol className="relative space-y-2 text-sm">
            {events.slice(0, 100).map((e) => (
              <EventRow
                key={e.id}
                e={e}
                expanded={expandedId === e.id}
                onToggle={(id) => setExpandedId((prev) => (prev === id ? null : id))}
              />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
