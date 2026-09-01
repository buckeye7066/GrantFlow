import React, { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  CalendarClock,
  CircleDollarSign,
  ExternalLink,
  FileCheck2,
  Loader2,
  LockKeyhole,
  Sparkles,
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'

import client from '@/api/client'
import HamiltonAutopilotAuthorization from '@/components/hamilton/HamiltonAutopilotAuthorization'
import HamiltonAutomationQueue from '@/components/hamilton/HamiltonAutomationQueue'
import HamiltonHardStopChecklist from '@/components/hamilton/HamiltonHardStopChecklist'
import PortalLoginButton from '@/components/portal/PortalLoginButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { parseLocalDate } from '@/components/shared/dateUtils'
import { useAuthStore } from '@/stores/authStore'
import { computeClientPipelineDollar } from '@/utils/pipelineDollarClient'

const HIDDEN_GRANT_STATUSES = new Set(['rejected', 'withdrawn', 'deleted', 'archived', 'expired'])
const TERMINAL_TASK_STATUSES = new Set(['submitted', 'draft_completed', 'completed', 'cancelled', 'failed'])

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function grantValue(grant) {
  return computeClientPipelineDollar(grant)
}

function grantUrl(grant) {
  const rawUrl = grant?.application_url || grant?.url || grant?.source_url || null
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

function grantSponsor(grant) {
  return grant?.funder || grant?.sponsor || grant?.funder_name || 'Funding source'
}

function methodLabel(grant) {
  const method = String(grant?.application_method || '').trim()
  if (method) return method
  const url = grantUrl(grant)
  if (!url) return 'Packet or direct submission'
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'Online application'
  }
}

function formatPipelineDeadline(grant) {
  if (!grant?.deadline) return 'No fixed deadline'
  if (String(grant.deadline).toLowerCase() === 'rolling') return 'Rolling deadline'
  const parsed = parseLocalDate(grant.deadline)
  return parsed ? parsed.toLocaleDateString() : String(grant.deadline)
}

function statusLabel(status) {
  return String(status || 'preparing').replace(/_/g, ' ')
}

export default function EndUserPipeline() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [authorizationOpen, setAuthorizationOpen] = useState(false)
  const [selectedGrantId, setSelectedGrantId] = useState(null)

  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const profiles = useAuthStore((state) => state.profiles)
  const profileId = activeProfileId && activeProfileId !== '__admin__'
    ? activeProfileId
    : profiles?.[0]?.id ?? null

  const requestedGrantId = useMemo(
    () => new URLSearchParams(location.search).get('grant_id'),
    [location.search],
  )

  const grantsQuery = useQuery({
    queryKey: ['grants', 'end-user-pipeline', profileId],
    enabled: Boolean(profileId),
    queryFn: () => client.entities.Grant.list('-created_date', 2000, { profile_id: profileId }),
    staleTime: 20_000,
  })

  const tasksQuery = useQuery({
    queryKey: ['hamilton', 'tasks', profileId],
    enabled: Boolean(profileId),
    queryFn: async () => {
      const params = new URLSearchParams({ profile_id: String(profileId) })
      const response = await client.get(`/api/hamilton/automation/tasks?${params.toString()}`)
      return Array.isArray(response?.tasks) ? response.tasks : []
    },
    refetchInterval: 15_000,
    staleTime: 5_000,
  })

  const grants = useMemo(() => {
    const rows = Array.isArray(grantsQuery.data) ? grantsQuery.data : []
    return rows
      .filter((grant) => {
        if (!grant?.id) return false
        if (String(grant.profile_id || '') !== String(profileId || '')) return false
        return !HIDDEN_GRANT_STATUSES.has(String(grant.status || '').toLowerCase())
      })
      .sort((a, b) => {
        const aTerminal = ['submitted', 'awarded'].includes(String(a.status || '').toLowerCase()) ? 1 : 0
        const bTerminal = ['submitted', 'awarded'].includes(String(b.status || '').toLowerCase()) ? 1 : 0
        if (aTerminal !== bTerminal) return aTerminal - bTerminal
        const aDeadline = Date.parse(a.deadline || '') || Number.MAX_SAFE_INTEGER
        const bDeadline = Date.parse(b.deadline || '') || Number.MAX_SAFE_INTEGER
        return aDeadline - bDeadline
      })
  }, [grantsQuery.data, profileId])

  const activeTask = useMemo(
    () => (Array.isArray(tasksQuery.data) ? tasksQuery.data : []).find(
      (task) => !TERMINAL_TASK_STATUSES.has(String(task?.status || '').toLowerCase()),
    ) || null,
    [tasksQuery.data],
  )

  const workingGrantId = useMemo(() => {
    if (!activeTask) return null
    const byGrant = activeTask.grant_id
      ? grants.find((grant) => String(grant.id) === String(activeTask.grant_id))
      : null
    if (byGrant) return String(byGrant.id)
    const opportunityId = activeTask.opportunity_id || activeTask.funding_source_id
    const byOpportunity = opportunityId
      ? grants.find((grant) => String(grant.funding_opportunity_id || grant.opportunity_id || '') === String(opportunityId))
      : null
    return byOpportunity ? String(byOpportunity.id) : null
  }, [activeTask, grants])

  useEffect(() => {
    if (grants.length === 0) {
      setSelectedGrantId(null)
      return
    }
    const candidate =
      (workingGrantId && grants.some((grant) => String(grant.id) === workingGrantId) && workingGrantId) ||
      (requestedGrantId && grants.some((grant) => String(grant.id) === String(requestedGrantId)) && String(requestedGrantId)) ||
      (selectedGrantId && grants.some((grant) => String(grant.id) === String(selectedGrantId)) && String(selectedGrantId)) ||
      String(grants[0].id)
    if (candidate !== selectedGrantId) setSelectedGrantId(candidate)
  }, [grants, requestedGrantId, selectedGrantId, workingGrantId])

  const selectedGrant = grants.find((grant) => String(grant.id) === String(selectedGrantId)) || null
  const selectedUrl = grantUrl(selectedGrant)
  const potentialTotal = grants.reduce((sum, grant) => sum + computeClientPipelineDollar(grant), 0)

  const selectedSources = selectedGrant
    ? [{
        grant_id: selectedGrant.id,
        opportunity_id: selectedGrant.funding_opportunity_id || selectedGrant.opportunity_id || null,
        title: selectedGrant.title,
        current_stage: selectedGrant.status,
      }]
    : []

  function chooseGrant(grantId) {
    if (workingGrantId && String(grantId) !== workingGrantId) return
    setSelectedGrantId(String(grantId))
    const params = new URLSearchParams(location.search)
    params.set('grant_id', String(grantId))
    navigate(`/Pipeline?${params.toString()}`, { replace: true })
  }

  const taskStatusUnknown = tasksQuery.isLoading || tasksQuery.isError
  const launchBlocked = Boolean(activeTask) || taskStatusUnknown

  if (!profileId) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="max-w-lg">
          <CardContent className="p-8 text-center">
            <Sparkles className="mx-auto h-8 w-8 text-primary" />
            <h1 className="mt-4 text-xl font-semibold">Anya is finishing your funding profile</h1>
            <p className="mt-2 text-sm text-muted-foreground">Once your profile is ready, accepted funding sources will appear here automatically.</p>
            <Button type="button" className="mt-5" onClick={() => navigate('/Help')}>Ask Anya what is needed</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (grantsQuery.isLoading) {
    return (
      <div role="status" aria-live="polite" className="flex min-h-[60vh] items-center justify-center gap-3 px-4 text-sm text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        Loading your funding pipeline…
      </div>
    )
  }

  return (
    <section className="px-4 pb-12 pt-6 md:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
              <CircleDollarSign className="h-3.5 w-3.5" />
              One source at a time
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Your funding pipeline</h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground md:text-base">
              Choose one funding source. Hamilton prepares supported fields and documents until the packet is ready or a hard stop needs you.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:min-w-[360px]">
            <SummaryTile label="Funding sources" value={String(grants.length)} />
            <SummaryTile label="Potential funding" value={currency.format(potentialTotal)} />
          </div>
        </div>

        {grantsQuery.isError ? (
          <Card role="alert" className="border-red-300 dark:border-red-800">
            <CardContent className="p-8 text-center">
              <h2 className="text-xl font-semibold text-foreground">Your pipeline could not be loaded</h2>
              <p className="mt-2 text-sm text-muted-foreground">Check your connection, then retry. No source is being treated as missing or complete.</p>
              <Button type="button" variant="outline" className="mt-5" onClick={() => grantsQuery.refetch()}>Try again</Button>
            </CardContent>
          </Card>
        ) : grants.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center">
              <FileCheck2 className="mx-auto h-9 w-9 text-muted-foreground" />
              <h2 className="mt-4 text-xl font-semibold text-foreground">No accepted funding sources yet</h2>
              <p className="mt-2 text-sm text-muted-foreground">GrantFlow will place accepted matches here and prepare them for Hamilton.</p>
              <Button type="button" variant="outline" className="mt-5" onClick={() => navigate('/Help')}>Ask Anya about your next match</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
            <div className="min-w-0 space-y-5">
              {activeTask ? (
                <Card className="border-emerald-300 bg-emerald-50/60">
                  <CardContent className="flex items-start gap-3 p-4 text-sm text-emerald-900">
                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                    <div>
                      <p className="font-semibold">Hamilton is already working on one funding source.</p>
                      <p className="mt-1">Open the live task below to watch preparation, provide missing information, review the human portal handoff, or cancel before starting another source.</p>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              {tasksQuery.isError ? (
                <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                  <p className="font-semibold">Hamilton's live task status is unavailable.</p>
                  <p className="mt-1">Do not start another task until the status reloads.</p>
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => tasksQuery.refetch()}>Reload task status</Button>
                </div>
              ) : null}

              {selectedGrant ? (
                <Card className="min-w-0 overflow-hidden border-primary/20">
                  <CardHeader className="border-b border-border bg-muted/30">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <Badge variant="outline" className="mb-2 capitalize">{statusLabel(selectedGrant.status)}</Badge>
                        <CardTitle className="break-words text-2xl leading-tight">{selectedGrant.title || 'Funding source'}</CardTitle>
                        <p className="mt-2 text-sm text-muted-foreground">{grantSponsor(selectedGrant)}</p>
                      </div>
                      <div className="w-full rounded-xl border border-border bg-background px-4 py-3 text-left sm:w-auto sm:text-right">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Potential amount</p>
                        <p className="mt-1 text-xl font-bold text-foreground">
                          {computeClientPipelineDollar(selectedGrant) ? currency.format(computeClientPipelineDollar(selectedGrant)) : 'No fixed award amount'}
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="min-w-0 space-y-5 p-4 sm:p-5 md:p-6">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Detail label="Deadline" value={formatPipelineDeadline(selectedGrant)} icon={CalendarClock} />
                      <Detail label="Application method" value={methodLabel(selectedGrant)} icon={ExternalLink} />
                      <Detail label="Hamilton mode" value={activeTask ? 'Working now' : 'Ready when you are'} icon={Sparkles} />
                    </div>

                    <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-foreground">
                      <p className="font-semibold">What happens next</p>
                      <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
                        <li>Hamilton checks the stored requirements, profile facts, documents, portal, and deadlines.</li>
                        <li>He prepares the fields and documents supported by the available source information.</li>
                        <li>He pauses for missing information, login, CAPTCHA, 2FA, payment, signature, owner approval, or a personal attestation. GrantFlow cannot bypass those steps.</li>
                        <li>In the controlled beta, Hamilton preserves the finished work and shows the manual handoff. You complete the final external submission and retain its confirmation.</li>
                      </ol>
                    </div>

                    {selectedUrl ? (
                      <div className="flex min-w-0 flex-col items-stretch gap-3 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-800 dark:bg-indigo-950/40 sm:flex-row sm:flex-wrap sm:items-center">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-indigo-950 dark:text-indigo-100">Application portal</p>
                          <p className="break-all text-xs text-indigo-800 dark:text-indigo-200 sm:truncate">{selectedUrl}</p>
                        </div>
                        <PortalLoginButton profileId={profileId} url={selectedUrl} className="w-full min-w-0 flex-col items-stretch dark:[&_a]:text-indigo-200 sm:w-auto sm:flex-row sm:items-center" />
                        <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                          <a href={selectedUrl} target="_blank" rel="noopener noreferrer">
                            Open portal <ExternalLink className="ml-2 h-3.5 w-3.5" />
                          </a>
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                        No verified online portal is stored. Hamilton can prepare a packet and handoff instructions only when the official source provides a supported submission method.
                      </div>
                    )}

                    <HamiltonHardStopChecklist profileId={profileId} />

                    <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs text-muted-foreground">
                        You can watch preparation, edit missing information, review the final portal handoff, or cancel from the live task drawer.
                      </p>
                      <Button
                        size="lg"
                        className="h-auto min-h-11 w-full gap-2 whitespace-normal py-3 text-center sm:w-auto"
                        disabled={launchBlocked}
                        onClick={() => setAuthorizationOpen(true)}
                      >
                        {launchBlocked ? <LockKeyhole className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                        {activeTask
                          ? 'Finish current Hamilton task first'
                          : taskStatusUnknown
                            ? 'Waiting for Hamilton task status'
                            : 'Prepare this source with Hamilton'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              <HamiltonAutomationQueue profileId={profileId} />
            </div>

            <Card className="h-fit min-w-0">
              <CardHeader>
                <CardTitle className="text-lg">Funding sources</CardTitle>
                <p className="text-sm text-muted-foreground">Only one source opens for work at a time.</p>
              </CardHeader>
              <CardContent className="space-y-2" role="group" aria-label="Choose a funding source">
                {grants.map((grant) => {
                  const selected = String(grant.id) === String(selectedGrantId)
                  const locked = Boolean(workingGrantId) && String(grant.id) !== workingGrantId
                  return (
                    <button
                      key={grant.id}
                      type="button"
                      disabled={locked}
                      onClick={() => chooseGrant(grant.id)}
                      aria-pressed={selected}
                      aria-label={`${grant.title || 'Funding source'}, ${statusLabel(grant.status)}, ${formatPipelineDeadline(grant)}${locked ? ', unavailable while Hamilton works on another source' : ''}`}
                      className={`w-full rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                        selected
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-border bg-background hover:border-primary/30 hover:bg-muted/40'
                      } ${locked ? 'cursor-not-allowed opacity-55' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{grant.title || 'Funding source'}</p>
                          <p className="mt-1 truncate text-xs text-muted-foreground">{grantSponsor(grant)}</p>
                        </div>
                        <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="capitalize">{statusLabel(grant.status)}</span>
                        <span>·</span>
                        <span>{formatPipelineDeadline(grant)}</span>
                        {computeClientPipelineDollar(grant) ? <><span>·</span><span>{currency.format(computeClientPipelineDollar(grant))}</span></> : null}
                      </div>
                    </button>
                  )
                })}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <HamiltonAutopilotAuthorization
        open={authorizationOpen}
        onOpenChange={setAuthorizationOpen}
        profileId={profileId}
        selectedSources={selectedSources}
        onLaunched={() => {
          queryClient.invalidateQueries({ queryKey: ['hamilton', 'tasks'] })
          queryClient.invalidateQueries({ queryKey: ['grants'] })
        }}
      />
    </section>
  )
}

function SummaryTile({ label, value }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold text-foreground">{value}</p>
    </div>
  )
}

function Detail({ label, value, icon: Icon }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </div>
      <p className="mt-2 text-sm font-semibold text-foreground">{value}</p>
    </div>
  )
}
