import React, { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ShieldCheck } from 'lucide-react'

const SEVERITY_STYLES = {
  critical: 'bg-red-100 text-red-900 border-red-200',
  high: 'bg-orange-100 text-orange-900 border-orange-200',
  medium: 'bg-amber-100 text-amber-900 border-amber-200',
  low: 'bg-slate-100 text-slate-700 border-slate-200',
  info: 'bg-blue-50 text-blue-900 border-blue-200',
}

export default function SamErrorPanel({ data }) {
  // Default to "issues only" (critical/high/medium/low). INFO entries are
  // environment notes Sam emits when a tool can't run in the production
  // runtime (no source tree, sandboxed network, schema bootstrap pending, …)
  // — they are NOT failures and were drowning the panel with recurring
  // "skipped" lines that the operator read as errors. We keep them
  // accessible via the dropdown ("Show all (incl. info)") so they're never
  // silently lost; the badge row still surfaces real severities.
  const [severity, setSeverity] = useState('issues')
  const [status, setStatus] = useState('all')

  const findings = data?.findings?.findings || []
  const counts = data?.findings?.counts || {}
  const installed = data?.summary?.installed || data?.findings?.installed

  const filtered = useMemo(() => {
    return findings.filter((f) => {
      if (severity === 'issues' && f.severity === 'info') return false
      if (severity !== 'all' && severity !== 'issues' && f.severity !== severity) return false
      if (status !== 'all' && f.status !== status) return false
      return true
    })
  }, [findings, severity, status])

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-slate-500" />
          Sam — production readiness findings
        </CardTitle>
        <div className="flex items-center gap-2 text-xs">
          {['critical', 'high', 'medium', 'low'].map((sev) => (
            <Badge key={sev} variant="outline" className={`text-[10px] uppercase ${SEVERITY_STYLES[sev]}`}>
              {sev}: {counts[sev] || 0}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {!installed ? (
          <div className="rounded border bg-slate-50 p-4 text-sm text-slate-500">
            Sam isn't installed yet — once he runs production readiness checks his findings will appear here.
          </div>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="h-7 w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="issues">Issues only (no info)</SelectItem>
                  <SelectItem value="all">Show all (incl. info)</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="info">Info / skipped only</SelectItem>
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-7 w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="ignored">Ignored</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {filtered.length === 0 ? (
              <div className="rounded border bg-slate-50 p-4 text-sm text-slate-500">
                No findings in the selected range.
              </div>
            ) : (
              <ul className="divide-y rounded border bg-white text-sm dark:bg-slate-900/40">
                {filtered.slice(0, 50).map((f) => (
                  <li key={f.id} className="flex items-start gap-3 px-3 py-2">
                    <Badge variant="outline" className={`text-[10px] uppercase ${SEVERITY_STYLES[f.severity] || ''}`}>
                      {f.severity}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{f.title}</div>
                      {f.file_path ? (
                        <div className="truncate text-xs text-slate-500">{f.file_path}</div>
                      ) : null}
                    </div>
                    <span className="text-[11px] text-slate-500">{f.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
