import React, { useEffect, useMemo, useState } from "react"
import { AlertCircle, Globe2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"
import GeoCrawlMonitor from "@/components/admin/GeoCrawlMonitor.jsx"

const LS_LAST_RUN_ID = "gf_geo_crawl_last_run_id_v2"
const GEO_CRAWL_START_RETIRED = true

async function fetchStates() {
  return apiFetch("/api/admin/geo/states")
}

async function fetchStateZips(state) {
  return apiFetch(`/api/admin/geo/state/${state}/zips`)
}

async function fetchCounties(state) {
  return apiFetch(`/api/admin/geo/state/${state}/counties`)
}

async function indexCounties(state) {
  return apiFetch(`/api/admin/geo/state/${state}/index-counties`, { method: "POST" })
}

async function fetchGeoStatus() {
  return apiFetch("/api/admin/geo/crawl/status")
}

export default function AdminGeoCrawl() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [countyIndexNotice, setCountyIndexNotice] = useState("")
  const [states, setStates] = useState([])
  const [selectedState, setSelectedState] = useState("")
  const [zips, setZips] = useState([])
  const [counties, setCounties] = useState([])
  const [countySearch, setCountySearch] = useState("")
  const [zipSearch, setZipSearch] = useState("")
  const [citySearch, setCitySearch] = useState("")
  const [selectedZips, setSelectedZips] = useState(new Set())
  const [selectedCounties, setSelectedCounties] = useState(new Set())
  const [status, setStatus] = useState(null)
  const [activeRunId, setActiveRunId] = useState("")

  // Persist the most recent run id so the monitor survives refreshes.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LS_LAST_RUN_ID)
      if (saved) setActiveRunId(String(saved))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    let mounted = true
    setLoading(true)
    fetchStates()
      .then((res) => {
        if (!mounted) return
        setStates(res?.states ?? [])
      })
      .catch((err) => {
        toast({ title: "Failed to load states", description: err.message, variant: "destructive" })
      })
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [toast])

  useEffect(() => {
    if (!selectedState) return
    let mounted = true
    setLoading(true)
    Promise.all([fetchStateZips(selectedState), fetchCounties(selectedState), fetchGeoStatus()])
      .then(([zipRes, countyRes, statusRes]) => {
        if (!mounted) return
        setZips(zipRes?.zips ?? [])
        setCounties(countyRes?.counties ?? [])
        setStatus(statusRes ?? null)
        setCountyIndexNotice(
          countyRes?.available === false
            ? "County dataset isn’t configured on this deployment yet. Use ZIP/city scoping for now."
            : "",
        )
        // Reset local selection + filters when switching states to avoid mismatched selections.
        setSelectedZips(new Set())
        setSelectedCounties(new Set())
        setZipSearch("")
        setCitySearch("")
        setCountySearch("")
      })
      .catch((err) => {
        toast({ title: "Failed to load geo data", description: err.message, variant: "destructive" })
      })
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [selectedState, toast])

  useEffect(() => {
    let mounted = true
    const id = window.setInterval(() => {
      fetchGeoStatus()
        .then((res) => mounted && setStatus(res))
        .catch(() => {})
    }, 5000)
    return () => {
      mounted = false
      window.clearInterval(id)
    }
  }, [])

  const filteredZips = useMemo(() => {
    if (!zipSearch.trim()) return zips
    const q = zipSearch.trim().toLowerCase()
    return zips.filter((z) => String(z.zip_code).includes(q) || String(z.city || "").toLowerCase().includes(q))
  }, [zips, zipSearch])

  const cities = useMemo(() => {
    const byCity = new Map()
    ;(zips || []).forEach((z) => {
      const city = String(z.city || "").trim()
      if (!city) return
      const key = city.toLowerCase()
      if (!byCity.has(key)) {
        byCity.set(key, { city, state: z.state, zipCodes: new Set() })
      }
      byCity.get(key).zipCodes.add(z.zip_code)
    })

    return Array.from(byCity.values())
      .map((c) => ({ ...c, zipCodes: Array.from(c.zipCodes).sort() }))
      .sort((a, b) => a.city.localeCompare(b.city))
  }, [zips])

  const filteredCities = useMemo(() => {
    if (!citySearch.trim()) return cities
    const q = citySearch.trim().toLowerCase()
    return cities.filter((c) => c.city.toLowerCase().includes(q))
  }, [cities, citySearch])

  const majorCities = useMemo(() => {
    // "Major city" heuristic: cities with the most ZIP codes in this state.
    return [...cities]
      .sort((a, b) => (b.zipCodes?.length || 0) - (a.zipCodes?.length || 0))
      .slice(0, 30)
  }, [cities])

  const filteredCounties = useMemo(() => {
    if (!countySearch.trim()) return counties
    const q = countySearch.trim().toLowerCase()
    return (counties || []).filter((c) => String(c.county || "").toLowerCase().includes(q))
  }, [counties, countySearch])

  const toggleZip = (zip) => {
    setSelectedZips((prev) => {
      const next = new Set(prev)
      if (next.has(zip)) next.delete(zip)
      else next.add(zip)
      return next
    })
  }

  const toggleCounty = (county) => {
    setSelectedCounties((prev) => {
      const next = new Set(prev)
      if (next.has(county)) next.delete(county)
      else next.add(county)
      return next
    })
  }

  const selectAllFilteredCounties = () => {
    if (selectedZips.size > 0) return
    setSelectedCounties((prev) => {
      const next = new Set(prev)
      filteredCounties.forEach((c) => {
        if (c?.county) next.add(c.county)
      })
      return next
    })
  }

  const selectAllCountiesInState = () => {
    if (selectedZips.size > 0) return
    setSelectedCounties(() => {
      const next = new Set()
      ;(counties || []).forEach((c) => {
        if (c?.county) next.add(c.county)
      })
      return next
    })
  }

  const clearAllCounties = () => {
    setSelectedCounties(new Set())
  }

  const toggleCity = (cityObj) => {
    if (!cityObj?.zipCodes?.length) return
    setSelectedZips((prev) => {
      const next = new Set(prev)
      const allSelected = cityObj.zipCodes.every((z) => next.has(z))
      if (allSelected) {
        cityObj.zipCodes.forEach((z) => next.delete(z))
      } else {
        // Selecting any ZIPs disables county selection; clear counties to avoid mixed scope ambiguity.
        setSelectedCounties(new Set())
        cityObj.zipCodes.forEach((z) => next.add(z))
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelectedZips(new Set())
    setSelectedCounties(new Set())
  }

  const handleIndexCounties = async () => {
    if (!selectedState) return
    setLoading(true)
    try {
      const res = await indexCounties(selectedState)
      toast({
        title: "Counties indexed",
        description: res?.counties !== null ? `${res.counties} counties available for ${selectedState}.` : "Done.",
      })

      // Refresh county list immediately so the UI updates.
      const countyRes = await fetchCounties(selectedState)
      setCounties(countyRes?.counties ?? [])
      setCountyIndexNotice(
        countyRes?.available === false
          ? "County dataset isn’t configured on this deployment yet. Use ZIP/city scoping for now."
          : "",
      )
    } catch (err) {
      setCountyIndexNotice("County dataset isn’t configured on this deployment yet. Use ZIP/city scoping for now.")
      toast({ title: "Failed to start county indexing", description: err.message, variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-slate-900">
            <Globe2 className="w-5 h-5 text-blue-600" />
            Geo Crawl (State → ZIP)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              Historical Geo Crawl coverage remains available below. Starting the legacy global ZIP crawler is retired;
              current discovery runs through the profile-scoped Crawler OS so every match has an accountable profile context.
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>State</Label>
              <Select value={selectedState || undefined} onValueChange={(v) => setSelectedState(v ?? '')}>
                <SelectTrigger className="bg-white text-slate-900 border-slate-300 placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white">
                  <SelectValue placeholder={loading ? "Loading..." : "Select a state"} />
                </SelectTrigger>
                <SelectContent>
                  {states.map((s) => (
                    <SelectItem key={s.state} value={s.state}>
                      {s.state} ({s.zip_count.toLocaleString()} ZIPs)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 text-sm text-slate-700" role="status">
              <Label>Run availability</Label>
              <p>Historical coverage and prior run receipts remain readable.</p>
            </div>

            <div className="flex items-end gap-2">
              <Button
                variant="secondary"
                onClick={handleIndexCounties}
                disabled={!selectedState || loading}
                className="bg-slate-100 text-slate-900 hover:bg-slate-200 disabled:opacity-60 disabled:text-slate-700"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Index counties
              </Button>
              <Button
                variant="default"
                disabled={GEO_CRAWL_START_RETIRED}
                title="Legacy global ZIP crawl start is retired; use profile-scoped Crawler OS discovery."
                className="bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-700"
              >
                Crawl start retired
              </Button>
            </div>
          </div>

          {selectedState && !GEO_CRAWL_START_RETIRED ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-slate-900">Optional scope</p>
                  <p className="text-xs text-slate-600">
                    Leave empty to crawl the whole state. Counties: {selectedCounties.size.toLocaleString()} • ZIPs:{" "}
                    {selectedZips.size.toLocaleString()} (ZIPs override counties)
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearSelection}
                  disabled={selectedZips.size === 0 && selectedCounties.size === 0}
                >
                  Clear
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Counties (requires indexing)</Label>
                  {countyIndexNotice ? (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                      {countyIndexNotice}
                    </div>
                  ) : null}
                  <Input
                    placeholder="Search counties..."
                    value={countySearch}
                    onChange={(e) => setCountySearch(e.target.value)}
                    disabled={!counties?.length}
                    className="bg-white text-slate-900 border-slate-300 placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-60"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-slate-500">
                      {counties?.length ? `${filteredCounties.length.toLocaleString()} match(es)` : null}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={selectAllFilteredCounties}
                        disabled={!counties?.length || selectedZips.size > 0 || filteredCounties.length === 0}
                      >
                        Select shown
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={selectAllCountiesInState}
                        disabled={!counties?.length || selectedZips.size > 0}
                      >
                        Select all (state)
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={clearAllCounties}
                        disabled={selectedCounties.size === 0}
                      >
                        Clear counties
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-72 overflow-auto border rounded-md bg-white">
                    {!counties?.length ? (
                      <div className="p-3 text-xs text-slate-600">
                        No county data yet. Click <strong>Index counties</strong> to build ZIP→county mapping for this
                        state.
                      </div>
                    ) : (
                      filteredCounties.slice(0, 300).map((c) => {
                        const checked = selectedCounties.has(c.county)
                        return (
                          <label
                            key={c.county}
                            className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0 cursor-pointer hover:bg-slate-50"
                          >
                            <div className="flex items-center gap-3">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleCounty(c.county)}
                                disabled={selectedZips.size > 0}
                              />
                              <div className="flex flex-col">
                                <span className="font-medium text-slate-900">{c.county}</span>
                                {/* zip_count is not currently provided by the backend; keep UI clean. */}
                              </div>
                            </div>
                            <span className="text-xs text-slate-500">{selectedState}</span>
                          </label>
                        )
                      })
                    )}
                  </div>
                  {filteredCounties.length > 300 ? (
                    <div className="text-xs text-slate-500">Showing first 300 counties for performance.</div>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label>ZIP codes (optional)</Label>
                  <Input
                    placeholder="Search ZIP or city..."
                    value={zipSearch}
                    onChange={(e) => setZipSearch(e.target.value)}
                    className="bg-white text-slate-900 border-slate-300 placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                  />

                  <div className="space-y-2">
                    <Label className="text-xs text-slate-600">Cities (selecting a city selects all ZIPs in that city)</Label>
                    <div className="flex flex-wrap gap-2">
                      {majorCities.length ? (
                        majorCities.slice(0, 8).map((c) => (
                          <Button
                            key={`major-${selectedState}-${c.city}`}
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => toggleCity(c)}
                            disabled={!c.zipCodes?.length}
                          >
                            {c.city}
                          </Button>
                        ))
                      ) : (
                        <span className="text-xs text-slate-500">No major cities available for this state.</span>
                      )}
                    </div>
                    <Input
                      placeholder="Search city..."
                      value={citySearch}
                      onChange={(e) => setCitySearch(e.target.value)}
                      disabled={!cities.length}
                      className="bg-white text-slate-900 border-slate-300 placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-60"
                    />
                    <div className="max-h-40 overflow-auto border rounded-md bg-white">
                      {!cities.length ? (
                        <div className="p-3 text-xs text-slate-600">No city data available for this state.</div>
                      ) : (
                        filteredCities.slice(0, 200).map((c) => {
                          const checked = c.zipCodes.every((z) => selectedZips.has(z))
                          const partial = !checked && c.zipCodes.some((z) => selectedZips.has(z))
                          return (
                            <label
                              key={`${c.state || selectedState}-${c.city}`}
                              className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0 cursor-pointer hover:bg-slate-50"
                            >
                              <div className="flex items-center gap-3">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  ref={(el) => {
                                    if (el) el.indeterminate = partial
                                  }}
                                  onChange={() => toggleCity(c)}
                                />
                                <div className="flex flex-col">
                                  <span className="font-medium text-slate-900">{c.city}</span>
                                  <span className="text-xs text-slate-600">{c.zipCodes.length.toLocaleString()} ZIPs</span>
                                </div>
                              </div>
                              <span className="text-xs text-slate-500">{selectedState}</span>
                            </label>
                          )
                        })
                      )}
                    </div>
                    {filteredCities.length > 200 ? (
                      <div className="text-xs text-slate-500">Showing first 200 cities for performance.</div>
                    ) : null}
                  </div>

                  <div className="max-h-72 overflow-auto border rounded-md bg-white">
                    {filteredZips.slice(0, 500).map((z) => {
                      const checked = selectedZips.has(z.zip_code)
                      return (
                        <label
                          key={z.zip_code}
                          className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0 cursor-pointer hover:bg-slate-50"
                        >
                          <div className="flex items-center gap-3">
                            <input type="checkbox" checked={checked} onChange={() => toggleZip(z.zip_code)} />
                            <div className="flex flex-col">
                              <span className="font-medium text-slate-900">{z.zip_code}</span>
                              <span className="text-xs text-slate-600">{z.city || "Unknown city"}</span>
                            </div>
                          </div>
                          <span className="text-xs text-slate-500">{z.state}</span>
                        </label>
                      )
                    })}
                    {filteredZips.length > 500 ? (
                      <div className="p-2 text-xs text-slate-500">Showing first 500 matches for performance.</div>
                    ) : null}
                  </div>
                </div>
              </div>

            </div>
          ) : null}

          {status?.geo_index ? (
            <div className="text-xs text-slate-600">
              County index: {status.geo_index.status} • {status.geo_index.processed?.toLocaleString?.() ?? 0}/
              {status.geo_index.total?.toLocaleString?.() ?? 0} (state {status.geo_index.state})
            </div>
          ) : null}

          {status?.geo_crawl ? (
            <div className="text-xs text-slate-600">
              Geo crawl: {status.geo_crawl.status} • {status.geo_crawl.processed?.toLocaleString?.() ?? 0}/
              {status.geo_crawl.total_zips?.toLocaleString?.() ?? 0} • inserted{" "}
              {status.geo_crawl.inserted?.toLocaleString?.() ?? 0} • linked{" "}
              {status.geo_crawl.linked?.toLocaleString?.() ?? 0} • failed{" "}
              {status.geo_crawl.failed?.toLocaleString?.() ?? 0}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {activeRunId ? (
        <GeoCrawlMonitor
          runId={activeRunId}
          onStaleRun={() => {
            setActiveRunId("")
            try {
              window.localStorage.removeItem(LS_LAST_RUN_ID)
            } catch {
              // ignore
            }
          }}
        />
      ) : null}
    </div>
  )
}
