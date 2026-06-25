import React, { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { GraduationCap, ExternalLink, CheckCircle2, AlertTriangle, FileWarning, CalendarClock, Bot, Award, Plus, Trash2, Printer } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/components/ui/use-toast'
import {
  getCommittedCollegeWorkspace, commitToCollege, uncommitCollege,
  setCommittedCollegeCOA, setCommittedCollegeHousing, mergeCommittedCollegeFunding,
  getFafsaStatus, setFafsaStatus,
  getFafsaVerification, setFafsaVerificationDoc,
  addCommittedCollegeAid, updateCommittedCollegeAid, removeCommittedCollegeAid,
} from '@/api/committedCollege.js'
import { Input } from '@/components/ui/input'
import CollegeFundingMergeModal from './CollegeFundingMergeModal.jsx'
import HamiltonAutomationConsent from './HamiltonAutomationConsent.jsx'
import PortalLoginButton from '@/components/portal/PortalLoginButton'
import { safeHttpUrl } from '@/lib/safeUrl'

const TERMINAL = new Set(['declined', 'denied', 'rejected', 'withdrawn', 'archived'])
const COMMITTED = new Set(['committed', 'enrolled', 'attending', 'current', 'matriculated', 'deposited'])
const fmt = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString()}`)
const errMsg = (err) => err?.message || 'Something went wrong. Please try again.'

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
  const [automateConsentOpen, setAutomateConsentOpen] = useState(false)

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
    onError: (err) => toast({ title: 'Commit failed', description: errMsg(err), variant: 'destructive' }),
  })

  const uncommit = useMutation({
    mutationFn: (collegeId) => uncommitCollege(profileId, collegeId),
    onSuccess: () => { toast({ title: 'Restored' }); invalidate() },
    onError: (err) => toast({ title: 'Restore failed', description: errMsg(err), variant: 'destructive' }),
  })

  // Housing: on/off campus + off-campus address (re-points funding crawlers).
  const [addrForm, setAddrForm] = useState({ line1: "", city: "", state: "", zip: "" })
  const [addrDirty, setAddrDirty] = useState(false)
  const housingMut = useMutation({
    mutationFn: (payload) => setCommittedCollegeHousing(profileId, payload),
    onSuccess: () => { toast({ title: "Housing updated", description: "Funding search now follows this location." }); setAddrDirty(false); invalidate() },
    onError: (err) => toast({ title: "Save failed", description: errMsg(err), variant: "destructive" }),
  })

  const [coaOpen, setCoaOpen] = useState(false)
  const [coaForm, setCoaForm] = useState({ tuition: '', housing: '', books: '', other: '', total: '' })
  const coaMut = useMutation({
    mutationFn: (payload) => setCommittedCollegeCOA(profileId, payload),
    onSuccess: () => { toast({ title: 'Cost of attendance saved' }); setCoaOpen(false); invalidate() },
    onError: (err) => toast({ title: 'Save failed', description: errMsg(err), variant: 'destructive' }),
  })

  // ── Scholarships / financial-aid pipeline ────────────────────────────────
  const emptyAid = { name: '', amount: '', status: 'awarded', source: '' }
  const [aidOpen, setAidOpen] = useState(false)
  const [aidForm, setAidForm] = useState(emptyAid)
  const [editingAidId, setEditingAidId] = useState(null)

  const resetAidForm = () => { setAidForm(emptyAid); setEditingAidId(null); setAidOpen(false) }

  const addAid = useMutation({
    mutationFn: (entry) => addCommittedCollegeAid(profileId, entry),
    onSuccess: () => { toast({ title: 'Scholarship added' }); resetAidForm(); invalidate() },
    onError: (err) => toast({ title: 'Could not add', description: errMsg(err), variant: 'destructive' }),
  })
  const editAid = useMutation({
    mutationFn: ({ id, patch }) => updateCommittedCollegeAid(profileId, id, patch),
    onSuccess: () => { toast({ title: 'Scholarship updated' }); resetAidForm(); invalidate() },
    onError: (err) => toast({ title: 'Could not update', description: errMsg(err), variant: 'destructive' }),
  })
  const deleteAid = useMutation({
    mutationFn: (id) => removeCommittedCollegeAid(profileId, id),
    onSuccess: () => { toast({ title: 'Scholarship removed' }); invalidate() },
    onError: (err) => toast({ title: 'Could not remove', description: errMsg(err), variant: 'destructive' }),
  })

  const openAddAid = () => { setAidForm(emptyAid); setEditingAidId(null); setAidOpen(true) }
  const openEditAid = (item) => {
    setAidForm({ name: item.name || '', amount: item.amount ?? '', status: item.status || 'awarded', source: item.source || '' })
    setEditingAidId(item.id ?? null)
    setAidOpen(true)
  }
  const submitAid = () => {
    let amount = null
    if (aidForm.amount !== '') {
      amount = Number(aidForm.amount)
      if (Number.isNaN(amount)) { toast({ title: 'Amount must be a number', variant: 'destructive' }); return }
    }
    const entry = {
      name: aidForm.name.trim(),
      amount,
      status: aidForm.status,
      source: aidForm.source.trim() || null,
    }
    if (!entry.name) { toast({ title: 'Name is required', variant: 'destructive' }); return }
    if (editingAidId !== null && editingAidId !== undefined) editAid.mutate({ id: editingAidId, patch: entry })
    else addAid.mutate(entry)
  }
  const aidBusy = addAid.isPending || editAid.isPending

  // One-click "Automate with Hamilton": consent → hand off ALL matched funding.
  const quickAutomate = useMutation({
    mutationFn: (items) => mergeCommittedCollegeFunding(profileId, { selectedFunding: items, authorize: true }),
    onSuccess: (res) => {
      const n = res?.plan?.automatable_ids?.length || 0
      const parts = [n > 0 ? `${n} item(s) sent to Hamilton` : 'No portal/packet items to automate yet']
      if (res?.plan?.requires_user_action) parts.push('some need your action and won’t be auto-submitted')
      toast({ title: 'Funding handed to Hamilton', description: `${parts.join('; ')}.` })
      setAutomateConsentOpen(false)
      invalidate()
    },
    onError: (err) => toast({ title: 'Automation failed', description: errMsg(err), variant: 'destructive' }),
  })
  const openCoaEditor = (coa = {}) => {
    const s = (v) => (v === null || v === undefined ? '' : String(v))
    setCoaForm({ tuition: s(coa.tuition), housing: s(coa.housing), books: s(coa.books), other: s(coa.other), total: s(coa.total) })
    setCoaOpen(true)
  }

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
      queryClient.invalidateQueries({ queryKey: ['fafsa-verification', profileId] })
      invalidate()
    },
    onError: (err) => toast({ title: 'Update failed', description: errMsg(err), variant: 'destructive' }),
  })

  const inVerification = fafsaInfo?.stage === 'verification'
  const verificationQuery = useQuery({
    queryKey: ['fafsa-verification', profileId],
    queryFn: () => getFafsaVerification(profileId),
    enabled: Boolean(profileId) && committed && inVerification,
  })
  const verification = verificationQuery.data?.verification
  const toggleDoc = useMutation({
    mutationFn: ({ key, done }) => setFafsaVerificationDoc(profileId, key, done),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fafsa-verification', profileId] })
      invalidate()
    },
    onError: (err) => toast({ title: 'Update failed', description: errMsg(err), variant: 'destructive' }),
  })

  // Seed off-campus address form from saved address when entering off-campus mode.
  const savedAddr = workspace?.committed ? (workspace.college?.student_address || {}) : {}
  const housingStatus = workspace?.committed ? (workspace.college?.housing_status || null) : null
  useEffect(() => {
    if (housingStatus === 'off_campus' && !addrDirty) {
      setAddrForm({
        line1: savedAddr.line1 || '',
        city: savedAddr.city || '',
        state: savedAddr.state || '',
        zip: savedAddr.zip || '',
      })
    }
  }, [housingStatus, savedAddr.line1, savedAddr.city, savedAddr.state, savedAddr.zip])

  const openPrintSummary = () => {
    try {
      const url = new URL('/PrintAwardSummary', window.location.origin)
      url.searchParams.set('profile_id', String(profileId))
      window.open(url.toString(), '_blank', 'noopener,noreferrer')
    } catch {
      window.open(`/PrintAwardSummary?profile_id=${encodeURIComponent(String(profileId))}`, '_blank', 'noopener,noreferrer')
    }
  }

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
  const showHamilton = Boolean(ham.total || ham.in_progress || ham.completed || ham.blocked || ham.blockers?.length)

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
                {/* One-click portal login + save-login for Hamilton. */}
                <div className="mt-2">
                  <PortalLoginButton
                    profileId={profileId}
                    url={safeHttpUrl(c.portals?.student_portal_url) || safeHttpUrl(c.website_url)}
                    label="Log in to student portal"
                    searchName={c.name}
                  />
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => uncommit.mutate(c.id)} disabled={uncommit.isPending}>
                Change
              </Button>
            </div>
          </div>

          {/* Cost of attendance + unmet need */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Cost of attendance</span>
            <Button size="sm" variant="outline" onClick={() => openCoaEditor(coa)}>
              {(coa.total === null || coa.total === undefined) && (coa.tuition === null || coa.tuition === undefined) ? 'Add COA' : 'Edit COA'}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Tuition" value={fmt(coa.tuition)} />
            <Stat label="Housing" value={fmt(coa.housing)} />
            <Stat label="Books / other" value={fmt((Number(coa.books) || 0) + (Number(coa.other) || 0) || null)} />
            <Stat label="Cost of attendance" value={fmt(coa.total)} />
            <Stat label="Aid received" value={fmt(workspace.aid?.received_total)} accent="text-emerald-700" />
            <Stat
              label="Applied (pending)"
              value={workspace.aid?.applied_total ? fmt(workspace.aid.applied_total) : '—'}
              accent="text-amber-700"
            />
            <Stat
              label="Unmet need"
              value={workspace.unmet_need === null ? '—' : fmt(workspace.unmet_need)}
              accent={workspace.unmet_need > 0 ? 'text-amber-700' : 'text-emerald-700'}
            />
          </div>

          {coaOpen ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  ['tuition', 'Tuition'],
                  ['housing', 'Housing'],
                  ['books', 'Books'],
                  ['other', 'Other'],
                  ['total', 'Total cost of attendance'],
                ].map(([key, label]) => (
                  <label key={key} className="text-xs text-slate-600">
                    {label}
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      value={coaForm[key]}
                      onChange={(e) => setCoaForm((f) => ({ ...f, [key]: e.target.value }))}
                      className="mt-1"
                      placeholder="$"
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Leave a field blank to clear it. Unmet need = total − awarded − applied − matched funding.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setCoaOpen(false)} disabled={coaMut.isPending}>Cancel</Button>
                <Button size="sm" onClick={() => coaMut.mutate(coaForm)} disabled={coaMut.isPending}>
                  {coaMut.isPending ? 'Saving…' : 'Save COA'}
                </Button>
              </div>
            </div>
          ) : null}

          {/* Housing — on/off campus + off-campus address; re-points funding crawlers */}
          {(() => {
            const housing = housingStatus
            const fl = workspace.funding_location || null
            const setStatus = (status) => {
              if (status === 'off_campus') {
                setAddrForm({
                  line1: savedAddr.line1 || '',
                  city: savedAddr.city || '',
                  state: savedAddr.state || '',
                  zip: savedAddr.zip || '',
                })
                setAddrDirty(false)
                housingMut.mutate({ housing_status: status, address: savedAddr })
              } else {
                housingMut.mutate({ housing_status: status, address: null })
              }
            }
            return (
              <div className="rounded-md border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-700">Housing</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant={housing === "on_campus" ? "default" : "outline"} onClick={() => setStatus("on_campus")} disabled={housingMut.isPending}>On-campus</Button>
                    <Button size="sm" variant={housing === "off_campus" ? "default" : "outline"} onClick={() => setStatus("off_campus")} disabled={housingMut.isPending}>Off-campus</Button>
                  </div>
                </div>
                {housing === "off_campus" ? (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-slate-500">Enter the student’s off-campus address — funding searches (housing, local benefits, community programs) will use this area.</p>
                    <Input placeholder="Street address" value={addrForm.line1} onChange={(e) => { setAddrForm((f) => ({ ...f, line1: e.target.value })); setAddrDirty(true) }} />
                    <div className="grid grid-cols-3 gap-2">
                      <Input placeholder="City" value={addrForm.city} onChange={(e) => { setAddrForm((f) => ({ ...f, city: e.target.value })); setAddrDirty(true) }} />
                      <Input placeholder="State" maxLength={2} value={addrForm.state} onChange={(e) => { setAddrForm((f) => ({ ...f, state: e.target.value })); setAddrDirty(true) }} />
                      <Input placeholder="ZIP" value={addrForm.zip} onChange={(e) => { setAddrForm((f) => ({ ...f, zip: e.target.value })); setAddrDirty(true) }} />
                    </div>
                    {addrDirty ? (
                      <div className="flex justify-end">
                        <Button size="sm" onClick={() => housingMut.mutate({ housing_status: "off_campus", address: addrForm })} disabled={housingMut.isPending}>
                          {housingMut.isPending ? "Saving…" : "Save address"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {fl ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Funding search location: <strong>{[fl.city, fl.state, fl.zip].filter(Boolean).join(", ")}</strong>
                    {fl.source === "off_campus_address" ? " (off-campus address)" : fl.source === "committed_campus" ? " (campus)" : ""}
                  </p>
                ) : null}
              </div>
            )
          })()}

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

            {/* Verification checklist — only while FAFSA is in verification */}
            {inVerification && verification?.items?.length ? (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-amber-900">Verification documents</span>
                  <span className="text-xs text-amber-800">
                    {verification.complete ? 'All gathered' : `${verification.remaining} remaining`}
                  </span>
                </div>
                <ul className="mt-2 space-y-2">
                  {verification.items.map((d) => (
                    <li key={d.key} className="flex items-start gap-2">
                      <Checkbox
                        checked={d.done}
                        onCheckedChange={(v) => toggleDoc.mutate({ key: d.key, done: Boolean(v) })}
                        disabled={toggleDoc.isPending && toggleDoc.variables?.key === d.key}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className={`text-sm ${d.done ? 'text-slate-500 line-through' : 'text-slate-800'}`}>{d.label}</div>
                        {d.help ? <div className="text-xs text-slate-500">{d.help}</div> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <Separator />

          {/* Scholarships & financial aid (manually tracked) */}
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                <Award className="h-4 w-4 text-emerald-600" /> Scholarships &amp; aid
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm" variant="ghost"
                  onClick={openPrintSummary}
                >
                  <Printer className="mr-1 h-3.5 w-3.5" /> Print summary
                </Button>
                <Button size="sm" variant="outline" onClick={openAddAid}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add scholarship
                </Button>
              </div>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Both awarded and applied-for scholarships count toward her aid total and lower unmet need; the awarded vs. applied split is shown per entry so you can see what’s secured vs. still pending.
              {workspace.aid?.applied_count
                ? ` · ${workspace.aid.applied_count} pending (${fmt(workspace.aid.applied_total)})`
                : ''}
            </div>

            {/* Add / edit form */}
            {aidOpen ? (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="text-xs text-slate-600 sm:col-span-2">
                    Scholarship / aid name
                    <Input
                      value={aidForm.name}
                      onChange={(e) => setAidForm((f) => ({ ...f, name: e.target.value }))}
                      className="mt-1"
                      placeholder="e.g. MTSU Provost Scholarship"
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    Amount
                    <Input
                      type="number" inputMode="decimal" min="0"
                      value={aidForm.amount}
                      onChange={(e) => setAidForm((f) => ({ ...f, amount: e.target.value }))}
                      className="mt-1" placeholder="$"
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    Status
                    <Select value={aidForm.status} onValueChange={(v) => setAidForm((f) => ({ ...f, status: v }))}>
                      <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="awarded">Awarded</SelectItem>
                        <SelectItem value="applied">Applied (pending)</SelectItem>
                        <SelectItem value="pending">Pending decision</SelectItem>
                        <SelectItem value="declined">Declined</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="text-xs text-slate-600 sm:col-span-2">
                    Source <span className="text-slate-400">(optional)</span>
                    <Input
                      value={aidForm.source}
                      onChange={(e) => setAidForm((f) => ({ ...f, source: e.target.value }))}
                      className="mt-1" placeholder="e.g. Institutional, State (TSAA), External / Foundation"
                    />
                  </label>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={resetAidForm} disabled={aidBusy}>Cancel</Button>
                  <Button size="sm" onClick={submitAid} disabled={aidBusy}>
                    {aidBusy ? 'Saving…' : editingAidId !== null && editingAidId !== undefined ? 'Save changes' : 'Add scholarship'}
                  </Button>
                </div>
              </div>
            ) : null}

            {/* Existing entries */}
            {workspace.aid?.pipeline?.length ? (
              <ul className="mt-3 space-y-2">
                {workspace.aid.pipeline.map((item, idx) => (
                  <li key={item.id !== null && item.id !== undefined ? item.id : `aid-${idx}`} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-slate-900">{item.name}</span>
                        <Badge
                          variant="outline"
                          className={item.secured
                            ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                            : item.status === 'declined'
                              ? 'bg-slate-100 text-slate-500 border-slate-200'
                              : 'bg-amber-100 text-amber-800 border-amber-200'}
                        >
                          {item.secured ? 'Awarded' : item.status === 'declined' ? 'Declined' : 'Applied'}
                        </Badge>
                      </div>
                      <div className="text-xs text-slate-500">
                        {fmt(item.amount)}{item.source ? ` · ${item.source}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-slate-600" onClick={() => openEditAid(item)}>Edit</Button>
                      <Button
                        size="sm" variant="ghost"
                        className="h-7 px-2 text-rose-600 hover:text-rose-700"
                        onClick={() => deleteAid.mutate(item.id)}
                        disabled={deleteAid.isPending && deleteAid.variables === item.id}
                        aria-label={`Remove ${item.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : !aidOpen ? (
              <p className="mt-3 text-sm text-slate-500">
                No scholarships logged yet. Add ones {c.name || 'this college'} has awarded, or ones the student has applied for, to track aid received vs. unmet need.
              </p>
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
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setMergeOpen(true)} disabled={(workspace.matched_funding?.count || 0) === 0}>
                Review &amp; merge
              </Button>
              <Button
                size="sm"
                onClick={() => setAutomateConsentOpen(true)}
                disabled={(workspace.matched_funding?.count || 0) === 0 || quickAutomate.isPending}
              >
                {quickAutomate.isPending ? 'Handing off…' : 'Automate with Hamilton'}
              </Button>
            </div>
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
          {showHamilton ? (
            <div className="rounded-md border border-slate-200 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-700"><Bot className="h-4 w-4 text-blue-600" />Hamilton automation</div>
              <div className="text-sm text-slate-600">
                {ham.in_progress || 0} in progress · {ham.completed || 0} completed · {ham.blocked || 0} blocked
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
                  <Button key={a.id} size="sm" variant="ghost" className="h-7 text-slate-500" onClick={() => uncommit.mutate(a.id)} disabled={uncommit.isPending && uncommit.variables === a.id}>
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

      <HamiltonAutomationConsent
        open={automateConsentOpen}
        onOpenChange={setAutomateConsentOpen}
        busy={quickAutomate.isPending}
        body={`Hamilton will prepare and drive all ${workspace.matched_funding?.count || 0} matched funding source(s) for ${c.name || 'this college'}: open each portal, fill every field from this profile, and assemble the packet.`}
        onConfirm={() => quickAutomate.mutate(workspace.matched_funding?.items || [])}
      />
    </>
  )
}
