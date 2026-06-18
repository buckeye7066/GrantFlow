import React, { useCallback, useEffect, useState } from "react"
import { AlertCircle, Compass, Loader2, PlayCircle, RefreshCw, Search } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

const REFRESH_INTERVAL_MS = 8000

async function getStatus() {
  return apiFetch('/api/robert/status')
}
async function listRuns(limit = 5) {
  return apiFetch(`/api/robert/runs?limit=${limit}`)
}
async function postRun(path, body) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) })
}

export default function AdminRobertConsole() {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [runs, setRuns] = useState([])
  const [payload, setPayload] = useState(JSON.stringify({
    mode: 'observe',
    profileIds: [],
    maxProfiles: 10,
    dryRun: true,
    autoIngestVerified: false,
    createRecommendations: true,
    deliverToasts: true,
  }, null, 2))
  const [traceEntity, setTraceEntity] = useState('')
  const [traceType, setTraceType] = useState('company')
  const [traceResult, setTraceResult] = useState(null)
  const [autoProfileId, setAutoProfileId] = useState('')
  const [autoResult, setAutoResult] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([getStatus(), listRuns(5)])
      setStatus(s)
      setRuns(Array.isArray(r?.runs) ? r.runs : [])
    } catch (err) {
      toast({ title: 'Failed to load Robert status', description: err.message, variant: 'destructive' })
    }
  }, [toast])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  async function run(label, path) {
    setBusy(true)
    try {
      let body = {}
      try { body = JSON.parse(payload || '{}') }
      catch (parseErr) {
        toast({ title: 'Invalid JSON payload', description: parseErr.message, variant: 'destructive' })
        setBusy(false); return
      }
      const res = await postRun(path, body)
      toast({ title: label, description: `Run ${res?.run_id?.slice(0, 18) || 'complete'} • status ${res?.status || 'ok'}` })
      await refresh()
    } catch (err) {
      toast({ title: `Failed: ${label}`, description: err.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  async function traceFunding() {
    const entity = traceEntity.trim()
    if (!entity) return
    setBusy(true)
    setTraceResult(null)
    try {
      const res = await postRun('/api/robert/trace-funding', { entity, entity_type: traceType })
      setTraceResult(res)
      toast({
        title: 'Funding traced',
        description: `${res.addable} addable of ${res.traced} traced • ${res.upserted} staged as source candidates`,
      })
      await refresh()
    } catch (err) {
      toast({ title: 'Funding trace failed', description: err.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  async function autoSeedWeakest() {
    setBusy(true)
    setAutoResult(null)
    try {
      const res = await postRun('/api/robert/trace-funding/auto-weakest', {})
      setAutoResult({ ...res, weakest: true })
      toast({
        title: 'Weak-coverage sweep complete',
        description: `${res.weak_profiles} weak profiles seeded • ${res.total_upserted} funders staged`,
      })
      await refresh()
    } catch (err) {
      toast({ title: 'Weak-coverage sweep failed', description: err.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  async function autoSeedTrace() {
    const profileId = autoProfileId.trim()
    if (!profileId) return
    setBusy(true)
    setAutoResult(null)
    try {
      const res = await postRun('/api/robert/trace-funding/auto', { profileId })
      setAutoResult(res)
      toast({
        title: 'Auto-seed complete',
        description: `${res.seeds_traced} peer entities traced • ${res.total_upserted} funders staged`,
      })
      await refresh()
    } catch (err) {
      toast({ title: 'Auto-seed failed', description: err.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const last = runs[0] || status?.last_run
  const enabled = Boolean(status?.enabled)

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Compass className="w-5 h-5 text-emerald-600" />
            Robert — Funding Discovery Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              Robert discovers and verifies funding opportunities using GrantFlow's canonical match engine, opportunity policy, validator, reviewer, and reality gates. Robert never replaces Anya, never replaces Sam, never invents new scoring, and never auto-adds opportunities to a user's pipeline.
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard label="Enabled" value={enabled ? 'yes' : 'no'} tone={enabled ? 'good' : 'bad'} />
            <StatCard label="Mode" value={status?.mode || '—'} />
            <StatCard label="Live web" value={status?.allow_live_web ? 'allowed' : 'blocked'} tone={status?.allow_live_web ? 'warn' : 'good'} />
            <StatCard label="Auto-ingest" value={status?.auto_ingest_verified ? 'on' : 'off'} tone={status?.auto_ingest_verified ? 'warn' : 'good'} />
          </div>

          {last && (
            <Card className="bg-slate-50 border-slate-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Last run</CardTitle>
              </CardHeader>
              <CardContent className="text-xs grid grid-cols-2 sm:grid-cols-4 gap-2">
                <KV k="run_id" v={(last.id || last.run_id || '').slice(0, 18)} />
                <KV k="mode" v={last.mode} />
                <KV k="status" v={last.status} />
                <KV k="started" v={last.started_at} />
                <KV k="profiles" v={last.profiles_considered ?? 0} />
                <KV k="sources" v={last.sources_considered ?? 0} />
                <KV k="candidates" v={last.candidates_found ?? 0} />
                <KV k="verified" v={last.candidates_verified ?? 0} />
                <KV k="ingested" v={last.opportunities_ingested ?? 0} />
                <KV k="matched" v={last.opportunities_matched ?? 0} />
                <KV k="recs created" v={last.recommendations_created ?? 0} />
                <KV k="zero-result helped" v={last.zero_result_profiles_helped ?? 0} />
              </CardContent>
            </Card>
          )}

          <div className="space-y-2">
            <Label>Payload (JSON)</Label>
            <Textarea value={payload} onChange={(e) => setPayload(e.target.value)} className="min-h-[140px] font-mono text-xs" />
            <p className="text-[11px] text-slate-500">
              Robert is disabled by default and runs in observe mode. Live web fetching requires <code>ROBERT_ENABLED=true</code> + <code>ROBERT_ALLOW_LIVE_WEB=true</code>. Auto-ingestion requires <code>ROBERT_AUTO_INGEST_VERIFIED=true</code>.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run('Run coverage analysis', '/api/robert/analyze-coverage')} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
              Coverage analysis
            </Button>
            <Button variant="outline" onClick={() => run('Discover sources', '/api/robert/discover-sources')} disabled={busy}>
              <PlayCircle className="w-4 h-4 mr-2" /> Discover sources
            </Button>
            <Button variant="outline" onClick={() => run('Discover opportunities', '/api/robert/discover-opportunities')} disabled={busy}>
              <PlayCircle className="w-4 h-4 mr-2" /> Discover opportunities
            </Button>
            <Button variant="outline" onClick={() => run('Verify candidates', '/api/robert/verify-candidates')} disabled={busy}>
              <PlayCircle className="w-4 h-4 mr-2" /> Verify candidates
            </Button>
            <Button variant="outline" onClick={() => run('Ingest verified', '/api/robert/ingest-verified')} disabled={busy}>
              <PlayCircle className="w-4 h-4 mr-2" /> Ingest verified
            </Button>
            <Button variant="outline" onClick={() => run('Match new opportunities', '/api/robert/match-new')} disabled={busy}>
              <PlayCircle className="w-4 h-4 mr-2" /> Match new
            </Button>
            <Button variant="outline" onClick={() => run('Create recommendations', '/api/robert/recommend')} disabled={busy}>
              <PlayCircle className="w-4 h-4 mr-2" /> Create recommendations
            </Button>
            <Button onClick={() => run('Full cycle', '/api/robert/run')} disabled={busy} variant="default">
              <PlayCircle className="w-4 h-4 mr-2" /> Full cycle
            </Button>
            <Button variant="ghost" onClick={refresh} disabled={busy}>
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
          </div>

          <Card className="border-emerald-200 bg-emerald-50/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Search className="w-4 h-4 text-emerald-600" /> Trace funding for an entity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-slate-600">
                Give Robert a company, public entity, or individual and he traces where their money comes from
                (federal awards + AI analysis). Real, recently-funded sources are staged as <strong>pending source
                candidates</strong> for the normal verify → ingest pipeline.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  placeholder="e.g. Lockheed Martin, City of Columbus"
                  value={traceEntity}
                  onChange={(e) => setTraceEntity(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') traceFunding() }}
                  className="flex-1"
                />
                <Select value={traceType} onValueChange={setTraceType}>
                  <SelectTrigger className="sm:w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="company">Company / Corporation</SelectItem>
                    <SelectItem value="public_entity">Public Entity</SelectItem>
                    <SelectItem value="individual">Individual</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={traceFunding} disabled={busy || !traceEntity.trim()} className="bg-emerald-600 hover:bg-emerald-700">
                  {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                  Trace
                </Button>
              </div>
              {traceResult && (
                <div className="text-xs text-slate-700 flex flex-wrap gap-x-4 gap-y-1 pt-1">
                  <span><strong>{traceResult.traced}</strong> traced</span>
                  <span><strong>{traceResult.addable}</strong> addable</span>
                  <span><strong>{traceResult.upserted}</strong> staged ({traceResult.inserted} new)</span>
                  {traceResult.skipped_no_url > 0 && <span>{traceResult.skipped_no_url} skipped (no URL)</span>}
                  {traceResult.addability && (
                    <span className="text-slate-400">
                      floor: ${(traceResult.addability.min_amount || 0).toLocaleString()} / {traceResult.addability.max_age_years}yr
                    </span>
                  )}
                </div>
              )}

              <div className="border-t border-emerald-200/70 pt-2 mt-1 space-y-2">
                <p className="text-xs text-slate-600">
                  Or let Robert <strong>auto-seed</strong>: he finds funded organizations similar to a profile and
                  traces their funders — no entity entry needed.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    placeholder="Profile ID to auto-seed from"
                    value={autoProfileId}
                    onChange={(e) => setAutoProfileId(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') autoSeedTrace() }}
                    className="flex-1"
                  />
                  <Button variant="outline" onClick={autoSeedTrace} disabled={busy || !autoProfileId.trim()}>
                    {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Compass className="w-4 h-4 mr-2" />}
                    Auto-seed from profile
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={autoSeedWeakest} disabled={busy} className="text-emerald-700">
                    {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Compass className="w-4 h-4 mr-2" />}
                    Sweep weakest-coverage profiles now
                  </Button>
                  <span className="text-[11px] text-slate-400">also runs on schedule when enabled</span>
                </div>
                {autoResult && (
                  <div className="text-xs text-slate-700 flex flex-wrap gap-x-4 gap-y-1">
                    {autoResult.weakest ? (
                      <>
                        <span><strong>{autoResult.evaluated}</strong> profiles evaluated</span>
                        <span><strong>{autoResult.weak_profiles}</strong> weak profiles seeded</span>
                        <span><strong>{autoResult.total_upserted}</strong> staged</span>
                      </>
                    ) : (
                      <>
                        <span><strong>{autoResult.seeds_traced}</strong> peers traced</span>
                        <span><strong>{autoResult.total_addable}</strong> addable</span>
                        <span><strong>{autoResult.total_upserted}</strong> staged</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </CardContent>
      </Card>

      {runs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {runs.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline">{r.mode}</Badge>
                <Badge variant={r.status === 'completed' ? 'default' : r.status === 'failed' ? 'destructive' : 'secondary'}>{r.status}</Badge>
                <span className="text-slate-500">{r.started_at}</span>
                <span>profiles {r.profiles_considered ?? 0}</span>
                <span>candidates {r.candidates_found ?? 0}</span>
                <span>ingested {r.opportunities_ingested ?? 0}</span>
                <span>recs {r.recommendations_created ?? 0}</span>
                {r.error && <span className="text-rose-600">error</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function StatCard({ label, value, tone }) {
  const toneClass = tone === 'good'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : tone === 'warn'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : tone === 'bad'
        ? 'bg-rose-50 text-rose-700 border-rose-200'
        : 'bg-slate-50 text-slate-700 border-slate-200'
  return (
    <div className={`border rounded-md px-3 py-2 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="font-semibold text-sm break-all">{String(value ?? '—')}</div>
    </div>
  )
}

function KV({ k, v }) {
  return (
    <div>
      <div className="text-slate-500 uppercase tracking-wide text-[10px]">{k}</div>
      <div className="font-medium break-all">{String(v ?? '—')}</div>
    </div>
  )
}
