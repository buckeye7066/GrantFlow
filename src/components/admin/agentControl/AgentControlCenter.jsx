import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play,
  Pause,
  Square,
  AlertOctagon,
  RefreshCw,
  CheckCircle,
  Workflow,
  ShieldCheck,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import agentControlApi from '@/api/agentControl'
import { useAuthStore } from '@/stores/authStore'
import AgentControlAgentCard from './AgentControlAgentCard.jsx'
import AnyaAutonomyToggle from './AnyaAutonomyToggle.jsx'
import AdversarialRepairToggle from './AdversarialRepairToggle.jsx'
import AgentControlRunDetails from './AgentControlRunDetails.jsx'
import AgentControlEventsTimeline from './AgentControlEventsTimeline.jsx'

const ALL_AGENTS = ['sam', 'robert', 'yana', 'john', 'hamilton']
const AGENT_LABEL = {
  sam: 'Sam (Production Readiness)',
  robert: 'Robert (Funding Discovery)',
  yana: 'Yana (Client Discovery)',
  john: 'John (Outreach Drafts)',
  hamilton: 'Hamilton (Application Autopilot)',
}

const POLL_MS = 7_000

/**
 * AgentControlCenter
 *
 * Operator-only block at the top of Mission Control. The server derives the
 * `can_control_agents` capability from trusted DB context before this client
 * loads status or controls. An eligible operator can start the full cycle, pick a subset
 * of agents, pause/resume/stop/emergency-stop, and see per-agent status
 * + live events. Non-admin callers get a friendly hidden notice — the
 * backend rejects every request with 403 anyway.
 */
