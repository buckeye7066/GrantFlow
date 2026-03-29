import React, { useMemo, useState, useCallback, useEffect } from "react"
import { Sparkles, Search, Filter, SlidersHorizontal, Star, TrendingUp, Award, Plus, X, CheckSquare, Target, Loader2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Checkbox } from "@/components/ui/checkbox"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { getItemSuggestions } from "@/api/items"
import ProfileSelect from "@/components/shared/ProfileSelect"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"

// ---------------------------------------------------------------------------
// Persistent checklist helpers – stored in localStorage keyed per profile
// ---------------------------------------------------------------------------
const CHECKLIST_STORAGE_PREFIX = "grantflow:matcher-checklist:"

// ---------------------------------------------------------------------------
// Persistent needs helpers – stored in localStorage keyed per profile
// ---------------------------------------------------------------------------
const NEEDS_STORAGE_PREFIX = "grantflow:matcher-needs:"

function loadNeeds(profileId) {
    if (!profileId) return { checked: {}, customItems: [] }
    try {
        const raw = localStorage.getItem(NEEDS_STORAGE_PREFIX + profileId)
        if (!raw) return { checked: {}, customItems: [] }
        const parsed = JSON.parse(raw)
        return {
            checked: parsed.checked && typeof parsed.checked === "object" ? parsed.checked : {},
            customItems: Array.isArray(parsed.customItems) ? parsed.customItems : [],
        }
    } catch {
        return { checked: {}, customItems: [] }
    }
}

function saveNeeds(profileId, state) {
    if (!profileId) return
    try {
        localStorage.setItem(NEEDS_STORAGE_PREFIX + profileId, JSON.stringify(state))
    } catch { /* ignore quota errors */ }
}

function loadChecklist(profileId) {
    if (!profileId) return { checked: {}, customItems: [] }
        try {
              const raw = localStorage.getItem(CHECKLIST_STORAGE_PREFIX + profileId)
              if (!raw) return { checked: {}, customItems: [] }
                    const parsed = JSON.parse(raw)
              return {
                      checked: parsed.checked && typeof parsed.checked === "object" ? parsed.checked : {},
                      customItems: Array.isArray(parsed.customItems) ? parsed.customItems : [],
              }
        } catch {
              return { checked: {}, customItems: [] }
        }
}

function saveChecklist(profileId, state) {
    if (!profileId) return
    try {
          localStorage.setItem(CHECKLIST_STORAGE_PREFIX + profileId, JSON.stringify(state))
    } catch { /* ignore quota errors */ }
}

// Default checklist items that every profile should consider
const DEFAULT_CHECKLIST_ITEMS = [
  { id: "profile_type", label: "Profile type is set" },
  { id: "state_zip", label: "State / ZIP code added" },
  { id: "primary_goal", label: "Primary goal or need category defined" },
  { id: "demographics", label: "Demographics section completed" },
  { id: "org_details", label: "Organization details filled in (if applicable)" },
  { id: "budget_range", label: "Budget range or funding amount specified" },
  { id: "documents", label: "Supporting documents uploaded" },
  ]

