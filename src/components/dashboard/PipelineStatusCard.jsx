import React, { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock,
  Target,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import client from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createPageUrl } from '@/utils'
import { useAuthStore } from '@/stores/authStore'
import { hasFullAdminWorkspace } from '@/lib/workspaceAccess'

const statusOrder = [
  { key: 'discovered', label: 'Discovery', icon: Target, color: 'bg-blue-500/15 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200' },
  { key: 'interested', label: 'Interested', icon: ClipboardList, color: 'bg-indigo-500/15 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200' },
  { key: 'drafting', label: 'Drafting', icon: Clock, color: 'bg-amber-500/15 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200' },
  { key: 'app_prep', label: 'Prep', icon: ClipboardList, color: 'bg-sky-500/15 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200' },
  { key: 'submission_ready', label: 'Ready to Submit', icon: ArrowRight, color: 'bg-emerald-500/15 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200' },
  { key: 'submitted', label: 'Submitted', icon: CheckCircle2, color: 'bg-green-500/15 text-green-800 dark:bg-green-500/20 dark:text-green-200' },
  { key: 'awarded', label: 'Awarded', icon: CheckCircle2, color: 'bg-lime-500/15 text-lime-800 dark:bg-lime-500/20 dark:text-lime-200' },
  { key: 'rejected', label: 'Closed', icon: AlertTriangle, color: 'bg-rose-500/15 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200' },
]

const hiddenPipelineStatuses = new Set(['rejected', 'withdrawn', 'deleted', 'archived', 'expired'])
const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function resolveCount(stats, key) {
  if (!stats) return 0
  const value = stats[key]
  if (value === undefined || value === null) return 0
  return value
}

function grantValue(grant) {
  const candidates = grant?.status === 'awarded'
    ? [grant?.amount_awarded, grant?.amount_requested, grant?.amount_max, grant?.amount_min, grant?.amount]
    : [grant?.amount_requested, grant?.amount_max, grant?.amount_min, grant?.amount, grant?.amount_awarded]
  for (const raw of candidates) {
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

export default function PipelineStatusCard({ stats = {}, isLoading, hasError = false }) {
  const user = useAuthStore((state) => state.user)
  const isAdmin = hasFullAdminWorkspace(user)
  const grantsQuery = useQuery({
    queryKey: ['grants'],
    queryFn: async () => {
      const response = await client.entities.Grant.list('-created_date')
      return Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : []
    },
    enabled: !isAdmin,
    staleTime: 60_000,
  })

  const endUserSummary = useMemo(() => {
    if (isAdmin) return null
    const rows = Array.isArray(grantsQuery.data) ? grantsQuery.data : []
    const active = rows.filter(
      (grant) => grant?.id && !hiddenPipelineStatuses.has(String(grant.status || '').toLowerCase()),
    )
    return {
      count: active.length,
      amount: active.reduce((sum, grant) => sum + grantValue(grant), 0),
    }
  }, [grantsQuery.data, isAdmin])

  const total = statusOrder.reduce((sum, status) => sum + resolveCount(stats, status.key), 0)

  return (
    <Card className="h-full border border-border/70 bg-card/80 text-card-foreground shadow-none backdrop-blur-lg">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-lg font-semibold text-card-foreground">Pipeline Focus</CardTitle>
            <p className="mt-1 text-sm text-foreground">
              {hasError
                ? 'Unable to sync pipeline metrics. Showing default workflow guidance.'
                : isLoading
                  ? 'Syncing latest data…'
                  : `Tracking ${total} pipeline grants across stages.`}
            </p>
          </div>
          <Link to={createPageUrl('Pipeline')}>
            <Button size="sm" variant="secondary" className="gap-2">
              Open Pipeline
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {!isAdmin ? (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
            <div className="rounded-lg bg-background/85 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-foreground">Funding sources in pipeline</p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                {grantsQuery.isLoading ? '…' : endUserSummary?.count ?? 0}
              </p>
            </div>
            <div className="rounded-lg bg-background/85 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-foreground">Potential dollar amount</p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                {grantsQuery.isLoading ? '…' : currency.format(endUserSummary?.amount ?? 0)}
              </p>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          {statusOrder.map((status) => {
            const count = resolveCount(stats, status.key)
            return (
              <div
                key={status.key}
                className="flex items-center gap-3 rounded-xl border border-border bg-background/60 p-3 shadow-sm"
              >
                <span className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold ${status.color}`}>
                  <status.icon className="h-5 w-5" />
                </span>
                <div className="flex flex-col">
                  <span className="text-xs uppercase tracking-wide text-foreground">{status.label}</span>
                  <span className="text-lg font-semibold text-card-foreground">{isLoading ? '…' : count}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4">
          <h3 className="mb-2 text-sm font-semibold text-card-foreground">Next recommended actions</h3>
          <ul className="space-y-2 text-sm text-foreground">
            <li>• Review drafts due this week and assign final reviewers.</li>
            <li>• Nudge partners on outstanding documents for compliance checks.</li>
            <li>• Identify upcoming submissions to prep budgets and attachments.</li>
          </ul>
          <div className="mt-4 flex gap-3">
            <Button asChild size="sm">
              <Link to={createPageUrl('Pipeline')}>Manage Workflow</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={createPageUrl(isAdmin ? 'GrantDeadline' : 'Calendar')}>
                {isAdmin ? 'Schedule deadlines' : 'View calendar'}
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
