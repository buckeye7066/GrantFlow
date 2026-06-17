import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, AlertCircle } from 'lucide-react'
import agentTelemetryApi from '@/api/agentTelemetry'
import AgentTelemetryFilters from '@/components/admin/agents/AgentTelemetryFilters'
import AgentOverviewCards from '@/components/admin/agents/AgentOverviewCards'
import AgentHealthGrid from '@/components/admin/agents/AgentHealthGrid'
import YanaLeadFunnel from '@/components/admin/agents/YanaLeadFunnel'
import HamiltonAutopilotPanel from '@/components/admin/agents/HamiltonAutopilotPanel'
import RobertOpportunityFunnel from '@/components/admin/agents/RobertOpportunityFunnel'
import RobertOpportunityMap from '@/components/admin/agents/RobertOpportunityMap'
import SamErrorPanel from '@/components/admin/agents/SamErrorPanel'
import AnyaInteractionPanel from '@/components/admin/agents/AnyaInteractionPanel'
import JohnDraftMetrics from '@/components/admin/agents/JohnDraftMetrics'
import AgentActivityTimeline from '@/components/admin/agents/AgentActivityTimeline'
import AgentControlCenter from '@/components/admin/agentControl/AgentControlCenter.jsx'

const DEFAULT_REFRESH_MS = 45_000

/**
 * Admin Agent Mission Control dashboard.
 *
 * Pulls from /api/admin/agent-telemetry/* and renders one panel per agent
 * plus an overview row + activity timeline. Designed to load even when no
 * agent has emitted telemetry yet — empty/missing-table states never crash
 * the page; each panel renders a "not installed" or empty notice locally.
 *
 * Auto-refresh defaults to 45s but is throttled (one refresh max in flight)
 * and can be disabled per-session via the filter bar checkbox.
 */
export default function AdminAgentMissionControl({ autoRefreshMs = DEFAULT_REFRESH_MS, enableAutoRefresh = true }) {
  const [range, setRange] = useState('24h')
  const [agent, setAgent] = useState('all')
  const [status, setStatus] = useState('all')
  const [autoRefresh, setAutoRefresh] = useState(enableAutoRefresh)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null)
  const [globalError, setGlobalError] = useState(null)

  const [summary, setSummary] = useState(null)
  const [timeline, setTimeline] = useState(null)
  const [yana, setYana] = useState(null)
  const [hamilton, setHamilton] = useState(null)
  const [robert, setRobert] = useState(null)
  const [robertMap, setRobertMap] = useState(null)
  const [sam, setSam] = useState(null)
  const [anya, setAnya] = useState(null)
  const [john, setJohn] = useState(null)
  const [health, setHealth] = useState(null)

  const inFlight = useRef(false)

  const buildParams = useCallback(() => {
    return {
      range,
      agent: agent === 'all' ? undefined : agent,
      status: status === 'all' ? undefined : status,
    }
  }, [range, agent, status])

  const fetchAll = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    setGlobalError(null)
    try {
      const params = buildParams()
      const safe = (p) => p.catch((err) => ({ ok: false, error: err?.message || String(err) }))
      const [s, t, y, h2, r, rm, sa, an, jo, he] = await Promise.all([
        safe(agentTelemetryApi.summary(params)),
        safe(agentTelemetryApi.timeline(params)),
        safe(agentTelemetryApi.yana(params)),
        safe(agentTelemetryApi.hamilton(params)),
        safe(agentTelemetryApi.robert(params)),
        safe(agentTelemetryApi.robertMap(params)),
        safe(agentTelemetryApi.sam(params)),
        safe(agentTelemetryApi.anya(params)),
        safe(agentTelemetryApi.john(params)),
        safe(agentTelemetryApi.health()),
      ])
      setSummary(s)
      setTimeline(t)
      setYana(y)
      setHamilton(h2)
      setRobert(r)
      setRobertMap(rm)
      setSam(sa)
      setAnya(an)
      setJohn(jo)
      setHealth(he)
      setLastRefreshedAt(new Date().toISOString())
    } catch (err) {
      setGlobalError(err?.message || String(err))
    } finally {
      setRefreshing(false)
      inFlight.current = false
    }
  }, [buildParams])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  useEffect(() => {
    if (!autoRefresh) return undefined
    const ms = Math.max(15_000, Number(autoRefreshMs) || DEFAULT_REFRESH_MS)
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      fetchAll()
    }, ms)
    return () => clearInterval(id)
  }, [autoRefresh, autoRefreshMs, fetchAll])

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-slate-100">
            <Bot className="h-5 w-5 text-blue-600" />
            Agent Mission Control
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Track what Anya, Sam, Robert, Yana (lead discovery), Hamilton
            (application autopilot), and John are doing across GrantFlow.
          </p>
        </div>
      </div>

      {/* Agent Control Center: start/stop/pause/resume/emergency-stop the
          whole agent process. Restricted to the canonical operator
          (buckeye7066@gmail.com); non-admin sees a friendly notice and
          telemetry below still renders. Mounted ABOVE telemetry so the
          stop controls are always reachable in one click. */}
      <AgentControlCenter />

      <AgentTelemetryFilters
        range={range}
        agent={agent}
        status={status}
        onRangeChange={setRange}
        onAgentChange={setAgent}
        onStatusChange={setStatus}
        onRefresh={fetchAll}
        refreshing={refreshing}
        lastRefreshedAt={lastRefreshedAt}
        autoRefresh={autoRefresh}
        onAutoRefreshToggle={setAutoRefresh}
      />

      {globalError ? (
        <div className="flex items-start gap-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <div>
            Telemetry refresh hit an error: <span className="font-mono">{globalError}</span>. Individual panels
            will still render their last good state.
          </div>
        </div>
      ) : null}

      <AgentOverviewCards agents={summary?.agents || {}} />

      <AgentHealthGrid health={health} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <YanaLeadFunnel data={yana} />
        <HamiltonAutopilotPanel data={hamilton} />
        <JohnDraftMetrics data={john} />
        <RobertOpportunityFunnel data={robert} />
        <RobertOpportunityMap data={robertMap} />
        <AnyaInteractionPanel data={anya} />
        <SamErrorPanel data={sam} />
      </div>

      <AgentActivityTimeline data={timeline} />
    </div>
  )
}