export default function SmartMatcher() {
    const [selectedProfileId, setSelectedProfileId] = useState("")
    const [searchQuery, setSearchQuery] = useState("")
    const [minScore, setMinScore] = useState(50)
    const [selectedOpp, setSelectedOpp] = useState(null)
    const { toast } = useToast()
    const queryClient = useQueryClient()
    const [isSearchingNeeds, setIsSearchingNeeds] = useState(false)

  // -- Persistent checklist state per profile --
  const [checklistState, setChecklistState] = useState({ checked: {}, customItems: [] })
    const [newItemText, setNewItemText] = useState("")

  // Load checklist when profile changes
  useEffect(() => {
        setChecklistState(loadChecklist(selectedProfileId))
  }, [selectedProfileId])

  // Persist checklist whenever it changes
  useEffect(() => {
        saveChecklist(selectedProfileId, checklistState)
  }, [selectedProfileId, checklistState])

  // -- Persistent needs state per profile --
  const [needsState, setNeedsState] = useState({ checked: {}, customItems: [] })
  const [newNeedText, setNewNeedText] = useState("")

  // Load needs when profile changes
  useEffect(() => {
        setNeedsState(loadNeeds(selectedProfileId))
  }, [selectedProfileId])

  // Persist needs whenever they change
  useEffect(() => {
        saveNeeds(selectedProfileId, needsState)
  }, [selectedProfileId, needsState])

  const toggleChecklistItem = useCallback((itemId) => {
        setChecklistState((prev) => ({
                ...prev,
                checked: { ...prev.checked, [itemId]: !prev.checked[itemId] },
        }))
  }, [])

  const addCustomItem = useCallback(() => {
        const text = newItemText.trim()
        if (!text) return
        const id = "custom_" + Date.now()
        setChecklistState((prev) => ({
                ...prev,
                customItems: [...prev.customItems, { id, label: text }],
        }))
        setNewItemText("")
  }, [newItemText])

  const removeCustomItem = useCallback((itemId) => {
        setChecklistState((prev) => ({
                ...prev,
                customItems: prev.customItems.filter((i) => i.id !== itemId),
                checked: (() => { const c = { ...prev.checked }; delete c[itemId]; return c })(),
        }))
  }, [])

  const allChecklistItems = useMemo(
        () => [...DEFAULT_CHECKLIST_ITEMS, ...checklistState.customItems],
        [checklistState.customItems],
      )

  const checkedCount = useMemo(
        () => allChecklistItems.filter((i) => checklistState.checked[i.id]).length,
        [allChecklistItems, checklistState.checked],
      )

  // -- Needs handlers --
  const toggleNeed = useCallback((needId) => {
        setNeedsState((prev) => ({
                ...prev,
                checked: { ...prev.checked, [needId]: !prev.checked[needId] },
        }))
  }, [])

  const addCustomNeed = useCallback(() => {
        const text = newNeedText.trim()
        if (!text) return
        const id = "need_custom_" + Date.now()
        setNeedsState((prev) => ({
                ...prev,
                customItems: [...prev.customItems, { id, name: text, category: "custom" }],
        }))
        setNewNeedText("")
  }, [newNeedText])

  const removeCustomNeed = useCallback((needId) => {
        setNeedsState((prev) => ({
                ...prev,
                customItems: prev.customItems.filter((i) => i.id !== needId),
                checked: (() => { const c = { ...prev.checked }; delete c[needId]; return c })(),
        }))
  }, [])

  // -- Item suggestions (inferred needs) --
  const { data: suggestionsResponse, isLoading: isSuggestionsLoading } = useQuery({
        queryKey: ['item-suggestions', selectedProfileId],
        queryFn: () => getItemSuggestions({ profileId: selectedProfileId }),
        enabled: Boolean(selectedProfileId) && selectedProfileId !== 'all',
        staleTime: 300_000,
  })

  const inferredNeeds = useMemo(() => {
        const payload = suggestionsResponse?.data ?? suggestionsResponse ?? {}
        const suggestions = payload?.suggestions ?? []
        return Array.isArray(suggestions) ? suggestions : []
  }, [suggestionsResponse])

  const handleSearchNeeds = useCallback(() => {
        const checkedInferred = inferredNeeds
                .filter((s) => needsState.checked[s.name])
                .map((s) => s.name)
        const checkedCustom = needsState.customItems
                .filter((i) => needsState.checked[i.id])
                .map((i) => i.name)
        const allChecked = [...checkedInferred, ...checkedCustom]
        if (allChecked.length === 0) return

        const query = allChecked.join(" ")
        setSearchQuery(query)
        setIsSearchingNeeds(true)

        // Force refetch even if keywords haven't changed
        queryClient.invalidateQueries({ queryKey: ["smart-matcher"] })

        // Toast feedback
        toast({ title: `Searching ${allChecked.length} selected need${allChecked.length === 1 ? "" : "s"}...` })
  }, [inferredNeeds, needsState, setSearchQuery, queryClient, toast])

  // -- Matching data --
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

  useEffect(() => {
        if (!isScoring && isSearchingNeeds) {
                setIsSearchingNeeds(false)
                document.getElementById("match-results")?.scrollIntoView({ behavior: "smooth" })
        }
  }, [isScoring, isSearchingNeeds])

  const scoredOpportunities = useMemo(() => {
        const payload = scoredResponse?.data ?? scoredResponse ?? {}
              const rows = payload?.opportunities ?? []
                    return Array.isArray(rows) ? rows : []
  }, [scoredResponse])

  const filteredOpportunities = useMemo(() => {
        return [...scoredOpportunities].sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
  }, [scoredOpportunities])

  const topMatches = filteredOpportunities.slice(0, 10)
    const goodMatches = filteredOpportunities.filter(o => (o.match_score ?? 0) >= 70 && (o.match_score ?? 0) < 85)
    const allQualified = filteredOpportunities

  const handleOpenOpp = (opp) => { setSelectedOpp(opp) }

  const handleOpenLink = () => {
        const url = selectedOpp?.application_url ?? selectedOpp?.source_url ?? selectedOpp?.url ?? null
        if (!url || typeof url !== 'string') {
                toast({ title: 'No application link available', description: 'This opportunity does not include a valid URL yet.', variant: 'destructive' })
                return
        }
        window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
        <div className="p-6 md:p-8">
              <div className="max-w-7xl mx-auto space-y-6">
                      <div>
                                <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
                                            <Sparkles className="w-8 h-8" /> Smart Matcher
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
                                                                                                                  type="range" min="0" max="100"
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
                          {isScoring ? 'Scoring opportunities using full profile data\u2026' : `Showing ${filteredOpportunities.length} matches (server-scored)`}
                        </div>
                                            )}
                                </CardContent>
                      </Card>
              
                {/* ----------------------------------------------------------------- */}
                {/* Search by Profile Needs – inferred needs checklist              */}
                {/* ----------------------------------------------------------------- */}
                {selectedProfileId && selectedProfileId !== 'all' && (
                    <Card>
                                <CardHeader className="pb-3">
                                              <CardTitle className="flex items-center gap-2 text-lg">
                                                              <Target className="w-5 h-5 text-blue-600" />
                                                              Search by Profile Needs
                                              </CardTitle>
                                              <CardDescription>
                                                              Select inferred needs to build a search query, or add your own.
                                              </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                  {isSuggestionsLoading ? (
                                      <div className="space-y-2">
                                          {[1, 2, 3].map((n) => (
                                              <div key={n} className="h-6 bg-slate-100 rounded animate-pulse" />
                                          ))}
                                      </div>
                                  ) : inferredNeeds.length === 0 && needsState.customItems.length === 0 ? (
                                      <p className="text-sm text-slate-500 italic">No inferred needs for this profile.</p>
                                  ) : (
                                      <>
                                          {inferredNeeds.map((suggestion) => (
                                              <div key={suggestion.name} className="flex items-center gap-3">
                                                  <Checkbox
                                                      id={`need-${suggestion.name}`}
                                                      checked={!!needsState.checked[suggestion.name]}
                                                      onCheckedChange={() => toggleNeed(suggestion.name)}
                                                  />
                                                  <label
                                                      htmlFor={`need-${suggestion.name}`}
                                                      className={`flex-1 text-sm cursor-pointer select-none ${needsState.checked[suggestion.name] ? "line-through text-slate-400" : "text-slate-700"}`}
                                                  >
                                                      {suggestion.name}
                                                  </label>
                                                  {suggestion.category && (
                                                      <Badge variant="outline" className="text-xs capitalize">
                                                          {suggestion.category.replace(/_/g, " ")}
                                                      </Badge>
                                                  )}
                                              </div>
                                          ))}
                                          {needsState.customItems.map((item) => (
                                              <div key={item.id} className="flex items-center gap-3 group">
                                                  <Checkbox
                                                      id={`need-${item.id}`}
                                                      checked={!!needsState.checked[item.id]}
                                                      onCheckedChange={() => toggleNeed(item.id)}
                                                  />
                                                  <label
                                                      htmlFor={`need-${item.id}`}
                                                      className={`flex-1 text-sm cursor-pointer select-none ${needsState.checked[item.id] ? "line-through text-slate-400" : "text-slate-700"}`}
                                                  >
                                                      {item.name}
                                                  </label>
                                                  <button
                                                      type="button"
                                                      onClick={() => removeCustomNeed(item.id)}
                                                      className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-500"
                                                      title="Remove custom need"
                                                  >
                                                      <X className="w-4 h-4" />
                                                  </button>
                                              </div>
                                          ))}
                                      </>
                                  )}

                                  {/* Add custom need */}
                                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                                      <Plus className="w-4 h-4 text-slate-400 shrink-0" />
                                      <Input
                                          placeholder="Add a custom need…"
                                          value={newNeedText}
                                          onChange={(e) => setNewNeedText(e.target.value)}
                                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomNeed() } }}
                                          className="h-8 text-sm"
                                      />
                                      <Button size="sm" variant="outline" onClick={addCustomNeed} disabled={!newNeedText.trim()}>
                                          Add
                                      </Button>
                                  </div>

                                  {/* Search button */}
                                  <div className="pt-2">
                                      <Button
                                          type="button"
                                          className="w-full"
                                          onClick={handleSearchNeeds}
                                          disabled={
                                              isSearchingNeeds ||
                                              ![...inferredNeeds.map((s) => s.name), ...needsState.customItems.map((i) => i.id)]
                                                  .some((id) => needsState.checked[id])
                                          }
                                      >
                                          {isSearchingNeeds ? (
                                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                          ) : (
                                              <Search className="w-4 h-4 mr-2" />
                                          )}
                                          Search Selected Needs
                                      </Button>
                                  </div>
                                </CardContent>
                    </Card>
                )}

                {/* ----------------------------------------------------------------- */}
                {/* Profile Matching Checklist – persistent per profile               */}
                {/* ----------------------------------------------------------------- */}
                {selectedProfileId && selectedProfileId !== 'all' && (
                    <Card>
                                <CardHeader className="pb-3">
                                              <CardTitle className="flex items-center gap-2 text-lg">
                                                              <CheckSquare className="w-5 h-5 text-emerald-600" />
                                                              Profile Matching Checklist
                                                              <Badge variant="outline" className="ml-auto text-sm">
                                                                {checkedCount}/{allChecklistItems.length}
                                                              </Badge>
                                              </CardTitle>
                                              <CardDescription>
                                                              Track items needed for strong matches. Your progress is saved automatically per profile.
                                              </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                  {allChecklistItems.map((item) => {
                                      const isCustom = item.id.startsWith("custom_")
                                                        return (
                                                                            <div key={item.id} className="flex items-center gap-3 group">
                                                                                                <Checkbox
                                                                                                                        id={`cl-${item.id}`}
                                                                                                                        checked={!!checklistState.checked[item.id]}
                                                                                                                        onCheckedChange={() => toggleChecklistItem(item.id)}
                                                                                                                      />
                                                                                                <label
                                                                                                                        htmlFor={`cl-${item.id}`}
                                                                                                                        className={`flex-1 text-sm cursor-pointer select-none ${checklistState.checked[item.id] ? "line-through text-slate-400" : "text-slate-700"}`}
                                                                                                                      >
                                                                                                  {item.label}
                                                                                                  </label>
                                                                              {isCustom && (
                                                                                                    <button
                                                                                                                              type="button"
                                                                                                                              onClick={() => removeCustomItem(item.id)}
                                                                                                                              className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-500"
                                                                                                                              title="Remove custom item"
                                                                                                                            >
                                                                                                                            <X className="w-4 h-4" />
                                                                                                      </button>
                                                                                                )}
                                                                            </div>
                                                                          )
                                  })}
                                
                                  {/* Free-hand add item */}
                                              <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                                                              <Plus className="w-4 h-4 text-slate-400 shrink-0" />
                                                              <Input
                                                                                  placeholder="Add a custom checklist item\u2026"
                                                                                  value={newItemText}
                                                                                  onChange={(e) => setNewItemText(e.target.value)}
                                                                                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomItem() } }}
                                                                                  className="h-8 text-sm"
                                                                                />
                                                              <Button size="sm" variant="outline" onClick={addCustomItem} disabled={!newItemText.trim()}>
                                                                                Add
                                                              </Button>
                                              </div>
                                </CardContent>
                    </Card>
                      )}
              
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
                                <div id="match-results" className="grid md:grid-cols-3 gap-4">
                                              <Card>
                                                              <CardHeader className="pb-2">
                                                                                <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                                                                                                    <Award className="w-4 h-4" /> Top Matches
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
                                                                                                    <TrendingUp className="w-4 h-4" /> Good Matches
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
                                                                                                    <Filter className="w-4 h-4" /> All Qualified
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
                                                                                                                                                                                                            {opp.sponsor && <span>{"\u2022"} {opp.sponsor}</span>}
                                                                                                                                                                                                            {opp.state && <span>{"\u2022"} {opp.state}</span>}
                                                                                                                                                                                                            {opp.deadline && <span>{"\u2022"} Due: {opp.deadline}</span>}
                                                                                                                                                                                                          </div>
                                                                                                                                                {opp.match_reasons && opp.match_reasons.length > 0 && (
                                                                                                  <div className="mt-2 flex flex-wrap gap-1">
                                                                                                    {opp.match_reasons.slice(0, 6).map((reason, i) => (
                                                                                                                                        <Badge key={i} variant="secondary" className="text-xs">{reason}</Badge>
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
                                                                                                                                                                                                            {opp.sponsor && <span>{"\u2022"} {opp.sponsor}</span>}
                                                                                                                                                                                                            {opp.state && <span>{"\u2022"} {opp.state}</span>}
                                                                                                                                                                                                            {opp.deadline && <span>{"\u2022"} Due: {opp.deadline}</span>}
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
                                                                                                      ].filter(Boolean).join(' \u2022 ')
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
                                                  <Badge key={idx} variant="secondary" className="text-xs">{reason}</Badge>
                                                ))}
                                            </div>
                          </div>
                                                          )}
                                            </div>
                                            <DialogFooter>
                                                          <Button variant="outline" onClick={() => setSelectedOpp(null)}>Close</Button>
                                                          <Button onClick={handleOpenLink}>Open link</Button>
                                            </DialogFooter>
                                </DialogContent>
                      </Dialog>
              </div>
        </div>
      )
}
