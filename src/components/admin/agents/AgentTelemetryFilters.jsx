import React from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RefreshCw } from 'lucide-react'

const RANGE_OPTIONS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]

const AGENT_OPTIONS = [
  { value: 'all', label: 'All agents' },
  { value: 'anya', label: 'Anya' },
  { value: 'sam', label: 'Sam' },
  { value: 'robert', label: 'Robert' },
  { value: 'yana', label: 'Yana' },
  { value: 'john', label: 'John' },
]

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'warning', label: 'Warning' },
]

export default function AgentTelemetryFilters({
  range,
  agent,
  status,
  onRangeChange,
  onAgentChange,
  onStatusChange,
  onRefresh,
  refreshing,
  lastRefreshedAt,
  autoRefresh,
  onAutoRefreshToggle,
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Range</span>
        <Select value={range || '24h'} onValueChange={onRangeChange}>
          <SelectTrigger className="h-8 w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Agent</span>
        <Select value={agent || 'all'} onValueChange={onAgentChange}>
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Status</span>
        <Select value={status || 'all'} onValueChange={onStatusChange}>
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {lastRefreshedAt ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Last refreshed {new Date(lastRefreshedAt).toLocaleTimeString()}
          </span>
        ) : null}
        <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={Boolean(autoRefresh)}
            onChange={(e) => onAutoRefreshToggle?.(e.target.checked)}
          />
          Auto-refresh
        </label>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
    </div>
  )
}
