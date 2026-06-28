import React, { useState, useMemo, useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  searchFoundations, getFoundation, searchNSF, searchFederalPrograms,
  scoreOpportunities, getProfileRegion, reverseLookup,
} from "@/api/foundations"
import { listProfiles } from "@/api/profiles"
import { apiFetch } from "@/api/client"
import { useToast } from "@/components/ui/use-toast"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import {
  Search, Building2, DollarSign, FileText, ExternalLink,
  Loader2, MapPin, TrendingUp, Database, Beaker, Landmark,
  ChevronLeft, ChevronRight, Plus, Check, Target, Mail, Phone, User,
  Sparkles,
} from "lucide-react"

const PAGE_SIZE = 25

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI",
  "SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]

function formatCurrency(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "N/A"
  const v = Number(n)
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toLocaleString()}`
}

/** True when a numeric score is present (0 is valid; null/undefined is not). */
function hasScore(v) {
  return v !== null && v !== undefined
}

/** Turn a /score response into a Map keyed by ein/source_id. */
function buildScoreMap(scoreData) {
  const map = new Map()
  const scores = scoreData?.data?.scores ?? scoreData?.scores ?? []
  for (const s of scores) {
    if (s?.key) map.set(String(s.key), s)
  }
  return map
}

function scoreColor(score) {
  if (score === null || score === undefined) return "bg-slate-100 text-slate-500"
  if (score >= 70) return "bg-emerald-100 text-emerald-700"
  if (score >= 50) return "bg-amber-100 text-amber-700"
  return "bg-slate-100 text-slate-600"
}

/** Small inline match-score chip. */
function MatchBadge({ score, loading }) {
  if (loading) {
    return <span className="text-xs text-slate-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> scoring…</span>
  }
  if (score === null || score === undefined) return null
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 ${scoreColor(score)}`}>
      <Target className="w-3 h-3" /> {score}% match
    </span>
  )
}

