import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  PlayCircle,
  RefreshCw,
  TrendingUp,
  Wrench,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { getAmyStatus, getAmyLatestReport, runAmy } from '@/api/amy'

/**
 * AdminAmyConsole — Agent Amy. Amy generates synthetic profiles, runs a real
 * crawler event at the 75% slider against each, measures crawler quality, and
 * drives improvements: it auto-tunes the (reversible) score floor when the
 * cohort proves a better one, hands implicated files to Anya→Sam, and stages
 * deeper fixes into an approval queue. This panel shows the latest run.
 */

const SEVERITY_TONE = {
  high: 'bg-orange-100 text-orange-800 border-orange-200',
  medium: 'bg-amber-100 text-amber-900 border-amber-200',
  low: 'bg-slate-100 text-slate-700 border-slate-200',
}

function fmtDate(v) {
  if (!v) return '—'
  try { return new Date(v).toLocaleString() } catch { return String(v) }
}
function pct(v) {
  return Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}%` : '—'
}

function Metric({ label, value, tone }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${tone || ''}`}>{value}</div>
    </div>
  )
}

export default function AdminAmyConsole() {
  const { toast } = useToast()
  const [status, setStatus] = useState(null)
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [applyTuning, setApplyTuning] = useState(false)
  const [applyWeights, setApplyWeights] = useState(false)
  const [applyCoverage, setApplyCoverage] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([getAmyStatus().catch(() => null), getAmyLatestReport().catch(() => null)])
      const st = s?.status ?? null
      setStatus(st)
      setReport(r?.report ?? null)
      // Reflect an in-flight run (manual OR scheduled, even started by another
      // admin or the server) so the panel shows progress on load.
      setBusy(Boolean(st?.running))
      return st
    } catch (err) {
      toast({ title: 'Failed to load Agent Amy', description: err?.message || 'Unknown error', variant: 'destructive' })
      return null
    }
  }, [toast])

  useEffect(() => { refresh() }, [refresh])

  // Amy runs in the background (minutes): the POST returns 202 immediately, then
  // we poll /status until the run clears. Caps at ~20 min so a stuck run can't
  // spin forever.
  const runNow = async () => {
    setBusy(true)
    try {
      const res = await runAmy({ count: 12, improve: true, applyTuning, applyWeights, applyCoverage })
      toast({
        title: res?.already_running ? 'Amy already running' : 'Amy run started',
        description: res?.already_running
          ? 'A run is already in progress — watching for results.'
          : 'Crawling synthetic profiles, then Anya → Sam. This takes a few minutes.',
      })

      const deadline = Date.now() + 20 * 60 * 1000
      // give the server a moment to flip running=true before we poll
      await new Promise((r) => setTimeout(r, 1500))
      while (Date.now() < deadline) {
        const st = await refresh()
        if (st && st.running === false) {
          if (st.last_run_error) {
            toast({ title: 'Amy run failed', description: st.last_run_error, variant: 'destructive' })
          } else {
            toast({ title: 'Amy run complete', description: 'Report updated below.' })
          }
          return
        }
        await new Promise((r) => setTimeout(r, 5000))
      }
      toast({ title: 'Amy still running', description: 'Taking longer than expected — use Refresh to check back.' })
    } catch (err) {
      toast({ title: 'Amy run failed', description: err?.message || 'Unknown error', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const before = report?.metrics?.before
  const after = report?.metrics?.after
  const tuning = report?.tuning
  const cohort = report?.cohort
  const queue = useMemo(() => (Array.isArray(report?.approval_queue) ? report.approval_queue : []), [report])
  const findings = useMemo(() => (Array.isArray(report?.amy?.handoff?.findings) ? report.amy.handoff.findings : []), [report])
  const findingsByType = useMemo(() => report?.amy?.handoff?.amy_summary?.by_finding_type || {}, [report])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5" /> Agent Amy — Crawler Training & Improvement
            </CardTitle>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-muted-foreground select-none">
                <input type="checkbox" checked={applyTuning} onChange={(e) => setApplyTuning(e.target.checked)} />
                floor
              </label>
              <label className="flex items-center gap-1 text-xs text-muted-foreground select-none">
                <input type="checkbox" checked={applyWeights} onChange={(e) => setApplyWeights(e.target.checked)} />
                weights
              </label>
              <label className="flex items-center gap-1 text-xs text-muted-foreground select-none">
                <input type="checkbox" checked={applyCoverage} onChange={(e) => setApplyCoverage(e.target.checked)} />
                coverage
              </label>
              <Button size="sm" variant="outline" onClick={refresh} disabled={busy}>
                <RefreshCw className="h-4 w-4 mr-1" /> Refresh
              </Button>
              <Button size="sm" onClick={runNow} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <PlayCircle className="h-4 w-4 mr-1" />}
                Run now
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className={status?.enabled ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : ''}>
              {status?.enabled ? 'Daily schedule ON' : 'Daily schedule OFF'}
            </Badge>
            <Badge variant="outline">Target {status?.daily_target ?? 100}/day</Badge>
            <Badge variant="outline">Slider floor {report?.slider_floor ?? status?.slider_floor ?? '—'}%</Badge>
            {status?.running && (
              <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-200">
                <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Running{status?.running_source ? ` (${status.running_source})` : ''}…
              </Badge>
            )}
            <span className="text-muted-foreground">Last run: {fmtDate(report?.completed_at || status?.last_run_at)}</span>
          </div>

          {!report && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {status?.running
                ? 'First Amy run in progress — crawling profiles, then Anya → Sam. Results will appear here shortly.'
                : status?.enabled
                  ? 'No Amy run recorded yet. The daily run is scheduled; click “Run now” to start one immediately.'
                  : 'No Amy run yet. Click “Run now” (Amy’s daily schedule is currently disabled).'}
            </div>
          )}

          {report && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric label="Profiles crawled" value={report?.crawler_events?.crawled ?? '—'} />
              <Metric label="Coverage" value={pct(after?.covered_rate ?? before?.covered_rate)} tone="text-emerald-700" />
              <Metric label="Zero-result" value={pct(after?.zero_rate ?? before?.zero_rate)} tone="text-orange-700" />
              <Metric label="False-positive" value={pct(after?.false_positive_rate ?? before?.false_positive_rate)} tone="text-red-700" />
            </div>
          )}
        </CardContent>
      </Card>

      {report && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4" /> Crawler score-floor tuning
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              {tuning?.applied?.applied ? (
                <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200" variant="outline">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Applied: floor {tuning.from} → {tuning.to}
                </Badge>
              ) : tuning?.change ? (
                <Badge className="bg-amber-100 text-amber-900 border-amber-200" variant="outline">
                  Proposed: floor {tuning.from} → {tuning.to} (enable “apply tuning” to save)
                </Badge>
              ) : (
                <Badge variant="outline">No floor change — {tuning?.reason || 'optimal'}</Badge>
              )}
              <span className="text-muted-foreground">
                quality {before?.quality_score ?? '—'} → {after?.quality_score ?? '—'} (best floor {report?.metrics?.best?.floor ?? '—'})
              </span>
            </div>
            {tuning?.applied?.backup_path && (
              <div className="text-xs text-muted-foreground">Reversible — backup: {tuning.applied.backup_path}</div>
            )}
            {report?.weight_tuning && (
              <div className="text-xs">
                <span className="font-medium">Scoring weights: </span>
                {report.weight_tuning.validation?.kept
                  ? <span className="text-emerald-700">tuned + kept (quality {report.weight_tuning.validation.baseline}→{report.weight_tuning.validation.after})</span>
                  : report.weight_tuning.validation?.reverted
                    ? <span className="text-muted-foreground">tried, reverted (no improvement)</span>
                    : <span className="text-muted-foreground">{report.weight_tuning.reason || 'no change'}</span>}
              </div>
            )}
            {report?.coverage_tuning && (
              <div className="text-xs">
                <span className="font-medium">Source coverage: </span>
                {report.coverage_tuning.validation?.kept
                  ? <span className="text-emerald-700">extended + kept ({(report.coverage_tuning.additions || []).map((a) => a.category).join(', ')})</span>
                  : report.coverage_tuning.validation?.reverted
                    ? <span className="text-muted-foreground">tried, reverted (no improvement)</span>
                    : <span className="text-muted-foreground">{report.coverage_tuning.reason || 'no change'}</span>}
              </div>
            )}
            {report?.archetype_learning && (
              <div className="text-xs">
                <span className="font-medium">Query steering (per archetype): </span>
                {Object.keys(report.archetype_learning.update || {}).length > 0
                  ? (
                    <span className="text-emerald-700">
                      {Object.entries(report.archetype_learning.update).map(([k, v]) => `${k} → ${(v.classes || []).join('+')}`).join(' · ')}
                      {' '}(steers the next crawl for these archetypes)
                    </span>
                  )
                  : <span className="text-muted-foreground">no systematic gap this run</span>}
              </div>
            )}
            {cohort && (
              <div className="text-xs text-muted-foreground">
                Cohort: {cohort.profiles} profiles · ok {cohort.ok} · weak {cohort.weak} · zero {cohort.zero} · source-failures {cohort.source_failure_profiles}
              </div>
            )}
            {report?.archetype_metrics && Object.keys(report.archetype_metrics).length > 0 && (
              <div className="text-xs text-muted-foreground">
                By archetype:{' '}
                {Object.entries(report.archetype_metrics)
                  .map(([k, m]) => `${k} ${m.qualified} qualified / ${m.ineligible_accepts} ineligible (${m.profiles}p)`)
                  .join(' · ')}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {report && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="h-4 w-4" /> Improvement approval queue ({queue.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {queue.length === 0 && <div className="text-sm text-muted-foreground">No deeper improvements pending approval.</div>}
            {queue.map((item) => (
              <div key={item.id} className="rounded-lg border p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={SEVERITY_TONE[item.severity] || ''}>{item.severity}</Badge>
                  <span className="font-medium">{item.lever}</span>
                  {item.category && <Badge variant="outline">{item.category}</Badge>}
                  {item.auto_applied && (
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                      auto-applied: {item.auto_applied.lever}
                    </Badge>
                  )}
                  <code className="text-xs text-muted-foreground">{item.target_file}</code>
                </div>
                <div className="text-sm mt-1">{item.rationale}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {report && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What Anya saw ({findings.length} findings)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {Object.entries(findingsByType).map(([type, count]) => (
                <Badge key={type} variant="outline">{type}: {count}</Badge>
              ))}
            </div>
            <div className="space-y-1 max-h-72 overflow-auto">
              {findings.slice(0, 40).map((f, i) => (
                <div key={`${f.file}-${i}`} className="text-xs flex items-start gap-2 border-b py-1">
                  <Badge variant="outline" className={SEVERITY_TONE[f.severity] || ''}>{f.type}</Badge>
                  <code className="text-muted-foreground shrink-0">{f.file}</code>
                  <span>{f.message}</span>
                </div>
              ))}
            </div>
            {report?.chain && (
              <div className="text-xs text-muted-foreground border-t pt-2">
                Chain — Anya: {report.chain.anya?.files_targeted?.length ?? 0} files analyzed, {report.chain.anya?.files_modified ?? 0} modified
                {report.chain.sam ? ` · Sam: ${report.chain.sam.applied_fixes?.length ?? 0} safe fix(es), health ${report.chain.sam.health_score ?? '—'}` : ''}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
