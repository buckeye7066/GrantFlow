import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sparkles, Loader2, RefreshCw } from 'lucide-react'
import client from '@/api/client'
import { statusLabel } from '@/api/hamilton'
import { StatusDot } from '@/components/ui/StatusDot'
import HamiltonTaskDrawer from './HamiltonTaskDrawer'
import { partitionHamiltonTasks } from '../../../shared/hamiltonTaskLifecycle.js'

/**
 * HamiltonAutomationQueue
 *
 * Renders a compact list of the active Hamilton automation tasks for one
 * profile. Each row shows: a Funding Current StatusDot, title, automation_type
 * badge, status, and a View button that opens the HamiltonTaskDrawer.
 *
 * Polls /api/hamilton/automation/tasks every 15s while mounted so the queue
 * reflects orchestrator progress without manual refresh.
 *
 * DESIGN: Funding Current identity — the StatusDot accent IS the status
 * language: emerald=running, coral=needs-you, amber=submitted/awarded. This is
 * a RESTYLE only; all polling, data, and handlers are unchanged.
 */

// Map a raw Hamilton task status to a StatusDot tone (the product status
// language). Anything that needs a human is coral; live work is emerald;
// a finished/submitted application is amber; terminal/idle states stay neutral.
function taskTone(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'waiting_for_user' || s === 'waiting_for_admin' || s.startsWith('blocked')) {
    return 'needs'
  }
  if (s === 'submitted' || s === 'draft_completed') return 'awarded'
  // Live, healthy work → emerald (the "running" tone in the mockup).
  if (s === 'queued' || s === 'ready' || s === 'in_progress') return 'ready'
  return 'neutral'
}
export default function HamiltonAutomationQueue({ profileId }) {
  const [tasks, setTasks] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [openTask, setOpenTask] = useState(null)

  // Guard against overlapping polls — the 15s tick can fire while a previous
  // fetch is still pending. Each call names itself with an incrementing run id;
  // only the newest run is allowed to update tasks/loading, so a slow older
  // response can't clobber fresher data with stale tasks.
  const runIdRef = useRef(0)
  const load = useCallback(async () => {
    if (!profileId) return
    const runId = ++runIdRef.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ profile_id: String(profileId) })
      const res = await client.get(`/api/hamilton/automation/tasks?${params.toString()}`)
      if (runId !== runIdRef.current) return
      const partition = partitionHamiltonTasks(res)
      setTasks(partition.current)
      setHistory(partition.history)
    } catch {
      // Network errors shouldn't tear the panel down — leave the prior list visible.
    } finally {
      if (runId === runIdRef.current) setLoading(false)
    }
  }, [profileId])

  useEffect(() => {
    if (!profileId) return
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [profileId, load])

  if (!profileId) return null

  return (
    <Card className="border-current-line">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 font-display text-current-ink dark:text-slate-100">
          <Sparkles className="h-4 w-4 text-current-emerald" />
          Hamilton Autopilot queue
          <Badge variant="outline" className="money ml-1 border-current-line text-[10px] text-current-ink/70">{tasks.length}</Badge>
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={load} title="Refresh">
          {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <div className="text-xs text-current-ink/75 dark:text-slate-300">
            Nothing here yet. Select a funding source and choose its <span className="font-semibold">Prepare with Hamilton</span> action. Hamilton prepares the draft; you review it and complete the final portal submission.
          </div>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => {
              const tone = taskTone(t.status)
              return (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-current-line bg-current-card px-3 py-2.5 transition-transform hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                >
                  <StatusDot tone={tone} className="mt-0.5 self-start" />
                  <div className="min-w-0 flex-1">
                    <div className="money truncate text-sm font-medium text-current-ink">
                      {t.display_title || t.funder_name || (t.opportunity_id
                        ? `opportunity ${String(t.opportunity_id).slice(0, 8)}…`
                        : t.grant_id ? `grant ${String(t.grant_id).slice(0, 8)}…` : 'task')}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-current-ink/60">
                      <span className="money inline-flex items-center gap-1.5">
                        <StatusDot tone={tone} size="sm" />
                        {statusLabel(t.status)}
                      </span>
                      {t.automation_type && t.automation_type !== 'unknown' && (
                        <Badge variant="outline" className="border-current-line bg-current-emeraldSoft text-[10px] text-current-emerald">{t.automation_type.replace('_', ' ')}</Badge>
                      )}
                      {t.status === 'submitted' && t.submission_proof && !t.submission_proof.verified_external && (
                        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[10px] text-amber-800" title="Marked submitted — not confirmed sent to the funder; no captured portal confirmation on file.">
                          internal record
                        </Badge>
                      )}
                      {t.status === 'submitted' && t.submission_proof?.verified_external && (
                        <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-[10px] text-emerald-800" title="Externally submitted — portal confirmation on file.">
                          confirmed
                        </Badge>
                      )}
                      {t.selected_from_stage && (
                        <span>· from {t.selected_from_stage}</span>
                      )}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setOpenTask(t)}>
                    View
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        {history.length > 0 && (
          <details className="mt-4 border-t border-current-line pt-3">
            <summary className="cursor-pointer text-xs font-medium text-current-ink/70">
              History ({history.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {history.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-current-line bg-current-card/60 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-current-ink/80">{t.display_title || t.funder_name || `task ${String(t.id).slice(0, 8)}…`}</div>
                    <div className="text-[11px] text-current-ink/55">{statusLabel(t.status)}{t.outcome_reason ? ` · ${t.outcome_reason}` : ''}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setOpenTask(t)}>View</Button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>

      {openTask && (
        <HamiltonTaskDrawer
          open={!!openTask}
          task={openTask}
          onClose={() => setOpenTask(null)}
          onTaskUpdated={() => load()}
        />
      )}
    </Card>
  )
}
