import React, { useState, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { searchFoundations, getFoundation, searchNSF, searchFederalPrograms } from "@/api/foundations"
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
  ChevronLeft, ChevronRight,
} from "lucide-react"

const US_STATES = [
  "",  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI",
  "SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]

function formatCurrency(n) {
  if (n === null || !Number.isFinite(n)) return "N/A"
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString()}`
}

export default function FoundationSearch() {
  const [activeTab, setActiveTab] = useState("foundations")
  // Foundation search state
  const [fQuery, setFQuery] = useState("")
  const [fState, setFState] = useState("")
  const [fPage, setFPage] = useState(0)
  const [submittedF, setSubmittedF] = useState(null)
  // NSF search state
  const [nsfQuery, setNsfQuery] = useState("")
  const [nsfState, setNsfState] = useState("")
  const [submittedNSF, setSubmittedNSF] = useState(null)
  // Federal search state
  const [fedQuery, setFedQuery] = useState("")
  const [submittedFed, setSubmittedFed] = useState(null)
  // Detail dialog
  const [selectedEin, setSelectedEin] = useState(null)

  // Foundation search
  const { data: fResults, isLoading: fLoading } = useQuery({
    queryKey: ["foundation-search", submittedF, fPage],
    queryFn: () => searchFoundations({ q: submittedF, state: fState || undefined, page: fPage }),
    enabled: Boolean(submittedF),
    staleTime: 120_000,
  })
  const fOrgs = useMemo(() => {
    const payload = fResults?.data ?? fResults ?? {}
    return Array.isArray(payload.organizations) ? payload.organizations : []
  }, [fResults])
  const fTotal = (fResults?.data ?? fResults)?.total_results ?? 0

  // NSF search
  const { data: nsfResults, isLoading: nsfLoading } = useQuery({
    queryKey: ["nsf-search", submittedNSF, nsfState],
    queryFn: () => searchNSF({ keyword: submittedNSF, state: nsfState || undefined }),
    enabled: Boolean(submittedNSF),
    staleTime: 120_000,
  })
  const nsfOpps = useMemo(() => {
    const payload = nsfResults?.data ?? nsfResults ?? {}
    return Array.isArray(payload.opportunities) ? payload.opportunities : []
  }, [nsfResults])

  // Federal search
  const { data: fedResults, isLoading: fedLoading } = useQuery({
    queryKey: ["federal-search", submittedFed],
    queryFn: () => searchFederalPrograms({ keyword: submittedFed }),
    enabled: Boolean(submittedFed),
    staleTime: 120_000,
  })
  const fedOpps = useMemo(() => {
    const payload = fedResults?.data ?? fedResults ?? {}
    return Array.isArray(payload.opportunities) ? payload.opportunities : []
  }, [fedResults])

  // Foundation detail
  const { data: detailResult, isLoading: detailLoading } = useQuery({
    queryKey: ["foundation-detail", selectedEin],
    queryFn: () => getFoundation(selectedEin),
    enabled: Boolean(selectedEin),
    staleTime: 300_000,
  })
  const detail = detailResult?.data ?? detailResult ?? null

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Database className="w-8 h-8" /> Foundation & Data Source Search
          </h1>
          <p className="text-slate-600 mt-2">
            Search 1.8M+ nonprofits with IRS 990 data, NSF awards, and federal assistance programs — free, no subscription required
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="foundations" className="flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Foundations & 990s
            </TabsTrigger>
            <TabsTrigger value="nsf" className="flex items-center gap-2">
              <Beaker className="w-4 h-4" /> NSF Awards
            </TabsTrigger>
            <TabsTrigger value="federal" className="flex items-center gap-2">
              <Landmark className="w-4 h-4" /> Federal Programs
            </TabsTrigger>
          </TabsList>

          {/* ── Foundations Tab ─────────────────────────────────────── */}
          <TabsContent value="foundations" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Search Foundations & Nonprofits</CardTitle>
                <CardDescription>
                  Powered by ProPublica Nonprofit Explorer — IRS 990 financial data for 1.8M+ organizations
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
                    onChange={(e) => setFState(e.target.value)}
                    className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                  >
                    <option value="">All States</option>
                    {US_STATES.filter(Boolean).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <Button type="submit" disabled={!fQuery.trim() || fLoading}>
                    {fLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                    Search
                  </Button>
                </form>
              </CardContent>
            </Card>

            {submittedF && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-600">
                    {fLoading ? "Searching..." : `${fTotal.toLocaleString()} results for "${submittedF}"`}
                  </p>
                  {fTotal > 0 && (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={fPage === 0} onClick={() => setFPage(p => p - 1)}>
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      <span className="text-sm text-slate-600">Page {fPage + 1}</span>
                      <Button size="sm" variant="outline" disabled={fOrgs.length < 25} onClick={() => setFPage(p => p + 1)}>
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                </div>
                {fOrgs.map((org) => (
                  <Card key={org.ein || org.name} className="hover:border-blue-200 transition-colors">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold text-slate-900">{org.name}</h3>
                            {org.ntee_code && (
                              <Badge variant="outline" className="text-xs">{org.ntee_code}</Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-3 text-sm text-slate-600">
                            {org.city && org.state && (
                              <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {org.city}, {org.state}</span>
                            )}
                            {org.income_amount !== null && (
                              <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Income: {formatCurrency(org.income_amount)}</span>
                            )}
                            {org.asset_amount !== null && (
                              <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" /> Assets: {formatCurrency(org.asset_amount)}</span>
                            )}
                            {org.grant_amount !== null && org.grant_amount > 0 && (
                              <span className="flex items-center gap-1 font-medium text-emerald-700"><DollarSign className="w-3 h-3" /> Grants Paid: {formatCurrency(org.grant_amount)}</span>
                            )}
                          </div>
                          {org.ein && (
                            <p className="text-xs text-slate-400 mt-1">EIN: {org.ein}</p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {org.ein && (
                            <Button size="sm" variant="outline" onClick={() => setSelectedEin(org.ein)}>
                              <FileText className="w-4 h-4 mr-1" /> 990 Data
                            </Button>
                          )}
                          {org.profile_url && (
                            <Button size="sm" variant="outline" onClick={() => window.open(org.profile_url, "_blank", "noopener")}>
                              <ExternalLink className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ── NSF Tab ──────────────────────────────────────────── */}
          <TabsContent value="nsf" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>NSF Awards Search</CardTitle>
                <CardDescription>
                  Search National Science Foundation funded awards — science, engineering, and education research
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
                    {US_STATES.filter(Boolean).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <Button type="submit" disabled={!nsfQuery.trim() || nsfLoading}>
                    {nsfLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                    Search
                  </Button>
                </form>
              </CardContent>
            </Card>

            {submittedNSF && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  {nsfLoading ? "Searching NSF..." : `${nsfOpps.length} awards for "${submittedNSF}"`}
                </p>
                {nsfOpps.map((opp, i) => (
                  <Card key={opp.source_id || i} className="hover:border-blue-200 transition-colors">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <h3 className="font-semibold text-slate-900 mb-1">{opp.title}</h3>
                          <p className="text-sm text-slate-600 mb-2">{opp.sponsor}</p>
                          {opp.description && (
                            <p className="text-sm text-slate-500 line-clamp-2">{opp.description}</p>
                          )}
                          <div className="flex flex-wrap gap-3 text-xs text-slate-500 mt-2">
                            {opp.amount_max !== null && (
                              <span className="font-medium text-emerald-700">{formatCurrency(opp.amount_max)}</span>
                            )}
                            {opp.state && opp.state !== "nationwide" && (
                              <span><MapPin className="w-3 h-3 inline" /> {opp.state}</span>
                            )}
                          </div>
                        </div>
                        {opp.source_url && (
                          <Button size="sm" variant="outline" onClick={() => window.open(opp.source_url, "_blank", "noopener")}>
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ── Federal Programs Tab ─────────────────────────────── */}
          <TabsContent value="federal" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Federal Assistance Programs (CFDA)</CardTitle>
                <CardDescription>
                  Search the full catalog of federal domestic assistance — every federal program that provides grants, loans, or services
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
                  <Button type="submit" disabled={!fedQuery.trim() || fedLoading}>
                    {fedLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                    Search
                  </Button>
                </form>
              </CardContent>
            </Card>

            {submittedFed && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  {fedLoading ? "Searching federal programs..." : `${fedOpps.length} programs for "${submittedFed}"`}
                </p>
                {fedOpps.map((opp, i) => (
                  <Card key={opp.source_id || i} className="hover:border-blue-200 transition-colors">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <h3 className="font-semibold text-slate-900 mb-1">{opp.title}</h3>
                          {opp.sponsor && <p className="text-sm text-slate-600 mb-1">{opp.sponsor}</p>}
                          {opp.description && (
                            <p className="text-sm text-slate-500 line-clamp-3 mb-2">{opp.description}</p>
                          )}
                          {opp.eligibility_bullets?.length > 0 && (
                            <div className="text-xs text-slate-500 space-y-0.5">
                              {opp.eligibility_bullets.slice(0, 2).map((b, j) => (
                                <p key={j} className="line-clamp-1">{b}</p>
                              ))}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-2 mt-2">
                            {opp.categories?.map((c) => (
                              <Badge key={c} variant="outline" className="text-xs capitalize">{c}</Badge>
                            ))}
                            {opp.amount_max !== null && (
                              <Badge variant="secondary" className="text-xs">{formatCurrency(opp.amount_max)}</Badge>
                            )}
                          </div>
                        </div>
                        {opp.source_url && (
                          <Button size="sm" variant="outline" onClick={() => window.open(opp.source_url, "_blank", "noopener")}>
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* ── Foundation Detail Dialog ────────────────────────────── */}
        <Dialog open={Boolean(selectedEin)} onOpenChange={(open) => !open && setSelectedEin(null)}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{detail?.name ?? "Foundation Details"}</DialogTitle>
              <DialogDescription>
                {detail?.ein ? `EIN: ${detail.ein}` : ""}{detail?.city && detail?.state ? ` | ${detail.city}, ${detail.state}` : ""}
              </DialogDescription>
            </DialogHeader>
            {detailLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : detail ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs text-slate-500">Total Revenue</p>
                    <p className="text-lg font-bold">{formatCurrency(detail.revenue_amount ?? detail.income_amount)}</p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs text-slate-500">Total Assets</p>
                    <p className="text-lg font-bold">{formatCurrency(detail.asset_amount)}</p>
                  </div>
                  <div className="bg-emerald-50 rounded-lg p-3">
                    <p className="text-xs text-emerald-600">Grants Paid</p>
                    <p className="text-lg font-bold text-emerald-700">{formatCurrency(detail.grant_amount)}</p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs text-slate-500">NTEE Code</p>
                    <p className="text-lg font-bold">{detail.ntee_code || "N/A"}</p>
                  </div>
                </div>

                {detail.filings?.length > 0 && (
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
                          {detail.filings.slice(0, 10).map((f, i) => (
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
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelectedEin(null)}>Close</Button>
              {detail?.profile_url && (
                <Button onClick={() => window.open(detail.profile_url, "_blank", "noopener")}>
                  <ExternalLink className="w-4 h-4 mr-2" /> View on ProPublica
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
