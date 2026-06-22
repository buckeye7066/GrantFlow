import React, { useState, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { getCalendarDeadlines } from "@/api/foundations"
import { getHamiltonCalendar } from "@/api/hamilton"
import HamiltonReadinessBanner from "@/components/hamilton/HamiltonReadinessBanner"
import client from "@/api/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertCircle, Calendar as CalendarIcon, ChevronLeft, ChevronRight,
  ExternalLink, Clock, Loader2,
} from "lucide-react"
import { format, differenceInDays, startOfMonth, endOfMonth, eachDayOfInterval,
  getDay, isSameMonth, isToday, isSameDay, addMonths, subMonths } from "date-fns"
import { Link } from "react-router-dom"
import { createPageUrl } from "@/utils"
import ProfileSelect from "@/components/shared/ProfileSelect"

export default function Calendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectedDay, setSelectedDay] = useState(null)
  // Default to the "all" sentinel so the profile Select is controlled for its
  // entire lifecycle (never undefined → no uncontrolled→controlled warning).
  const [profileId, setProfileId] = useState("all")

  // "all" means no profile filter — translate it to undefined for queries.
  const effectiveProfileId = profileId && profileId !== "all" ? profileId : undefined

  const monthStr = format(currentMonth, "yyyy-MM")

  // Fetch deadlines from our new API
  const { data: calendarResult, isLoading: calLoading } = useQuery({
    queryKey: ["calendar-deadlines", monthStr, effectiveProfileId],
    queryFn: () => getCalendarDeadlines({ month: monthStr, profileId: effectiveProfileId }),
    staleTime: 60_000,
  })
  // Hamilton's scheduled application runs (profile-scoped) — folded into the
  // same calendar feed, each flagged when you may need to be available for 2FA.
  const { data: hamiltonResult } = useQuery({
    queryKey: ["hamilton-calendar", monthStr, effectiveProfileId],
    queryFn: () => getHamiltonCalendar({ month: monthStr, profileId: effectiveProfileId }),
    enabled: !!effectiveProfileId,
    staleTime: 60_000,
  })

  const apiCalEvents = useMemo(() => {
    const payload = calendarResult?.data ?? calendarResult ?? {}
    const deadlineEvents = Array.isArray(payload.events) ? payload.events : []
    const hPayload = hamiltonResult?.data ?? hamiltonResult ?? {}
    const hamiltonEvents = Array.isArray(hPayload.events) ? hPayload.events : []
    return [...deadlineEvents, ...hamiltonEvents]
  }, [calendarResult, hamiltonResult])

  // Also load grants from pipeline for the existing view
  const { data: grants = [] } = useQuery({
    queryKey: ["grants"],
    queryFn: () => client.entities.Grant.list(),
  })
  const { data: milestones = [] } = useQuery({
    queryKey: ["milestones"],
    queryFn: () => client.entities.Milestone.list(),
  })

  // Calendar grid
  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd })
  const startDayOfWeek = getDay(monthStart)

  const isValidDate = (ds) => ds && !isNaN(new Date(ds).getTime())

  // Parse a deadline to a LOCAL Date. A bare "YYYY-MM-DD" is otherwise parsed as
  // UTC midnight by `new Date()`, which renders as the previous calendar day in
  // negative-offset zones (US Eastern etc.) and lands the marker on the wrong /
  // empty grid cell. Build it from local Y/M/D so it matches `format(day, ...)`.
  const toLocalDate = (ds) => {
    if (!ds) return null
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ds).trim())
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const d = new Date(ds)
    return isNaN(d.getTime()) ? null : d
  }

  // Pipeline grant deadlines (the dataset that actually has data). This is the
  // single source of truth for BOTH the "Pipeline Deadlines" list and the
  // "Upcoming (30 Days)" widget / calendar grid, so they can never diverge.
  const upcomingGrants = useMemo(() => grants
    .filter((g) => {
      if (!["discovered", "interested", "drafting"].includes(g.status)) return false
      if (!g.deadline || String(g.deadline).toLowerCase() === "rolling" || !isValidDate(g.deadline)) return false
      return new Date(g.deadline) >= new Date(new Date().setHours(0, 0, 0, 0))
    })
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline)), [grants])

  // Normalise pipeline grants into the calendar-event shape and merge with the
  // API feed (catalog + Hamilton runs), deduped by id. Both panels and the grid
  // now read from this one combined list.
  const calEvents = useMemo(() => {
    const seen = new Set()
    const merged = []
    for (const g of upcomingGrants) {
      const id = `grant:${g.id}`
      seen.add(id)
      merged.push({
        id,
        title: g.title,
        sponsor: g.funder,
        deadline: g.deadline,
        amount_max: g.amount_max,
        application_url: g.application_url,
        source_url: g.source_url,
        grant_id: g.id,
        calendar_source: "pipeline",
      })
    }
    for (const ev of apiCalEvents) {
      // Avoid double-listing a pipeline grant that the API also returned.
      const key = ev.grant_id ? `grant:${ev.grant_id}` : `api:${ev.id}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(ev)
    }
    return merged
  }, [upcomingGrants, apiCalEvents])

  // Map deadlines to local-date day keys. Normalise via the local calendar date
  // (NOT a raw ISO string split) so timezone offsets can't push an event onto
  // the wrong/empty day key vs. the grid's `format(day, "yyyy-MM-dd")`.
  const deadlinesByDay = useMemo(() => {
    const map = {}
    for (const ev of calEvents) {
      const d = toLocalDate(ev.deadline)
      if (!d) continue
      const day = format(d, "yyyy-MM-dd")
      if (!map[day]) map[day] = []
      map[day].push(ev)
    }
    return map
  }, [calEvents])

  // Upcoming deadlines (next 30 days, from all sources). Inclusive on both
  // bounds; compare against start-of-today so a deadline "due today" (diff 0,
  // possibly with a time-of-day component) is never truncated out of the window.
  const upcoming = useMemo(() => {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0))
    return calEvents
      .filter((e) => {
        const d = toLocalDate(e.deadline)
        if (!d) return false
        const diff = differenceInDays(d, todayStart)
        return diff >= 0 && diff <= 30
      })
      .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))
      .slice(0, 20)
  }, [calEvents])

  // Events for selected day
  const selectedDayEvents = useMemo(() => {
    if (!selectedDay) return []
    const key = format(selectedDay, "yyyy-MM-dd")
    return deadlinesByDay[key] || []
  }, [selectedDay, deadlinesByDay])

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">Grant Calendar</h1>
            <p className="text-slate-600">Track all deadlines across your pipeline and the funding catalog</p>
          </div>
          <div className="w-64">
            <ProfileSelect
              value={profileId}
              onValueChange={setProfileId}
              showAllOption
              placeholder="All profiles"
            />
          </div>
        </div>

        {effectiveProfileId ? <HamiltonReadinessBanner profileId={effectiveProfileId} /> : null}

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Calendar Grid */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => setCurrentMonth((m) => subMonths(m, 1))}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <CardTitle className="text-lg">{format(currentMonth, "MMMM yyyy")}</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setCurrentMonth((m) => addMonths(m, 1))}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {calLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-7 gap-px mb-1">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                      <div key={d} className="text-center text-xs font-medium text-slate-500 py-1">{d}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-px bg-slate-200 rounded-lg overflow-hidden">
                    {/* Empty cells for start offset */}
                    {Array.from({ length: startDayOfWeek }).map((_, i) => (
                      <div key={`empty-${i}`} className="bg-slate-50 min-h-[80px] p-1" />
                    ))}
                    {daysInMonth.map((day) => {
                      const key = format(day, "yyyy-MM-dd")
                      const events = deadlinesByDay[key] || []
                      const hasEvents = events.length > 0
                      const isSelected = selectedDay && isSameDay(day, selectedDay)
                      const today = isToday(day)
                      return (
                        <button
                          key={key}
                          onClick={() => setSelectedDay(day)}
                          className={`min-h-[80px] p-1 text-left transition-colors ${
                            isSelected
                              ? "bg-blue-50 ring-2 ring-blue-500"
                              : today
                                ? "bg-amber-50"
                                : "bg-white hover:bg-slate-50"
                          }`}
                        >
                          <span className={`text-sm font-medium ${today ? "text-amber-700" : "text-slate-700"}`}>
                            {format(day, "d")}
                          </span>
                          {hasEvents && (
                            <div className="mt-0.5 space-y-0.5">
                              {events.slice(0, 3).map((ev, i) => (
                                <div
                                  key={i}
                                  className={`text-[10px] leading-tight truncate rounded px-1 ${
                                    ev.calendar_source === "hamilton_run"
                                      ? (ev.requires_presence ? "bg-amber-200 text-amber-900" : "bg-violet-100 text-violet-800")
                                      : ev.calendar_source === "pipeline"
                                        ? "bg-blue-100 text-blue-800"
                                        : "bg-emerald-100 text-emerald-800"
                                  }`}
                                  title={ev.calendar_source === "hamilton_run" ? ev.detail : undefined}
                                >
                                  {ev.calendar_source === "hamilton_run"
                                    ? `${ev.requires_presence ? "⚠ " : "🤖 "}${ev.title?.slice(0, 18)}`
                                    : ev.title?.slice(0, 20)}
                                </div>
                              ))}
                              {events.length > 3 && (
                                <div className="text-[10px] text-slate-500">+{events.length - 3} more</div>
                              )}
                            </div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Selected day detail */}
              {selectedDay && selectedDayEvents.length > 0 && (
                <div className="mt-4 border-t pt-4 space-y-2">
                  <h4 className="font-semibold text-sm text-slate-700">
                    {format(selectedDay, "MMMM d, yyyy")} — {selectedDayEvents.length} deadline{selectedDayEvents.length === 1 ? "" : "s"}
                  </h4>
                  {selectedDayEvents.map((ev, i) => (
                    <div key={i} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg text-sm">
                      <div className="flex-1">
                        <p className="font-medium text-slate-900">{ev.title}</p>
                        <p className="text-xs text-slate-500">{ev.sponsor} {ev.amount_max ? `| ${formatCurrency(ev.amount_max)}` : ""}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={ev.calendar_source === "pipeline" ? "default" : "outline"} className="text-xs">
                          {ev.calendar_source === "pipeline" ? "Pipeline" : "Catalog"}
                        </Badge>
                        {(ev.application_url || ev.source_url) && (
                          <Button size="sm" variant="ghost" onClick={() => window.open(ev.application_url || ev.source_url, "_blank", "noopener")}>
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Upcoming Deadlines Sidebar */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                  Upcoming (30 Days)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {upcoming.length === 0 ? (
                  <p className="text-sm text-slate-500 italic py-4 text-center">No upcoming deadlines</p>
                ) : (
                  upcoming.map((ev, i) => {
                    const evDate = toLocalDate(ev.deadline)
                    const daysLeft = Math.max(0, differenceInDays(evDate, new Date(new Date().setHours(0, 0, 0, 0))))
                    return (
                      <div key={i} className="flex items-start gap-2 p-2 bg-slate-50 rounded-lg">
                        <Clock className={`w-4 h-4 mt-0.5 flex-shrink-0 ${daysLeft <= 7 ? "text-red-500" : "text-slate-400"}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{ev.title}</p>
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span>{format(evDate, "MMM d")}</span>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${daysLeft <= 7 ? "border-red-300 text-red-700" : ""}`}
                            >
                              {daysLeft}d left
                            </Badge>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </CardContent>
            </Card>

            {/* Pipeline deadlines (existing) */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarIcon className="w-5 h-5 text-blue-500" />
                  Pipeline Deadlines
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {upcomingGrants.length === 0 ? (
                  <p className="text-sm text-slate-500 italic py-4 text-center">No pipeline deadlines</p>
                ) : (
                  upcomingGrants.slice(0, 10).map((grant) => {
                    const daysLeft = Math.max(0, differenceInDays(toLocalDate(grant.deadline), new Date(new Date().setHours(0, 0, 0, 0))))
                    return (
                      <Link key={grant.id} to={createPageUrl("GrantDetail", { id: grant.id })}>
                        <div className="flex items-start gap-2 p-2 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-900 truncate">{grant.title}</p>
                            <p className="text-xs text-slate-500">{grant.funder}</p>
                          </div>
                          <Badge variant="outline" className={`text-xs shrink-0 ${daysLeft <= 14 ? "border-red-300 text-red-700" : ""}`}>
                            {daysLeft}d
                          </Badge>
                        </div>
                      </Link>
                    )
                  })
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatCurrency(n) {
  if (n === null || !Number.isFinite(n)) return ""
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString()}`
}