export default function AgentControlCenter() {
  const user = useAuthStore((state) => state.user)
  const isDbAdmin = user?.is_admin === true || user?.is_admin === 1
  const [canControlAgents, setCanControlAgents] = useState(null)

  const [status, setStatus] = useState(null)
  const [activeRun, setActiveRun] = useState(null)
  const [events, setEvents] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  const [actionInFlight, setActionInFlight] = useState(null)
  const [error, setError] = useState(null)
  const [agentToggles, setAgentToggles] = useState(() => Object.fromEntries(ALL_AGENTS.map((a) => [a, true])))
  const [options, setOptions] = useState({
    run_sam_preflight: true,
    run_sam_postflight: true,
    allow_robert_ingest: true,
    allow_yana_leads: true,
    allow_john_drafts: true,
    allow_john_send: false,
    allow_hamilton_autopilot: true,
    stop_on_critical_sam_finding: true,
    stop_on_agent_failure: false,
    max_runtime_minutes: 60,
  })
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false
    setCanControlAgents(null)
    if (!isDbAdmin) {
      setCanControlAgents(false)
      return () => { cancelled = true }
    }
    agentControlApi.capability()
      .then((result) => {
        if (!cancelled) setCanControlAgents(result?.can_control_agents === true)
      })
      .catch(() => {
        if (!cancelled) setCanControlAgents(false)
      })
    return () => { cancelled = true }
  }, [isDbAdmin, user?.id, user?.userId])

  const fetchStatus = useCallback(async () => {
    if (canControlAgents !== true) return
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    setError(null)
    try {
      const s = await agentControlApi.status()
      setStatus(s)
      const ar = s?.active_run || null
      setActiveRun(ar)
      if (ar?.id) {
        try {
          const e = await agentControlApi.getEvents(ar.id, { limit: 100 })
          setEvents(Array.isArray(e?.events) ? e.events : [])
        } catch { /* ignore */ }
      } else {
        setEvents([])
      }
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setRefreshing(false)
      inFlight.current = false
    }
  }, [canControlAgents])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  useEffect(() => {
    if (canControlAgents !== true) return undefined
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      fetchStatus()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [canControlAgents, fetchStatus])

  const selectedAgents = useMemo(
    () => ALL_AGENTS.filter((a) => agentToggles[a]),
    [agentToggles],
  )

  async function safeAction(name, action) {
    if (actionInFlight) return
    setActionInFlight(name)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setActionInFlight(null)
      fetchStatus()
    }
  }

  const onStartFullCycle = () =>
    safeAction('start_full_cycle', () => agentControlApi.startFullCycle(options))

  const onStartSelected = () =>
    safeAction('start_selected', () => agentControlApi.startSelectedAgents(selectedAgents, options))

  const onStartAgent = (name) =>
    safeAction(`start_${name}`, () => agentControlApi.startAgent(name, options))

  const onPause = () =>
    activeRun && safeAction('pause', () => agentControlApi.pause(activeRun.id))
  const onResume = () =>
    activeRun && safeAction('resume', () => agentControlApi.resume(activeRun.id))
  const onStop = () =>
    activeRun && safeAction('stop', () => agentControlApi.stop(activeRun.id))
  const onEmergencyStop = () => {
    if (!activeRun) return
    if (typeof window !== 'undefined' && !window.confirm('Emergency stop the current run? In-flight operations may be aborted.')) {
      return
    }
    safeAction('emergency_stop', () => agentControlApi.emergencyStop(activeRun.id, 'admin emergency stop'))
  }

  if (canControlAgents !== true) {
    return (
      <Card className="border-amber-200 bg-amber-50 dark:border-amber-900/30 dark:bg-amber-900/10">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
            <ShieldCheck className="h-5 w-5" />
            Agent Control Center {canControlAgents === null ? '(checking access)' : '(operator only)'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-amber-900 dark:text-amber-200">
          {canControlAgents === null
            ? 'Checking the server-issued Agent Control capability…'
            : 'These controls require the designated, DB-recognized operator. Other administrators retain their normal admin tools.'}
        </CardContent>
      </Card>
    )
  }

  const runStatus = activeRun?.status || null
  const isPausing = runStatus === 'pausing'
  const isPaused = runStatus === 'paused'
  const isStopping = runStatus === 'stopping'
  const isRunning = ['queued', 'running'].includes(runStatus)
  const canPause = isRunning
  const canResume = isPaused || isPausing
  const canStop = ['queued', 'running', 'pausing', 'paused'].includes(runStatus)

  return (
    <Card className="border-blue-200 dark:border-blue-900/30">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-slate-900 dark:text-slate-100">
              <Workflow className="h-5 w-5 text-blue-600" />
              Agent Control Center
            </CardTitle>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Start, stop, pause, resume, and monitor the entire agent process. The server verifies administrator authority for every action.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {activeRun ? (
              <Badge variant={runStatus === 'running' ? 'default' : runStatus === 'failed' ? 'destructive' : 'secondary'}>
                Run {String(activeRun.id).slice(0, 8)} · {runStatus}
              </Badge>
            ) : (
              <Badge variant="outline">No active run</Badge>
            )}
            <Button variant="outline" size="sm" onClick={fetchStatus} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-1.5 hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900/30 dark:bg-rose-900/10 dark:text-rose-200">
            <span className="font-semibold">Action failed:</span> {error}
          </div>
        ) : null}

        {/* Top action row — always visible so admin can stop quickly */}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onStartFullCycle} disabled={Boolean(actionInFlight) || isRunning}>
            <Play className="h-4 w-4 mr-1.5" /> Start full cycle
          </Button>
          <Button variant="secondary" onClick={onStartSelected} disabled={Boolean(actionInFlight) || isRunning || selectedAgents.length === 0}>
            <Play className="h-4 w-4 mr-1.5" /> Start selected ({selectedAgents.length})
          </Button>
          <Button variant="outline" onClick={onPause} disabled={!canPause || Boolean(actionInFlight)}>
            <Pause className="h-4 w-4 mr-1.5" /> Pause
          </Button>
          <Button variant="outline" onClick={onResume} disabled={!canResume || Boolean(actionInFlight)}>
            <Play className="h-4 w-4 mr-1.5" /> Resume
          </Button>
          <Button variant="outline" onClick={onStop} disabled={!canStop || Boolean(actionInFlight)}>
            <Square className="h-4 w-4 mr-1.5" /> Stop
          </Button>
          <Button variant="destructive" onClick={onEmergencyStop} disabled={!canStop || Boolean(actionInFlight)}>
            <AlertOctagon className="h-4 w-4 mr-1.5" /> Emergency stop
          </Button>
          {isStopping ? <span className="text-sm text-slate-500 ml-2">Stopping…</span> : null}
        </div>

        {/* Agent toggles + options */}
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Agents to include</div>
            <div className="space-y-1.5">
              {ALL_AGENTS.map((a) => (
                <label key={a} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={Boolean(agentToggles[a])}
                    onCheckedChange={(v) => setAgentToggles((prev) => ({ ...prev, [a]: Boolean(v) }))}
                  />
                  <span className="text-slate-700 dark:text-slate-200">{AGENT_LABEL[a]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Run options</div>
            <div className="space-y-1.5">
              {[
                ['run_sam_preflight', 'Run Sam preflight'],
                ['run_sam_postflight', 'Run Sam postflight'],
                ['allow_robert_ingest', 'Allow Robert to ingest opportunities'],
                ['allow_yana_leads', 'Allow Yana to push leads to John'],
                ['allow_john_drafts', 'Allow John to draft outreach emails'],
                ['allow_john_send', 'Allow John to SEND outreach emails (off by default)'],
                ['allow_hamilton_autopilot', 'Allow Hamilton autopilot to process queue'],
                ['stop_on_critical_sam_finding', 'Stop cycle if Sam preflight finds a critical issue'],
                ['stop_on_agent_failure', 'Stop cycle if any agent fails'],
              ].map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={Boolean(options[key])}
                    onCheckedChange={(v) => setOptions((prev) => ({ ...prev, [key]: Boolean(v) }))}
                  />
                  <span className="text-slate-700 dark:text-slate-200">{label}</span>
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm">
                <span className="text-slate-700 dark:text-slate-200">Max runtime (minutes):</span>
                <input
                  type="number"
                  min={5}
                  max={1440}
                  value={Number(options.max_runtime_minutes) || 60}
                  onChange={(e) => setOptions((prev) => ({ ...prev, max_runtime_minutes: Math.max(5, Math.min(1440, Number(e.target.value) || 60)) }))}
                  className="ml-2 w-20 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
                />
              </label>
            </div>
          </div>
        </div>

        {/* Per-agent cards */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {ALL_AGENTS.map((name) => (
            <AgentControlAgentCard
              key={name}
              name={name}
              status={status?.agents?.[name]}
              activeRun={activeRun}
              busy={Boolean(actionInFlight)}
              onStart={() => onStartAgent(name)}
              onStop={() => safeAction(`stop_${name}`, () => agentControlApi.stopAgent(name))}
            />
          ))}
        </div>

        {/* Anya is interactive (no start/stop card) — expose her autonomy toggle here */}
        <AnyaAutonomyToggle />

        {/* Owner control for autonomous adversarial code repair (+ direct-to-main) */}
        <AdversarialRepairToggle />

        {/* Run details + events */}
        {activeRun ? (
          <>
            <AgentControlRunDetails run={activeRun} highlights={status?.highlights} />
            <AgentControlEventsTimeline events={events} />
          </>
        ) : status?.highlights ? (
          <div className="rounded border border-slate-200 dark:border-slate-700 p-3 text-sm text-slate-600 dark:text-slate-300">
            <div className="font-semibold mb-1 flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-600" /> No active run
            </div>
            <div className="grid gap-1 sm:grid-cols-2">
              <div>Last run: {status.highlights.last ? `${status.highlights.last.run_type} (${status.highlights.last.status})` : '—'}</div>
              <div>Last full cycle: {status.highlights.last_full_cycle?.status || '—'}</div>
              <div className="text-emerald-700 dark:text-emerald-300">
                Last success: {status.highlights.last_success?.completed_at?.slice(0, 19) || '—'}
              </div>
              <div className={status.highlights.last_failure_is_stale
                ? 'text-slate-500 dark:text-slate-400'
                : 'text-rose-700 dark:text-rose-300'}>
                Last failure: {status.highlights.last_failure?.completed_at?.slice(0, 19) || '—'}
                {status.highlights.last_failure ? ` (${status.highlights.last_failure.error_message || status.highlights.last_failure.status})` : ''}
                {status.highlights.last_failure && status.highlights.last_failure_is_stale ? (
                  <span className="ml-1 italic">
                    — stale
                    {Number.isFinite(status.highlights.last_failure_age_hours)
                      ? `, ${status.highlights.last_failure_age_hours}h ago`
                      : ''}
                    {status.highlights.last_failure_superseded_by_success ? ', resolved since' : ''}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
