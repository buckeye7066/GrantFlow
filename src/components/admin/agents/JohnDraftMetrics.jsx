import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Mail } from 'lucide-react'
import { Progress } from '@/components/ui/progress'

export default function JohnDraftMetrics({ data }) {
  const summary = data?.summary || {}
  const m = summary.primary_metrics || {}
  const installed = summary.installed
  const cap = Number(m.daily_capacity_total ?? 50)
  const used = Number(m.drafts_created_24h ?? 0)
  const remaining = Number(m.daily_capacity_remaining ?? Math.max(0, cap - used))
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Mail className="h-4 w-4 text-slate-500" />
          John — outreach draft production
          {!installed ? <span className="ml-2 text-xs font-normal text-slate-500">Not installed</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!installed ? (
          <div className="rounded border bg-slate-50 p-4 text-sm text-slate-500">
            John isn't installed yet. Daily capacity will appear here once he runs.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-sm">
              <span>
                <span className="font-mono font-semibold">{used}</span> / {cap} drafts in last 24h
              </span>
              <span className="text-xs text-slate-500">{remaining} remaining</span>
            </div>
            <Progress value={pct} className="mt-2 h-2" />

            <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="Drafts created" value={m.drafts_created} />
              <Stat label="Blocked" value={m.drafts_blocked} />
              <Stat label="Alias review" value={m.drafts_needing_alias_review} />
              <Stat label="Suppression hits" value={m.suppression_hits} />
            </dl>

            {m.block_reasons && Object.keys(m.block_reasons).length ? (
              <div className="mt-3">
                <div className="text-xs font-semibold text-slate-500">Top block reasons</div>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {Object.entries(m.block_reasons)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 6)
                    .map(([reason, n]) => (
                      <li key={reason} className="flex items-center justify-between rounded border bg-slate-50 px-2 py-0.5 dark:bg-slate-900/40">
                        <span className="capitalize">{reason.replace(/_/g, ' ')}</span>
                        <span className="font-mono">{n}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}

            {m.alias_status ? (
              <div className="mt-3 rounded border bg-slate-50 p-2 text-xs dark:bg-slate-900/40">
                Alias status: <span className="font-mono">{m.alias_status}</span>
                {m.alias_checked_at ? (
                  <span className="ml-2 text-slate-500">
                    (checked {new Date(m.alias_checked_at).toLocaleString()})
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded border bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value ?? 0}</div>
    </div>
  )
}
