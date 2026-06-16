import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Activity } from 'lucide-react'

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

export default function AgentActivityTimeline({ data }) {
  const events = Array.isArray(data?.events) ? data.events : []
  const source = data?.source || 'unified'

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
              <li key={e.id} className="flex items-start gap-3 rounded border bg-white p-2 dark:border-slate-800 dark:bg-slate-900/40">
                <Badge variant="outline" className="text-[10px] uppercase">
                  {e.agent_name}
                </Badge>
                <Badge variant="outline" className={`text-[10px] uppercase ${STATUS_STYLES[e.status] || ''}`}>
                  {e.status || 'info'}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{e.title || e.event_type}</div>
                  {e.description ? (
                    <div className="truncate text-xs text-slate-500">{e.description}</div>
                  ) : null}
                </div>
                <span className="whitespace-nowrap text-[11px] text-slate-500">{fmt(e.created_at)}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
