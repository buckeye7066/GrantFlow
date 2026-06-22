import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Activity, CheckCircle2, AlertTriangle, XCircle, MoonStar, Wrench } from 'lucide-react'

const HEALTH_DISPLAY = {
  healthy: { Icon: CheckCircle2, color: 'text-emerald-600', label: 'Healthy' },
  // Ran cleanly but produced no output — distinct from healthy (sky, info icon),
  // not an error. Keeps the dashboard honest about silently-idle agents.
  ran_no_output: { Icon: Activity, color: 'text-sky-600', label: 'Ran, no output' },
  warning: { Icon: AlertTriangle, color: 'text-amber-600', label: 'Warning' },
  error: { Icon: XCircle, color: 'text-red-600', label: 'Error' },
  idle: { Icon: MoonStar, color: 'text-slate-500', label: 'Idle' },
  not_installed: { Icon: Wrench, color: 'text-slate-400', label: 'Not installed' },
}

export default function AgentHealthGrid({ health }) {
  const overall = health?.overall || 'idle'
  const overallDisplay = HEALTH_DISPLAY[overall] || HEALTH_DISPLAY.idle
  const Icon = overallDisplay.Icon

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-slate-500" />
          Agent system health
        </CardTitle>
        <Badge variant="outline" className="text-[10px] uppercase">
          <Icon className={`mr-1 inline h-3 w-3 ${overallDisplay.color}`} />
          {overallDisplay.label}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Object.entries(health?.diagnostics || {}).map(([agent, info]) => {
            const a = health?.agents?.[agent] || { health: 'not_installed' }
            const display = HEALTH_DISPLAY[a.health] || HEALTH_DISPLAY.idle
            const D = display.Icon
            return (
              <div
                key={agent}
                className="rounded-md border bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold capitalize">{agent}</span>
                  <span className={`flex items-center gap-1 text-xs ${display.color}`}>
                    <D className="h-3 w-3" /> {display.label}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {info.present_tables.length}/{info.present_tables.length + info.missing_tables.length} tables
                </div>
                {info.missing_tables.length ? (
                  <div className="mt-1 text-[10px] italic text-slate-500" title={info.missing_tables.join(', ')}>
                    Missing: {info.missing_tables.slice(0, 2).join(', ')}
                    {info.missing_tables.length > 2 ? `, +${info.missing_tables.length - 2}` : ''}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            Unified events table:{' '}
            <span className={health?.unified_table_present ? 'text-emerald-600' : 'text-amber-600'}>
              {health?.unified_table_present ? 'present' : 'missing'}
            </span>
          </span>
          <span>
            Daily rollups table:{' '}
            <span className={health?.rollup_table_present ? 'text-emerald-600' : 'text-amber-600'}>
              {health?.rollup_table_present ? 'present' : 'missing'}
            </span>
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
