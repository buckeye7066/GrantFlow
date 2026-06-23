import React, { useState, useEffect, useMemo } from 'react'
import { apiFetch } from '@/api/client'
import { listProfiles } from '@/api/profiles'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, Radar, CheckCircle2, AlertTriangle, XCircle, Sparkles, RefreshCw, ScanSearch } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

// Admin panel: shows EXACTLY which discovery crawlers/sources fire for a chosen
// profile and WHY (type + derived applicant types + needs + location +
// keyword/phrase triggers), plus a one-click coverage scan across all active
// profiles that flags any zero-coverage or org-directory-only profile — so a
// VFD can never silently miss a FEMA grant. Read-only; mirrors the
// crawlers.planForProfile Anya tool and the deterministic planner.
export default function AdminCrawlerPlan() {
  const { toast } = useToast()
  const [profiles, setProfiles] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [plan, setPlan] = useState(null)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [audit, setAudit] = useState(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    listProfiles({ limit: 500 })
      .then((res) => {
        const list = Array.isArray(res) ? res : (res?.profiles || res?.items || res?.data || [])
        setProfiles(list)
      })
      .catch(() => setProfiles([]))
  }, [])

  const fetchPlan = async (profileId) => {
    if (!profileId) return
    setLoadingPlan(true)
    setPlan(null)
    try {
      const res = await apiFetch(`/api/admin/crawler-plan/${profileId}`)
      setPlan(res)
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not load plan', description: err?.message })
    } finally {
      setLoadingPlan(false)
    }
  }

  const runScan = async () => {
    setScanning(true)
    try {
      const res = await apiFetch('/api/admin/crawler-plan?limit=500')
      setAudit(res)
      const gaps = (res?.zero_coverage?.length || 0) + (res?.org_directory_only?.length || 0)
      toast({
        title: `Scanned ${res?.scanned || 0} profiles`,
        description: gaps === 0
          ? 'No coverage gaps — every profile reaches at least one relatable source.'
          : `${gaps} profile(s) flagged: ${res?.zero_coverage?.length || 0} zero-coverage, ${res?.org_directory_only?.length || 0} org directory-only.`,
        variant: gaps === 0 ? 'default' : 'destructive',
      })
    } catch (err) {
      toast({ variant: 'destructive', title: 'Scan failed', description: err?.message })
    } finally {
      setScanning(false)
    }
  }

  const coverage = plan?.coverage
  const coverageBadge = useMemo(() => {
    if (!coverage) return null
    if (coverage.zero) return { label: 'ZERO sources', cls: 'bg-red-100 text-red-800', Icon: XCircle }
    if (coverage.directory_only && plan?.is_org) return { label: 'Directory-only (org gap)', cls: 'bg-amber-100 text-amber-800', Icon: AlertTriangle }
    if (coverage.directory_only) return { label: 'Directory + benefits (person)', cls: 'bg-blue-100 text-blue-800', Icon: CheckCircle2 }
    return { label: 'Real funders selected', cls: 'bg-emerald-100 text-emerald-800', Icon: CheckCircle2 }
  }, [coverage, plan])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Radar className="w-5 h-5 text-indigo-600" /> Crawler Plan
          </h2>
          <p className="text-sm text-slate-500">Which discovery sources fire for a profile, and why. Catches coverage gaps before they cost a grant.</p>
        </div>
        <Button variant="outline" size="sm" onClick={runScan} disabled={scanning}>
          {scanning ? <Loader2 className="animate-spin h-4 w-4 mr-2" /> : <ScanSearch className="w-4 h-4 mr-2" />}
          Scan all profiles
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan a single profile</CardTitle>
          <CardDescription>Pick a profile to see the exact crawler plan.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Select
              value={selectedId}
              onValueChange={(v) => { setSelectedId(v); fetchPlan(v) }}
            >
              <SelectTrigger className="max-w-md">
                <SelectValue placeholder="Select a profile…" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.display_name || p.name || p.id} {p.primary_type ? `· ${p.primary_type}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedId && (
              <Button variant="ghost" size="sm" onClick={() => fetchPlan(selectedId)} disabled={loadingPlan}>
                <RefreshCw className={`w-4 h-4 ${loadingPlan ? 'animate-spin' : ''}`} />
              </Button>
            )}
          </div>

          {loadingPlan && <div className="flex justify-center p-8"><Loader2 className="animate-spin h-6 w-6 text-indigo-600" /></div>}

          {plan && !loadingPlan && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">{plan.display_name || plan.profile_id}</span>
                <Badge variant="outline">{plan.primary_type || 'unknown type'}</Badge>
                {coverageBadge && (
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${coverageBadge.cls}`}>
                    <coverageBadge.Icon className="w-3.5 h-3.5" /> {coverageBadge.label}
                  </span>
                )}
              </div>

              <div className="text-xs text-slate-600">
                <span className="font-semibold">Applicant types:</span> {plan.applicant_types?.join(', ') || '—'}
                {plan.needs?.length > 0 && <> · <span className="font-semibold">Needs:</span> {plan.needs.join(', ')}</>}
              </div>

              {Array.isArray(plan.keyword_triggers) && plan.keyword_triggers.length > 0 && (
                <Alert className="border-indigo-200 bg-indigo-50">
                  <Sparkles className="h-4 w-4 text-indigo-700" />
                  <AlertDescription className="text-indigo-950 text-sm">
                    <span className="font-semibold">Keyword safety net fired:</span>
                    <ul className="mt-1 ml-4 list-disc">
                      {plan.keyword_triggers.map((t, i) => (
                        <li key={i}>
                          “{t.matched}” → applicant type <code>{t.add}</code> ({t.label})
                          {t.already_present ? ' (already covered)' : ''}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {plan.notes?.length > 0 && (
                <Alert variant={plan.coverage?.zero ? 'destructive' : 'default'}>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-sm">
                    <ul className="ml-4 list-disc">{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-semibold text-emerald-700 uppercase mb-2">Selected sources ({plan.selected_sources?.length || 0})</p>
                  <div className="space-y-2">
                    {(plan.selected_sources || []).map((s) => (
                      <div key={s.source_id} className="rounded border border-emerald-100 bg-emerald-50/50 p-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{s.name}</span>
                          {s.directory && <Badge variant="outline" className="text-[10px]">directory</Badge>}
                        </div>
                        <div className="text-xs text-slate-500">{s.reasons?.join(' ')}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Excluded sources ({plan.excluded_sources?.length || 0})</p>
                  <div className="space-y-2">
                    {(plan.excluded_sources || []).map((s) => (
                      <div key={s.source_id} className="rounded border border-slate-100 bg-slate-50 p-2 text-sm">
                        <span className="font-medium text-slate-700">{s.name}</span>
                        <div className="text-xs text-slate-500">{s.reasons?.join(' ')}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {audit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              Coverage scan — {audit.scanned} profiles
            </CardTitle>
            <CardDescription>
              {audit.healthy} healthy · {audit.zero_coverage?.length || 0} zero-coverage · {audit.org_directory_only?.length || 0} org directory-only
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(audit.zero_coverage?.length || 0) === 0 && (audit.org_directory_only?.length || 0) === 0 ? (
              <Alert className="border-emerald-200 bg-emerald-50">
                <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                <AlertDescription className="text-emerald-950 text-sm">
                  Every scanned profile reaches at least one relatable source. No mission-rule coverage gaps.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                {audit.zero_coverage?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-red-700 uppercase mb-2">Zero-coverage (mission failure)</p>
                    {audit.zero_coverage.map((p) => (
                      <button
                        key={p.profile_id}
                        className="block w-full text-left rounded border border-red-100 bg-red-50 p-2 text-sm mb-1 hover:bg-red-100"
                        onClick={() => { setSelectedId(p.profile_id); fetchPlan(p.profile_id) }}
                      >
                        {p.display_name || p.profile_id} · {p.primary_type} · apps=[{p.applicant_types?.join(',')}]
                      </button>
                    ))}
                  </div>
                )}
                {audit.org_directory_only?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-amber-700 uppercase mb-2">Org resolved to directory-only (likely type/keyword gap)</p>
                    {audit.org_directory_only.map((p) => (
                      <button
                        key={p.profile_id}
                        className="block w-full text-left rounded border border-amber-100 bg-amber-50 p-2 text-sm mb-1 hover:bg-amber-100"
                        onClick={() => { setSelectedId(p.profile_id); fetchPlan(p.profile_id) }}
                      >
                        {p.display_name || p.profile_id} · {p.primary_type} · apps=[{p.applicant_types?.join(',')}]
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
