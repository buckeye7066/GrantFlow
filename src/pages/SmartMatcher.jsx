import React, { useMemo, useState } from "react"
import { Sparkles, Search, Filter, SlidersHorizontal, Star, TrendingUp, Award } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import ProfileSelect from "@/components/shared/ProfileSelect"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"

export default function SmartMatcher() {
  const [selectedProfileId, setSelectedProfileId] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [minScore, setMinScore] = useState(50)
  const [selectedOpp, setSelectedOpp] = useState(null)
  const { toast } = useToast()

  const { data: scoredResponse, isLoading: isScoring } = useQuery({
    queryKey: ['smart-matcher', selectedProfileId, minScore, searchQuery],
    queryFn: async () => {
      if (!selectedProfileId || selectedProfileId === 'all') {
        return { opportunities: [], total_scored: 0, returned: 0 }
      }
      const qs = new URLSearchParams()
      qs.set('min_score', String(minScore))
      qs.set('limit', '500')
      qs.set('skip_readiness_check', '1')
      if (searchQuery?.trim()) qs.set('q', searchQuery.trim())
      return await apiFetch(`/api/matching/profile/${selectedProfileId}/opportunities?${qs.toString()}`)
    },
    enabled: Boolean(selectedProfileId) && selectedProfileId !== 'all',
    staleTime: 60_000,
  })

  const scoredOpportunities = useMemo(() => {
    const payload = scoredResponse?.data ?? scoredResponse ?? {}
    const rows = payload?.opportunities ?? []
    return Array.isArray(rows) ? rows : []
  }, [scoredResponse])

  // Filter and sort
  const filteredOpportunities = useMemo(() => {
    // Already filtered server-side by q + min_score.
    return [...scoredOpportunities].sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
  }, [scoredOpportunities])

  const topMatches = filteredOpportunities.slice(0, 10)
  const goodMatches = filteredOpportunities.filter(o => (o.match_score ?? 0) >= 70 && (o.match_score ?? 0) < 85)
  const allQualified = filteredOpportunities

  const handleOpenOpp = (opp) => {
    setSelectedOpp(opp)
  }

  const handleOpenLink = () => {
    const url = selectedOpp?.application_url ?? selectedOpp?.source_url ?? selectedOpp?.url ?? null
    if (!url || typeof url !== 'string') {
      toast({
        title: 'No application link available',
        description: 'This opportunity does not include a valid URL yet.',
        variant: 'destructive',
      })
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Sparkles className="w-8 h-8" />
            Smart Matcher
          </h1>
          <p className="text-slate-600 mt-2">
            AI-powered opportunity matching based on your profile
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Match Configuration</CardTitle>
            <CardDescription>Select a profile and adjust matching criteria</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Profile</Label>
              <ProfileSelect
                value={selectedProfileId}
                onValueChange={setSelectedProfileId}
                placeholder="Select a profile to match..."
              />
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label>Search Keywords</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Filter by keyword..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              <div>
                <Label>Minimum Match Score</Label>
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-slate-400" />
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={minScore}
                    onChange={(e) => setMinScore(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="text-sm font-medium w-12 text-right">{minScore}%</span>
                </div>
              </div>
            </div>

            {selectedProfileId && selectedProfileId !== 'all' && (
              <div className="text-xs text-slate-600">
                {isScoring ? 'Scoring opportunities using full profile data…' : `Showing ${filteredOpportunities.length} matches (server-scored)`}
              </div>
            )}
          </CardContent>
        </Card>

        {!selectedProfileId || selectedProfileId === 'all' ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Star className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Select a Profile</h3>
              <p className="text-slate-600">Choose a profile above to see matched opportunities</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid md:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                    <Award className="w-4 h-4" />
                    Top Matches
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{topMatches.length}</div>
                  <p className="text-xs text-slate-600 mt-1">85%+ match score</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    Good Matches
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{goodMatches.length}</div>
                  <p className="text-xs text-slate-600 mt-1">70-84% match score</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                    <Filter className="w-4 h-4" />
                    All Qualified
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{allQualified.length}</div>
                  <p className="text-xs text-slate-600 mt-1">{minScore}%+ match score</p>
                </CardContent>
              </Card>
            </div>

            <Tabs defaultValue="top" className="space-y-4">
              <TabsList>
                <TabsTrigger value="top">Top Matches</TabsTrigger>
                <TabsTrigger value="all">All Matches</TabsTrigger>
              </TabsList>

              <TabsContent value="top" className="space-y-4">
                {topMatches.length > 0 ? (
                  <div className="space-y-3">
                    {topMatches.map((opp) => (
                      <Card key={opp.id} className="border-2 hover:border-blue-200 transition-colors">
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                <h3 className="font-semibold text-slate-900">{opp.title}</h3>
                                <Badge variant="default" className="bg-green-600">
                                  {opp.match_score ?? 0}% Match
                                </Badge>
                              </div>
                              <p className="text-sm text-slate-600 mb-2 line-clamp-2">{opp.description}</p>
                              <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                                {opp.sponsor && <span>• {opp.sponsor}</span>}
                                {opp.state && <span>• {opp.state}</span>}
                                {opp.deadline && <span>• Due: {opp.deadline}</span>}
                              </div>
                              {opp.match_reasons && opp.match_reasons.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {opp.match_reasons.slice(0, 6).map((reason, i) => (
                                    <Badge key={i} variant="secondary" className="text-xs">
                                      {reason}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                            <Button size="sm" onClick={() => handleOpenOpp(opp)}>View</Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Card>
                    <CardContent className="p-12 text-center">
                      <p className="text-slate-600">No top matches found. Try adjusting your criteria.</p>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="all" className="space-y-4">
                {filteredOpportunities.length > 0 ? (
                  <div className="space-y-3">
                    {filteredOpportunities.map((opp) => (
                      <Card key={opp.id} className="hover:border-slate-300 transition-colors">
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                <h3 className="font-semibold text-slate-900">{opp.title}</h3>
                                <Badge variant={(opp.match_score ?? 0) >= 85 ? "default" : "secondary"}>
                                  {opp.match_score ?? 0}%
                                </Badge>
                              </div>
                              <p className="text-sm text-slate-600 mb-2 line-clamp-2">{opp.description}</p>
                              <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                                {opp.sponsor && <span>• {opp.sponsor}</span>}
                                {opp.state && <span>• {opp.state}</span>}
                                {opp.deadline && <span>• Due: {opp.deadline}</span>}
                              </div>
                            </div>
                            <Button size="sm" variant="outline" onClick={() => handleOpenOpp(opp)}>View</Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Card>
                    <CardContent className="p-12 text-center">
                      <p className="text-slate-600">No matches found. Try lowering the minimum score or adjusting keywords.</p>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}

        <Dialog open={Boolean(selectedOpp)} onOpenChange={(open) => !open && setSelectedOpp(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{selectedOpp?.title ?? 'Opportunity'}</DialogTitle>
              <DialogDescription>
                {(selectedOpp?.sponsor || selectedOpp?.state || selectedOpp?.deadline)
                  ? [
                      selectedOpp?.sponsor ? `Sponsor: ${selectedOpp.sponsor}` : null,
                      selectedOpp?.state ? `State: ${selectedOpp.state}` : null,
                      selectedOpp?.deadline ? `Deadline: ${selectedOpp.deadline}` : null,
                    ].filter(Boolean).join(' • ')
                  : 'Details'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {selectedOpp?.description && (
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{selectedOpp.description}</div>
              )}

              {Array.isArray(selectedOpp?.match_reasons) && selectedOpp.match_reasons.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-slate-900">Why this matched</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedOpp.match_reasons.map((reason, idx) => (
                      <Badge key={idx} variant="secondary" className="text-xs">
                        {reason}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setSelectedOpp(null)}>
                Close
              </Button>
              <Button onClick={handleOpenLink}>Open link</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