/** A single org/foundation result card (shared by the Foundations + Recommended tabs). */
function FoundationCard({ org, score, scoring, scored, hasProfile, onOpen, AddButton, footnote }) {
  // "not yet fetched" = no resolved entry in the score map at all.
  const showSpinner = scoring && !scored && hasProfile
  return (
    <Card
      className="hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer"
      onClick={() => onOpen({ kind: "foundation", item: org })}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="font-semibold text-slate-900">{org.name}</h3>
              {org.ntee_code && <Badge variant="outline" className="text-xs">{org.ntee_code}</Badge>}
              <MatchBadge score={score} loading={showSpinner} />
            </div>
            <div className="flex flex-wrap gap-3 text-sm text-slate-600">
              {org.city && org.state && (
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {org.city}, {org.state}</span>
              )}
              {!org.city && org.state && (
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {org.state}</span>
              )}
              {org.income_amount !== null && org.income_amount !== undefined && (
                <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Income: {formatCurrency(org.income_amount)}</span>
              )}
              {org.asset_amount !== null && org.asset_amount !== undefined && (
                <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" /> Assets: {formatCurrency(org.asset_amount)}</span>
              )}
              {org.grant_amount > 0 && (
                <span className="flex items-center gap-1 font-medium text-emerald-700"><DollarSign className="w-3 h-3" /> Grants Paid: {formatCurrency(org.grant_amount)}</span>
              )}
            </div>
            {footnote && <p className="text-xs text-blue-600 mt-1">{footnote}</p>}
            {org.ein && /^\d/.test(String(org.ein)) && <p className="text-xs text-slate-400 mt-1">EIN: {org.ein}</p>}
          </div>
          <div className="flex gap-2 items-center shrink-0">
            <AddButton kind="foundation" item={org} score={score} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function FoundationSearch() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [activeTab, setActiveTab] = useState("foundations")

  // ── Profile (target for scoring + pipeline) ──────────────────────────────
  const { data: profiles = [] } = useQuery({ queryKey: ["profiles"], queryFn: () => listProfiles(), staleTime: 300_000 })
  const profileList = useMemo(() => {
    const payload = profiles?.data ?? profiles ?? []
    return Array.isArray(payload) ? payload : (payload.profiles ?? [])
  }, [profiles])
  const [selectedProfileId, setSelectedProfileId] = useState("")

  // Default to the first profile once loaded (only if it has a usable id).
  useEffect(() => {
    if (selectedProfileId) return
    const first = profileList[0]
    if (first?.id !== null && first?.id !== undefined) setSelectedProfileId(String(first.id))
  }, [profileList, selectedProfileId])

  // ── Search state ─────────────────────────────────────────────────────────
  const [fQuery, setFQuery] = useState("")
  const [fState, setFState] = useState("")
  const [fPage, setFPage] = useState(0)
  const [submittedF, setSubmittedF] = useState("")

  const [nsfQuery, setNsfQuery] = useState("")
  const [nsfState, setNsfState] = useState("")
  const [submittedNSF, setSubmittedNSF] = useState("")

  const [fedQuery, setFedQuery] = useState("")
  const [submittedFed, setSubmittedFed] = useState("")

  // Unified detail dialog: { kind: 'foundation'|'nsf'|'federal', item }
  const [detailTarget, setDetailTarget] = useState(null)

  // Pipeline add state
  const [addingKey, setAddingKey] = useState(null)
  const [addedKeys, setAddedKeys] = useState(() => new Set())

  // When the profile changes, prepopulate the state dropdowns from its region.
  useEffect(() => {
    if (!selectedProfileId) return
    let cancelled = false
    getProfileRegion(selectedProfileId)
      .then((res) => {
        const st = (res?.data ?? res)?.state
        if (cancelled || !st) return
        setFState((prev) => prev || String(st).toUpperCase())
        setNsfState((prev) => prev || String(st).toUpperCase())
      })
      .catch((err) => {
        // region is best-effort; surface for debugging only.
        if (import.meta?.env?.DEV) {

          console.warn("getProfileRegion failed (non-fatal):", err)
        }
      })
    return () => { cancelled = true }
  }, [selectedProfileId])

  // ── Foundations query (keyword OR state-browse) ──────────────────────────
  const fEnabled = Boolean(submittedF || fState)
  const { data: fResults, isLoading: fLoading } = useQuery({
    queryKey: ["foundation-search", submittedF, fState, fPage],
    queryFn: () => searchFoundations({ q: submittedF || undefined, state: fState || undefined, page: fPage }),
    enabled: fEnabled,
    staleTime: 120_000,
  })
  const fOrgs = useMemo(() => {
    const payload = fResults?.data ?? fResults ?? {}
    return Array.isArray(payload.organizations) ? payload.organizations : []
  }, [fResults])
  const fTotal = (fResults?.data ?? fResults)?.total_results ?? 0

  // ── NSF query (keyword OR state-browse) ──────────────────────────────────
  const nsfEnabled = Boolean(submittedNSF || nsfState)
  const { data: nsfResults, isLoading: nsfLoading } = useQuery({
    queryKey: ["nsf-search", submittedNSF, nsfState],
    queryFn: () => searchNSF({ keyword: submittedNSF || undefined, state: nsfState || undefined }),
    enabled: nsfEnabled,
    staleTime: 120_000,
  })
  const nsfOpps = useMemo(() => {
    const payload = nsfResults?.data ?? nsfResults ?? {}
    return Array.isArray(payload.opportunities) ? payload.opportunities : []
  }, [nsfResults])

  // ── Federal query (prepopulated list; keyword refines) ───────────────────
  const { data: fedResults, isLoading: fedLoading } = useQuery({
    queryKey: ["federal-search", submittedFed],
    queryFn: () => searchFederalPrograms({ keyword: submittedFed || undefined }),
    enabled: true,
    staleTime: 120_000,
  })
  const fedOpps = useMemo(() => {
    const payload = fedResults?.data ?? fedResults ?? {}
    return Array.isArray(payload.opportunities) ? payload.opportunities : []
  }, [fedResults])

  // ── Batch scoring per tab (keyed by visible result identities) ───────────
  const fKeys = useMemo(() => fOrgs.map((o) => o.ein).filter(Boolean).join(","), [fOrgs])
  const { data: fScoreData, isFetching: fScoring } = useQuery({
    queryKey: ["foundation-scores", selectedProfileId, fKeys],
    queryFn: () => scoreOpportunities({ profileId: selectedProfileId, kind: "foundation", items: fOrgs }),
    enabled: Boolean(selectedProfileId && fOrgs.length),
    staleTime: 120_000,
  })
  const fScores = useMemo(() => buildScoreMap(fScoreData), [fScoreData])

  const nsfKeys = useMemo(() => nsfOpps.map((o) => o.source_id).filter(Boolean).join(","), [nsfOpps])
  const { data: nsfScoreData, isFetching: nsfScoring } = useQuery({
    queryKey: ["nsf-scores", selectedProfileId, nsfKeys],
    queryFn: () => scoreOpportunities({ profileId: selectedProfileId, kind: "nsf", items: nsfOpps }),
    enabled: Boolean(selectedProfileId && nsfOpps.length),
    staleTime: 120_000,
  })
  const nsfScores = useMemo(() => buildScoreMap(nsfScoreData), [nsfScoreData])

  const fedKeys = useMemo(() => fedOpps.map((o) => o.source_id).filter(Boolean).join(","), [fedOpps])
  const { data: fedScoreData, isFetching: fedScoring } = useQuery({
    queryKey: ["federal-scores", selectedProfileId, fedKeys],
    queryFn: () => scoreOpportunities({ profileId: selectedProfileId, kind: "federal", items: fedOpps }),
    enabled: Boolean(selectedProfileId && fedOpps.length),
    staleTime: 120_000,
  })
  const fedScores = useMemo(() => buildScoreMap(fedScoreData), [fedScoreData])

  // ── Recommended funders for the selected profile (reverse-lookup) ────────
  const { data: recoData, isLoading: recoLoading, isError: recoError } = useQuery({
    queryKey: ["reverse-lookup", selectedProfileId],
    queryFn: () => reverseLookup(selectedProfileId, { maxResults: 25 }),
    enabled: Boolean(selectedProfileId) && activeTab === "recommended",
    staleTime: 300_000,
  })
  const recoFunders = useMemo(() => {
    const payload = recoData?.data ?? recoData ?? {}
    return Array.isArray(payload.suggested_funders) ? payload.suggested_funders : []
  }, [recoData])
  const recoSummary = (recoData?.data ?? recoData)?.profile_summary ?? null

  const recoKeys = useMemo(() => recoFunders.map((o) => o.ein).filter(Boolean).join(","), [recoFunders])
  const { data: recoScoreData, isFetching: recoScoring } = useQuery({
    queryKey: ["reco-scores", selectedProfileId, recoKeys],
    queryFn: () => scoreOpportunities({ profileId: selectedProfileId, kind: "foundation", items: recoFunders }),
    enabled: Boolean(selectedProfileId && recoFunders.length),
    staleTime: 120_000,
  })
  const recoScores = useMemo(() => buildScoreMap(recoScoreData), [recoScoreData])

  // Merged foundation-scope score map for the dialog (memoized so identity is stable).
  const dialogScores = useMemo(() => ({
    foundation: new Map([...fScores, ...recoScores]),
    nsf: nsfScores,
    federal: fedScores,
  }), [fScores, recoScores, nsfScores, fedScores])

  // ── Foundation detail (filings + contact) ────────────────────────────────
  // Only the live 990 lookup needs a real 9-digit EIN; catalog-only funders
  // (non-EIN ids) fall back to the data already on the card.
  const selectedEinRaw = detailTarget?.kind === "foundation" ? detailTarget.item?.ein : null
  const selectedEin = /^\d{9}$/.test(String(selectedEinRaw ?? "").replace(/\D/g, "")) ? selectedEinRaw : null
  const { data: detailResult, isLoading: detailLoading } = useQuery({
    queryKey: ["foundation-detail", selectedEin],
    queryFn: () => getFoundation(selectedEin),
    enabled: selectedEin !== null && selectedEin !== undefined,
    staleTime: 300_000,
  })
  const foundationDetail = detailResult?.data ?? detailResult ?? null

  // ── Add to pipeline ──────────────────────────────────────────────────────
  async function handleAddToPipeline(kind, item, key) {
    if (!selectedProfileId) {
      toast({ variant: "destructive", title: "Select a profile", description: "Choose a profile to add this funding source to its pipeline." })
      return
    }
    setAddingKey(key)
    try {
      // Re-score the single item so we get the canonical, save-ready opportunity
      // shape and an authoritative match score regardless of which tab it's on.
      let scored = (kind === "foundation" ? fScores : kind === "nsf" ? nsfScores : fedScores).get(String(key))
      if (!scored?.opportunity) {
        const res = await scoreOpportunities({ profileId: selectedProfileId, kind, items: [item] })
        // Prefer a keyed match; for a single-item request the first element is
        // the authoritative result, so fall back to it only if keys are absent.
        const mapped = buildScoreMap(res).get(String(key))
        const firstScore = (res?.data ?? res)?.scores?.[0]
        scored = mapped ?? firstScore
        // Guard against a key mismatch returning the wrong item.
        if (mapped && firstScore && mapped.key && firstScore.key && String(mapped.key) !== String(key)) {
          scored = firstScore
        }
      }
      const opp = scored?.opportunity
      if (!opp) throw new Error("Could not prepare this funding source for the pipeline.")

      const result = await apiFetch("/api/grants/from-opportunity", {
        method: "POST",
        body: JSON.stringify({
          profile_id: selectedProfileId,
          match_score: scored?.match_score ?? null,
          match_reasons: scored?.match_reasons ?? [],
          opportunity_data: {
            title: opp.title,
            sponsor: opp.sponsor,
            deadline: opp.deadline,
            deadline_type: opp.deadline_type,
            application_url: opp.application_url ?? opp.source_url ?? null,
            url: opp.source_url ?? null,
            amount_min: opp.amount_min,
            amount_max: opp.amount_max,
            description: opp.description,
            eligibilityBullets: opp.eligibility_bullets ?? [],
            source: opp.source,
            record_origin: opp.record_origin ?? "funding_api",
            state: opp.state,
            source_id: opp.source_id,
            opportunity_type: opp.opportunity_type,
            contact_info: opp.contact_info ?? null,
          },
        }),
      })

      // Only mark as "in pipeline" once we confirm a successful, persisted result.
      const persisted = Boolean(result?.id || result?.grant?.id || result?.already_exists)
      if (!persisted) {
        throw new Error("The funding source did not appear to save. Please try again.")
      }

      setAddedKeys((prev) => {
        const next = new Set(prev)
        next.add(String(key))
        return next
      })
      queryClient.invalidateQueries({ queryKey: ["grants"] })
      if (result?.already_exists) {
        toast({ title: "Already in pipeline", description: `"${opp.title}" is already in this profile's pipeline.` })
      } else {
        toast({
          title: "Added to pipeline",
          description: `${opp.title} added${hasScore(scored?.match_score) ? ` (${scored.match_score}% match)` : ""}.`,
        })
      }
    } catch (error) {
      const msg = error?.details?.message || error?.message || "Could not add to pipeline."
      toast({ variant: "destructive", title: "Could not add to pipeline", description: msg })
    } finally {
      setAddingKey(null)
    }
  }

  function AddButton({ kind, item, score, size = "sm" }) {
    const key = String(kind === "foundation" ? item.ein : item.source_id)
    const added = addedKeys.has(key)
    const busy = addingKey === key
    if (added) {
      return (
        <Button size={size} variant="outline" disabled className="text-emerald-700 border-emerald-200">
          <Check className="w-4 h-4 mr-1" /> In pipeline
        </Button>
      )
    }
    return (
      <Button
        size={size}
        onClick={(e) => { e.stopPropagation(); handleAddToPipeline(kind, item, key) }}
        disabled={busy || !selectedProfileId}
        title={!selectedProfileId ? "Select a profile first" : "Add to pipeline"}
      >
        {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
        Add{hasScore(score) ? ` · ${score}%` : ""}
      </Button>
    )
  }

  const profileSelector = (
    <div className="flex items-center gap-2">
      <Label className="text-sm text-slate-600 whitespace-nowrap">Pipeline profile:</Label>
      <select
        value={selectedProfileId}
        onChange={(e) => setSelectedProfileId(e.target.value)}
        className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm min-w-[180px]"
      >
        <option value="">— Select a profile —</option>
        {profileList.map((p) => (
          <option key={String(p.id)} value={String(p.id)}>{p.display_name || p.name || p.id}</option>
        ))}
      </select>
    </div>
  )

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <Database className="w-8 h-8" /> Foundation & Data Source Search
            </h1>
            <p className="text-slate-600 mt-2">
              Search 1.8M+ nonprofits with IRS 990 data, NSF awards, and federal assistance programs — free, no subscription required
            </p>
          </div>
          {profileSelector}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="foundations" className="flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Foundations & 990s
            </TabsTrigger>
            <TabsTrigger value="nsf" className="flex items-center gap-2">
              <Beaker className="w-4 h-4" /> NSF Awards
            </TabsTrigger>
            <TabsTrigger value="federal" className="flex items-center gap-2">
              <Landmark className="w-4 h-4" /> Federal Programs
            </TabsTrigger>
            <TabsTrigger value="recommended" className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" /> Recommended
            </TabsTrigger>
          </TabsList>

          {/* ── Foundations Tab ─────────────────────────────────────── */}
          <TabsContent value="foundations" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Search Foundations & Nonprofits</CardTitle>
                <CardDescription>
                  Powered by ProPublica Nonprofit Explorer — IRS 990 financial data for 1.8M+ organizations.
                  Pick a state to browse, or search by name.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => { e.preventDefault(); setFPage(0); setSubmittedF(fQuery.trim()) }}
                  className="flex flex-wrap gap-3"
                >
                  <div className="flex-1 min-w-[200px]">
                    <Label className="sr-only">Search</Label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        placeholder="Search by name (e.g. Gates Foundation, Rotary, United Way)..."
                        value={fQuery}
                        onChange={(e) => setFQuery(e.target.value)}
                        className="pl-10"
                      />
                    </div>
                  </div>
                  <select
                    value={fState}
                    onChange={(e) => { setFState(e.target.value); setFPage(0) }}
                    className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                  >
                    <option value="">All States</option>
                    {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <Button type="submit" disabled={fLoading}>
                    {fLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                    Search
                  </Button>
                </form>
              </CardContent>
            </Card>

            {fEnabled && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-600">
                    {fLoading
                      ? "Searching..."
                      : `${fTotal.toLocaleString()} results${submittedF ? ` for "${submittedF}"` : fState ? ` in ${fState}` : ""}`}
                  </p>
                  {fTotal > 0 && (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={fPage === 0} onClick={() => setFPage(p => p - 1)}>
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      <span className="text-sm text-slate-600">Page {fPage + 1}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(fPage + 1) * PAGE_SIZE >= fTotal}
                        onClick={() => setFPage(p => p + 1)}
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                </div>
                {fOrgs.map((org) => {
                  const entry = fScores.get(String(org.ein))
                  return (
                    <FoundationCard
                      key={org.ein || org.name}
                      org={org}
                      score={entry?.match_score}
                      scored={entry}
                      scoring={fScoring}
                      hasProfile={Boolean(selectedProfileId)}
                      onOpen={setDetailTarget}
                      AddButton={AddButton}
                    />
                  )
                })}
              </div>
            )}
          </TabsContent>

          {/* ── NSF Tab ──────────────────────────────────────────── */}
          <TabsContent value="nsf" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>NSF Awards Search</CardTitle>
                <CardDescription>
                  National Science Foundation funded awards — science, engineering, and education research.
                  Pick a state to browse, or search by topic.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => { e.preventDefault(); setSubmittedNSF(nsfQuery.trim()) }}
                  className="flex flex-wrap gap-3"
                >
                  <div className="flex-1 min-w-[200px]">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        placeholder="Search NSF awards (e.g. climate science, AI, education)..."
                        value={nsfQuery}
                        onChange={(e) => setNsfQuery(e.target.value)}
                        className="pl-10"
                      />
                    </div>
                  </div>
                  <select
                    value={nsfState}
                    onChange={(e) => setNsfState(e.target.value)}
                    className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                  >
                    <option value="">All States</option>
                    {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <Button type="submit" disabled={nsfLoading}>
                    {nsfLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                    Search
                  </Button>
                </form>
              </CardContent>
            </Card>

            {nsfEnabled && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  {nsfLoading ? "Searching NSF..." : `${nsfOpps.length} awards${submittedNSF ? ` for "${submittedNSF}"` : nsfState ? ` in ${nsfState}` : ""}`}
                </p>
                {nsfOpps.map((opp, i) => {
                  const entry = nsfScores.get(String(opp.source_id))
                  const score = entry?.match_score
                  return (
                    <Card
                      key={opp.source_id || i}
                      className="hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer"
                      onClick={() => setDetailTarget({ kind: "nsf", item: opp })}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <h3 className="font-semibold text-slate-900">{opp.title}</h3>
                              <MatchBadge score={score} loading={nsfScoring && !entry && Boolean(selectedProfileId)} />
                            </div>
                            <p className="text-sm text-slate-600 mb-2">{opp.sponsor}</p>
                            {opp.description && <p className="text-sm text-slate-500 line-clamp-2">{opp.description}</p>}
                            <div className="flex flex-wrap gap-3 text-xs text-slate-500 mt-2">
                              {opp.amount_max !== null && opp.amount_max !== undefined && (
                                <span className="font-medium text-emerald-700">{formatCurrency(opp.amount_max)}</span>
                              )}
                              {opp.state && opp.state !== "nationwide" && (
                                <span><MapPin className="w-3 h-3 inline" /> {opp.state}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex gap-2 items-center shrink-0">
                            <AddButton kind="nsf" item={opp} score={score} />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </TabsContent>

          {/* ── Federal Programs Tab ─────────────────────────────── */}
          <TabsContent value="federal" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Federal Assistance Programs (CFDA)</CardTitle>
                <CardDescription>
                  The full catalog of federal domestic assistance — every federal program that provides grants, loans, or services.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => { e.preventDefault(); setSubmittedFed(fedQuery.trim()) }}
                  className="flex flex-wrap gap-3"
                >
                  <div className="flex-1 min-w-[200px]">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        placeholder="Search federal programs (e.g. SNAP, Head Start, community development)..."
                        value={fedQuery}
                        onChange={(e) => setFedQuery(e.target.value)}
                        className="pl-10"
                      />
                    </div>
                  </div>
                  <Button type="submit" disabled={fedLoading}>
                    {fedLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                    Search
                  </Button>
                </form>
              </CardContent>
            </Card>

            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                {fedLoading ? "Loading federal programs..." : `${fedOpps.length} programs${submittedFed ? ` for "${submittedFed}"` : ""}`}
              </p>
              {fedOpps.map((opp, i) => {
                const entry = fedScores.get(String(opp.source_id))
                const score = entry?.match_score
                return (
                  <Card
                    key={opp.source_id || i}
                    className="hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer"
                    onClick={() => setDetailTarget({ kind: "federal", item: opp })}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <h3 className="font-semibold text-slate-900">{opp.title}</h3>
                            <MatchBadge score={score} loading={fedScoring && !entry && Boolean(selectedProfileId)} />
                          </div>
                          {opp.sponsor && <p className="text-sm text-slate-600 mb-1">{opp.sponsor}</p>}
                          {opp.description && <p className="text-sm text-slate-500 line-clamp-3 mb-2">{opp.description}</p>}
                          {opp.eligibility_bullets?.length > 0 && (
                            <div className="text-xs text-slate-500 space-y-0.5">
                              {opp.eligibility_bullets.slice(0, 2).map((b, j) => <p key={j} className="line-clamp-1">{b}</p>)}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-2 mt-2">
                            {opp.categories?.map((c) => <Badge key={c} variant="outline" className="text-xs capitalize">{c}</Badge>)}
                            {opp.amount_max !== null && opp.amount_max !== undefined && (
                              <Badge variant="secondary" className="text-xs">{formatCurrency(opp.amount_max)}</Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2 items-center shrink-0">
                          <AddButton kind="federal" item={opp} score={score} />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </TabsContent>
          {/* ── Recommended Tab (reverse-lookup) ─────────────────── */}
          <TabsContent value="recommended" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Sparkles className="w-5 h-5" /> Funders matched to this profile</CardTitle>
                <CardDescription>
                  Grantmakers aligned with the selected profile's mission area (NTEE) and location, ranked by fit.
                  Drawn from ProPublica 990 grantmakers and your funding catalog.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!selectedProfileId ? (
                  <p className="text-sm text-slate-600">Select a profile above to see recommended funders.</p>
                ) : recoLoading ? (
                  <p className="text-sm text-slate-600 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Finding aligned funders…</p>
                ) : recoSummary ? (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {recoSummary.state && <Badge variant="outline">State: {recoSummary.state}</Badge>}
                    {recoSummary.entity_type && <Badge variant="outline" className="capitalize">{recoSummary.entity_type}</Badge>}
                    {(recoSummary.need_categories ?? []).slice(0, 6).map((n) => (
                      <Badge key={n} variant="secondary" className="capitalize">{String(n).replace(/_/g, " ")}</Badge>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {selectedProfileId && !recoLoading && (
              <div className="space-y-3">
                {recoError && <p className="text-sm text-red-600">Could not load recommendations. Please try again.</p>}
                {!recoError && (
                  <p className="text-sm text-slate-600">{recoFunders.length} recommended funder{recoFunders.length === 1 ? "" : "s"}</p>
                )}
                {recoFunders.map((org) => {
                  const entry = recoScores.get(String(org.ein))
                  return (
                    <FoundationCard
                      key={org.ein || org.name}
                      org={org}
                      score={entry?.match_score}
                      scored={entry}
                      scoring={recoScoring}
                      hasProfile={Boolean(selectedProfileId)}
                      onOpen={setDetailTarget}
                      AddButton={AddButton}
                      footnote={org.source === "local_catalog" ? "From your funding catalog" : org.already_in_catalog ? "Already in catalog" : null}
                    />
                  )
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* ── Unified Detail Dialog ──────────────────────────────── */}
        <DetailDialog
          target={detailTarget}
          onClose={() => setDetailTarget(null)}
          foundationDetail={foundationDetail}
          detailLoading={detailLoading}
          scores={dialogScores}
          AddButton={AddButton}
        />
      </div>
    </div>
  )
}

/** One dialog that renders foundation / NSF / federal detail + add-to-pipeline. */
function DetailDialog({ target, onClose, foundationDetail, detailLoading, scores, AddButton }) {
  const kind = target?.kind
  const item = target?.item ?? null
  const open = Boolean(target)

  let key = null
  if (item) key = String(kind === "foundation" ? item.ein : item.source_id)
  const scored = key ? scores?.[kind]?.get(key) : null

  // Foundation: prefer the freshly fetched detail (has filings + address).
  const fd = kind === "foundation" ? (foundationDetail ?? item ?? null) : null
  const contact = item?.contact_info ?? scored?.opportunity?.contact_info ?? null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-6">{item?.name ?? item?.title ?? "Details"}</DialogTitle>
          <DialogDescription>
            {kind === "foundation" && fd?.ein ? `EIN: ${fd.ein}` : item?.sponsor || ""}
            {kind === "foundation" && fd?.city && fd?.state ? ` · ${fd.city}, ${fd.state}` : ""}
          </DialogDescription>
        </DialogHeader>

        {hasScore(scored?.match_score) && (
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold px-3 py-1 rounded-full flex items-center gap-1 ${scoreColor(scored.match_score)}`}>
              <Target className="w-4 h-4" /> {scored.match_score}% match for this profile
            </span>
            {scored.decision && <Badge variant="outline" className="text-xs">{scored.decision}</Badge>}
          </div>
        )}
        {scored?.match_reasons?.length > 0 && (
          <ul className="text-xs text-slate-600 list-disc pl-5 space-y-0.5">
            {scored.match_reasons.slice(0, 5).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}

        {/* Foundation body */}
        {kind === "foundation" && (
          detailLoading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
          ) : fd ? (
            <div className="space-y-4">
              {(fd.address || fd.city) && (
                <div className="bg-slate-50 rounded-lg p-3 text-sm">
                  <p className="text-xs text-slate-500 mb-1 flex items-center gap-1"><MapPin className="w-3 h-3" /> Address</p>
                  <p>{[fd.address, [fd.city, fd.state].filter(Boolean).join(", "), fd.zipcode].filter(Boolean).join(" · ")}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Total Revenue" value={formatCurrency(fd.revenue_amount ?? fd.income_amount)} />
                <Stat label="Total Assets" value={formatCurrency(fd.asset_amount)} />
                <Stat label="Grants Paid" value={formatCurrency(fd.grant_amount)} emphasis />
                <Stat label="NTEE Code" value={fd.ntee_code || "N/A"} />
              </div>
              {fd.grant_amount > 0 && (
                <p className="text-xs text-slate-500">
                  This organization reported paying grants — it may be a grantmaker. Its 990 filings (below) list its funding activity.
                </p>
              )}
              {fd.filings?.length > 0 && (
                <div>
                  <h4 className="font-semibold text-sm text-slate-700 mb-2">IRS 990 Filing History</h4>
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Year</th>
                          <th className="text-left px-3 py-2 font-medium">Form</th>
                          <th className="text-right px-3 py-2 font-medium">Revenue</th>
                          <th className="text-right px-3 py-2 font-medium">Assets</th>
                          <th className="text-right px-3 py-2 font-medium">Grants Paid</th>
                          <th className="text-center px-3 py-2 font-medium">PDF</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fd.filings.slice(0, 12).map((f, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-3 py-2">{f.tax_period_year || f.tax_period}</td>
                            <td className="px-3 py-2">{f.formtype}</td>
                            <td className="px-3 py-2 text-right">{formatCurrency(f.total_revenue)}</td>
                            <td className="px-3 py-2 text-right">{formatCurrency(f.total_assets_eoy)}</td>
                            <td className="px-3 py-2 text-right font-medium text-emerald-700">{formatCurrency(f.grants_paid)}</td>
                            <td className="px-3 py-2 text-center">
                              {f.pdf_url ? (
                                <Button size="sm" variant="ghost" onClick={() => window.open(f.pdf_url, "_blank", "noopener")}>
                                  <FileText className="w-4 h-4" />
                                </Button>
                              ) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : null
        )}

        {/* NSF / Federal body */}
        {(kind === "nsf" || kind === "federal") && item && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Award / Funding" value={formatCurrency(item.amount_max ?? item.amount_min)} emphasis />
              <Stat label="Type" value={(item.opportunity_type || kind).toString()} />
            </div>
            {item.description && (
              <div>
                <h4 className="font-semibold text-sm text-slate-700 mb-1">Description</h4>
                <p className="text-sm text-slate-600 whitespace-pre-line">{item.description}</p>
              </div>
            )}
            {item.eligibility_bullets?.length > 0 && (
              <div>
                <h4 className="font-semibold text-sm text-slate-700 mb-1">Details & Eligibility</h4>
                <ul className="text-sm text-slate-600 list-disc pl-5 space-y-0.5">
                  {item.eligibility_bullets.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            )}
            {contact && (
              <div className="bg-slate-50 rounded-lg p-3 text-sm space-y-1">
                <p className="text-xs text-slate-500 mb-1">Contact</p>
                {contact.name && <p className="flex items-center gap-2"><User className="w-3 h-3" /> {contact.name}</p>}
                {contact.email && <p className="flex items-center gap-2"><Mail className="w-3 h-3" /> <a className="text-blue-600 underline" href={`mailto:${contact.email}`}>{contact.email}</a></p>}
                {contact.phone && <p className="flex items-center gap-2"><Phone className="w-3 h-3" /> {contact.phone}</p>}
                {contact.notes && <p className="text-slate-600">{contact.notes}</p>}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {item && <AddButton kind={kind} item={item} score={scored?.match_score} size="default" />}
          <Button variant="outline" onClick={onClose}>Close</Button>
          {(fd?.profile_url || item?.source_url || item?.application_url) && (
            <Button
              variant="outline"
              onClick={() => window.open(fd?.profile_url || item?.source_url || item?.application_url, "_blank", "noopener")}
            >
              <ExternalLink className="w-4 h-4 mr-2" /> View source
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value, emphasis }) {
  return (
    <div className={`rounded-lg p-3 ${emphasis ? "bg-emerald-50" : "bg-slate-50"}`}>
      <p className={`text-xs ${emphasis ? "text-emerald-600" : "text-slate-500"}`}>{label}</p>
      <p className={`text-lg font-bold ${emphasis ? "text-emerald-700" : ""}`}>{value}</p>
    </div>
  )
}
