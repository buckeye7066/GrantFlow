import React, { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ShieldCheck, Loader2 } from 'lucide-react'
import { samApi } from '@/api/sam'

const SEVERITY_STYLES = {
  critical: 'bg-red-100 text-red-900 border-red-200',
  high: 'bg-orange-100 text-orange-900 border-orange-200',
  medium: 'bg-amber-100 text-amber-900 border-amber-200',
  low: 'bg-slate-100 text-slate-700 border-slate-200',
  info: 'bg-blue-50 text-blue-900 border-blue-200',
}

function FindingDetailDialog({ finding, open, onOpenChange, onChanged }) {
  const [busy, setBusy] = useState(null) // 'resolve' | 'ignore' | 'recheck' | null
  const [error, setError] = useState(null)
  const [recheckResult, setRecheckResult] = useState(null)

  if (!finding) return null

  async function updateFindingStatus(status) {
    setBusy(status)
    setError(null)
    try {
      const res = await samApi.updateFinding(finding.id, status)
      onChanged?.(res?.finding || { ...finding, status })
    } catch (err) {
      setError(err?.message || 'Failed to update finding')
    } finally {
      setBusy(null)
    }
  }

  async function recheck() {
    setBusy('recheck')
    setError(null)
    setRecheckResult(null)
    try {
      // event_type is the originating check's id (samDiagnostics.js's
      // runInternalCheck wrapper stamps it) so this re-runs EXACTLY the check
      // that produced this finding — no guessing which of ~35 checks to run.
      if (!finding.event_type) {
        setError('This finding predates check-id tracking and cannot be scoped to a single re-check. Run a full diagnose instead.')
        return
      }
      const res = await samApi.run({ mode: 'observe', checks: [finding.event_type] })
      const stillFailing = (res?.findings || []).some((f) => f.event_type === finding.event_type || f.title === finding.title)
      setRecheckResult(stillFailing ? 'still_failing' : 'resolved')
      if (!stillFailing) await updateFindingStatus('resolved')
    } catch (err) {
      setError(err?.message || 'Re-check failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[10px] uppercase ${SEVERITY_STYLES[finding.severity] || ''}`}>
              {finding.severity}
            </Badge>
            {finding.title}
          </DialogTitle>
          {finding.description ? <DialogDescription>{finding.description}</DialogDescription> : null}
        </DialogHeader>

        <div className="space-y-2 text-sm">
          {finding.file_path ? (
            <div className="text-xs text-slate-500">
              <span className="font-medium">File:</span> <span className="font-mono">{finding.file_path}</span>
            </div>
          ) : null}
          {finding.recommended_fix ? (
            <div className="rounded border bg-slate-50 p-2 text-xs dark:bg-slate-900/40">
              <div className="mb-1 font-medium text-slate-700 dark:text-slate-300">Recommended fix</div>
              <div className="text-slate-600 dark:text-slate-400">{finding.recommended_fix}</div>
            </div>
          ) : null}
          <div className="text-xs text-slate-500">
            <span className="font-medium">Status:</span> {finding.status}
            {finding.event_type ? <span className="ml-2 font-mono text-slate-400">check: {finding.event_type}</span> : null}
          </div>

          {recheckResult === 'resolved' ? (
            <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">
              Re-check passed — this no longer reproduces. Marked resolved.
            </div>
          ) : null}
          {recheckResult === 'still_failing' ? (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              Re-check ran — the problem still reproduces. Left open.
            </div>
          ) : null}
          {error ? <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div> : null}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={recheck}>
            {busy === 'recheck' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Re-check now
          </Button>
          <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => updateFindingStatus('ignored')}>
            {busy === 'ignore' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Mark ignored
          </Button>
          <Button size="sm" disabled={Boolean(busy)} onClick={() => updateFindingStatus('resolved')}>
            {busy === 'resolve' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Mark resolved
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function SamErrorPanel({ data, onFindingUpdated }) {
  // Default to "issues only" (critical/high/medium/low). INFO entries are
  // environment notes Sam emits when a tool can't run in the production
  // runtime (no source tree, sandboxed network, schema bootstrap pending, …)
  // — they are NOT failures and were drowning the panel with recurring
  // "skipped" lines that the operator read as errors. We keep them
  // accessible via the dropdown ("Show all (incl. info)") so they're never
  // silently lost; the badge row still surfaces real severities.
  const [severity, setSeverity] = useState('issues')
  const [status, setStatus] = useState('all')
  const [selected, setSelected] = useState(null)
  const [overrides, setOverrides] = useState({}) // id -> patched finding (optimistic, until next fetch)

  const findings = data?.findings?.findings || []
  const counts = data?.findings?.counts || {}
  const installed = data?.summary?.installed || data?.findings?.installed

  const merged = useMemo(
    () => findings.map((f) => (overrides[f.id] ? { ...f, ...overrides[f.id] } : f)),
    [findings, overrides],
  )

  const filtered = useMemo(() => {
    return merged.filter((f) => {
      if (severity === 'issues' && f.severity === 'info') return false
      if (severity !== 'all' && severity !== 'issues' && f.severity !== severity) return false
      if (status !== 'all' && f.status !== status) return false
      return true
    })
  }, [merged, severity, status])

  function handleChanged(updated) {
    setOverrides((prev) => ({ ...prev, [updated.id]: updated }))
    onFindingUpdated?.()
  }

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
                  <li
                    key={f.id}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(f)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(f) } }}
                  >
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
      <FindingDetailDialog
        finding={selected}
        open={Boolean(selected)}
        onOpenChange={(next) => { if (!next) setSelected(null) }}
        onChanged={(updated) => { handleChanged(updated); setSelected(updated) }}
      />
    </Card>
  )
}
