import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { GraduationCap, ExternalLink, CheckCircle2, AlertTriangle, FileWarning, CalendarClock, Bot } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import {
  getCommittedCollegeWorkspace, commitToCollege, uncommitCollege,
  getFafsaStatus, setFafsaStatus,
} from '@/api/committedCollege.js'
import CollegeFundingMergeModal from './CollegeFundingMergeModal.jsx'

const TERMINAL = new Set(['declined', 'denied', 'rejected', 'withdrawn', 'archived'])
const COMMITTED = new Set(['committed', 'enrolled', 'attending', 'current', 'matriculated', 'deposited'])
const fmt = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString()}`)

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${accent || 'text-slate-900'}`}>{value}</div>
    </div>
  )
}

/**
 * Committed-college financial-aid workspace.
 * @param {string} profileId
 * @param {Array} applications  university_applications.applications (for the picker)
 */
export default function CommittedCollegeWorkspace({ profileId, applications = [] }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [mergeOpen, setMergeOpen] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['committed-college-workspace', profileId],
    queryFn: () => getCommittedCollegeWorkspace(profileId),
    enabled: Boolean(profileId),
  })
  const workspace = data?.workspace

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['committed-college-workspace', profileId] })
    queryClient.invalidateQueries({ queryKey: ['profile', profileId] })
  }

  const commit = useMutation({
    mutationFn: (collegeId) => commitToCollege(profileId, collegeId),
    onSuccess: (res) => {
      toast({ title: 'Committed', description: `${res?.archived?.length || 0} other college(s) archived.` })
      invalidate()
    },
    onError: (err) => toast({ title: 'Commit failed', description: err?.message, variant: 'destructive' }),
  })

  const uncommit = useMutation({
    mutationFn: (collegeId) => uncommitCollege(profileId, collegeId),
    onSuccess: () => { toast({ title: 'Restored' }); invalidate() },
    onError: (err) => toast({ title: 'Restore failed', description: err?.message, variant: 'destructive' }),
  })

  const committed = Boolean(workspace?.committed)
  const fafsaQuery = useQuery({
    queryKey: ['fafsa-status', profileId],
    queryFn: () => getFafsaStatus(profileId),
    enabled: Boolean(profileId) && committed,
  })
  const fafsaInfo = fafsaQuery.data?.fafsa
  const setStage = useMutation({
    mutationFn: (stage) => setFafsaStatus(profileId, stage),
    onSuccess: () => {
      toast({ title: 'FAFSA status updated' })
      queryClient.invalidateQueries({ queryKey: ['fafsa-status', profileId] })
      invalidate()
    },
    onError: (err) => toast({ title: 'Update failed', description: err?.message, variant: 'destructive' }),
  })

  const cardShell = (children) => (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GraduationCap className="h-5 w-5 text-emerald-600" /> Committed college &amp; financial aid
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )

  if (isLoading) return cardShell(<p className="text-sm text-slate-500">Loading workspace…</p>)
  if (isError || !workspace) return cardShell(<p className="text-sm text-slate-500">Workspace unavailable.</p>)

  // ── Not committed yet → show the picker ──────────────────────────────────
  if (!workspace.committed) {
    const candidates = (applications || []).filter(
      (a) => !COMMITTED.has(String(a?.status || '').toLowerCase()) && !TERMINAL.has(String(a?.status || '').toLowerCase()),
    )
    return cardShell(
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Pick the college you’re committing to. The others move to archived so this workspace can focus on your school.
        </p>
        {candidates.length === 0 ? (
          <Alert><AlertDescription>Add a college in University Applications first.</AlertDescription></Alert>
        ) : candidates.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3">
            <div className="min-w-0">
              <div className="font-medium text-slate-900 truncate">{a.name || 'Unnamed college'}</div>
              <div className="text-xs text-slate-500">{[a.city, a.state].filter(Boolean).join(', ') || (a.status || 'planning')}</div>
            </div>
            <Button size="sm" onClick={() => commit.mutate(a.id)} disabled={commit.isPending}>
              {commit.isPending && commit.variables === a.id ? 'Committing…' : 'Set as committed'}
            </Button>
          </div>
        ))}
      </div>,
    )
  }

  // ── Committed → full workspace ───────────────────────────────────────────
  const c = workspace.college
  const coa = workspace.cost_of_attendance || {}
  const fafsa = workspace.fafsa || {}
  const ham = workspace.hamilton || {}

  return (
    <>
      {cardShell(
        <div className="space-y-5">
          {/* Header */}
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-emerald-900 truncate">{c.name || 'Committed college'}</span>
                  <Badge variant="outline" className="bg-emerald-200 text-emerald-900 border-emerald-300 font-bold">Committed</Badge>
                </div>
                <div className="mt-0.5 text-sm text-emerald-800">{[c.city, c.state].filter(Boolean).join(', ')}</div>
                {c.website_url ? (
                  <a href={c.website_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-emerald-700 hover:underline">
                    Financial aid site <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </div>
              <Button size="sm" variant="outline" onClick={() => uncommit.mutate(c.id)} disabled={uncommit.isPending}>
                Change
              </Button>
            </div>
          </div>

          {/* Cost of attendance + unmet need */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Tuition" value={fmt(coa.tuition)} />
            <Stat label="Housing" value={fmt(coa.housing)} />
            <Stat label="Books / other" value={fmt((coa.books || 0) + (coa.other || 0) || null)} />
            <Stat label="Cost of attendance" value={fmt(coa.total)} />
            <Stat label="Aid received" value={fmt(workspace.aid?.received_total)} accent="text-emerald-700" />
            <Stat
              label="Unmet need"
              value={workspace.unmet_need === null ? 'Add COA' : fmt(workspace.unmet_need)}
              accent={workspace.unmet_need ? 'text-amber-700' : 'text-emerald-700'}
            />
          </div>

          {/* FAFSA lifecycle */}
          <div className="rounded-md border border-slate-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-700">FAFSA:</span>
              <Badge
                variant="outline"
                className={fafsa.completed
                  ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                  : 'bg-amber-100 text-amber-800 border-amber-200'}
              >
                {fafsa.completed ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <AlertTriangle className="mr-1 h-3.5 w-3.5" />}
                {fafsa.stage_label || (fafsa.completed ? 'Filed' : 'Not started')}
              </Badge>
              {fafsa.pell_grant_eligible ? <Badge variant="outline">Pell-eligible</Badge> : null}
              {fafsa.first_generation ? <Badge variant="outline">First-gen</Badge> : null}
              {fafsa.efc_sai_band ? <Badge variant="outline">SAI {fafsa.efc_sai_band}</Badge> : null}
            </div>
            {(fafsa.next_action || fafsaInfo?.next_action) ? (
              <p className="mt-2 text-sm text-slate-600">Next: {fafsaInfo?.next_action || fafsa.next_action}</p>
            ) : null}
            {fafsaInfo?.stages?.length ? (
              <div className="mt-2 max-w-xs">
                <Select value={fafsaInfo.stage} onValueChange={(v) => setStage.mutate(v)} disabled={setStage.isPending}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Update FAFSA stage" /></SelectTrigger>
                  <SelectContent>
                    {fafsaInfo.stages.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <Separator />

          {/* Matched funding + merge */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-900">GrantFlow-matched funding</div>
              <div className="text-sm text-slate-500">
                {workspace.matched_funding?.count || 0} source(s) · {fmt(workspace.matched_funding?.total)}
              </div>
            </div>
            <Button size="sm" onClick={() => setMergeOpen(true)} disabled={(workspace.matched_funding?.count || 0) === 0}>
              Merge with Hamilton
            </Button>
          </div>

          {/* Missing documents */}
          {workspace.missing_documents?.length ? (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-700"><FileWarning className="h-4 w-4 text-amber-600" />Missing documents</div>
              <ul className="space-y-1 text-sm text-slate-600">
                {workspace.missing_documents.map((d, i) => <li key={d.key || i}>• {d.label || d.key}</li>)}
              </ul>
            </div>
          ) : null}

          {/* Deadlines */}
          {workspace.deadlines?.length ? (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-700"><CalendarClock className="h-4 w-4 text-slate-500" />Deadlines</div>
              <ul className="space-y-1 text-sm text-slate-600">
                {workspace.deadlines.map((d, i) => <li key={d.key || i}>• {d.label || d.key}{d.date ? ` — ${d.date}` : ''}</li>)}
              </ul>
            </div>
          ) : null}

          {/* Hamilton status */}
          {ham.total ? (
            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-700"><Bot className="h-4 w-4 text-blue-600" />Hamilton automation</div>
              <div className="text-sm text-slate-600">
                {ham.in_progress} in progress · {ham.completed} completed · {ham.blocked} blocked
              </div>
              {ham.blockers?.length ? (
                <ul className="mt-1 space-y-0.5 text-xs text-amber-700">
                  {ham.blockers.map((b) => <li key={b.task_id}>• Blocked: {b.blocker_type || b.status}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* Archived colleges */}
          {workspace.archived_colleges?.length ? (
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-slate-400">Archived</div>
              <div className="flex flex-wrap gap-2">
                {workspace.archived_colleges.map((a) => (
                  <Button key={a.id} size="sm" variant="ghost" className="h-7 text-slate-500" onClick={() => uncommit.mutate(a.id)} disabled={uncommit.isPending}>
                    {a.name || 'College'} · restore
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>,
      )}

      <CollegeFundingMergeModal
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        profileId={profileId}
        matchedFunding={workspace.matched_funding?.items || []}
      />
    </>
  )
}
