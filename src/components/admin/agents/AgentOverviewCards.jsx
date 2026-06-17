import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Bot, ShieldCheck, Search, Users, Mail, Workflow } from 'lucide-react'

const AGENT_ICONS = {
  anya: Bot,
  sam: ShieldCheck,
  robert: Search,
  yana: Users,
  hamilton: Workflow,
  john: Mail,
}

const AGENT_ORDER = ['anya', 'sam', 'robert', 'yana', 'hamilton', 'john']

const HEALTH_STYLES = {
  healthy: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200',
  warning: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-200',
  error: 'bg-red-100 text-red-900 border-red-200 dark:bg-red-900/40 dark:text-red-200',
  idle: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300',
  not_installed: 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900 dark:text-slate-500',
}

function formatTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function PrimaryMetrics({ agent }) {
  const m = agent.primary_metrics || {}
  switch (agent.agent_name) {
    case 'anya':
      return (
        <MetricRow
          items={[
            ['Interactions', m.interactions ?? 0],
            ['Sessions', m.active_sessions ?? 0],
            ['Tools', m.tool_invocations ?? 0],
            ['Users', m.unique_users ?? 0],
          ]}
        />
      )
    case 'sam':
      return (
        <MetricRow
          items={[
            ['Checks', m.checks_run ?? 0],
            ['Errors', m.errors_found ?? 0],
            ['Resolved', m.errors_resolved ?? 0],
            ['Failed gates', m.failed_gates ?? 0],
          ]}
        />
      )
    case 'robert':
      return (
        <MetricRow
          items={[
            ['Sources', m.sources_checked ?? 0],
            ['Found', m.opportunities_found ?? 0],
            ['Verified', m.opportunities_verified ?? 0],
            ['Ingested', m.opportunities_ingested ?? 0],
          ]}
        />
      )
    case 'yana':
      return (
        <MetricRow
          items={[
            ['Pages', m.websites_checked ?? 0],
            ['Leads', m.leads_found ?? 0],
            ['Qualified', m.leads_qualified ?? 0],
            ['→ John', m.leads_sent_to_john ?? 0],
          ]}
        />
      )
    case 'hamilton':
      return (
        <MetricRow
          items={[
            ['Submissions', m.submissions_completed ?? 0],
            ['Drafts', m.drafts_completed ?? 0],
            ['Open blockers', m.open_blockers ?? 0],
            ['Admin blockers', m.open_blockers_admin ?? 0],
          ]}
        />
      )
    case 'john':
      return (
        <MetricRow
          items={[
            ['Drafts 24h', m.drafts_created_24h ?? 0],
            ['Cap remaining', m.daily_capacity_remaining ?? 0],
            ['Blocked', m.drafts_blocked ?? 0],
            ['Alias review', m.drafts_needing_alias_review ?? 0],
          ]}
        />
      )
    default:
      return null
  }
}

function MetricRow({ items }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between">
          <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
          <dd className="font-mono font-semibold text-slate-900 dark:text-slate-100">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function AgentOverviewCards({ agents }) {
  const ordered = AGENT_ORDER.map((name) => agents?.[name]).filter(Boolean)

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {ordered.map((agent) => {
        const Icon = AGENT_ICONS[agent.agent_name] || Bot
        const healthCls = HEALTH_STYLES[agent.health] || HEALTH_STYLES.idle
        const successRate =
          agent.success_rate === null || agent.success_rate === undefined
            ? null
            : Math.round(agent.success_rate * 100)
        return (
          <Card key={agent.agent_name} className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-slate-500" />
                <CardTitle className="text-sm font-semibold">
                  {agent.label}
                  <span className="ml-2 text-xs font-normal text-slate-500">{agent.tagline}</span>
                </CardTitle>
              </div>
              <Badge variant="outline" className={`text-[10px] uppercase ${healthCls}`}>
                {agent.health}
              </Badge>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span>
                  {agent.installed ? (agent.enabled ? 'enabled' : 'disabled') : 'not installed'}
                </span>
                {successRate !== null ? <span>· {successRate}% success</span> : null}
                {agent.error_count ? <span className="text-red-600">· {agent.error_count} errors</span> : null}
              </div>
              <PrimaryMetrics agent={agent} />
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                <div className="flex items-center justify-between">
                  <dt>Last run</dt>
                  <dd className="font-mono text-slate-700 dark:text-slate-300">{formatTime(agent.last_run_at)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt>Last success</dt>
                  <dd className="font-mono text-slate-700 dark:text-slate-300">{formatTime(agent.last_success_at)}</dd>
                </div>
              </dl>
              {Array.isArray(agent.notes) && agent.notes.length ? (
                <p className="mt-2 text-[11px] italic text-slate-500 dark:text-slate-400">{agent.notes[0]}</p>
              ) : null}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
