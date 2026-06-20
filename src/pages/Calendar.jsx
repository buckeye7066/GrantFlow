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
  const [profileId, setProfileId] = useState("")

  const monthStr = format(currentMonth, "yyyy-MM")

  // Fetch deadlines from our new API
  const { data: calendarResult, isLoading: calLoading } = useQuery({
    queryKey: ["calendar-deadlines", monthStr, profileId],
    queryFn: () => getCalendarDeadlines({ month: monthStr, profileId: profileId || undefined }),
    staleTime: 60_000,
  })
  // Hamilton's scheduled application runs (profile-scoped) — folded into the
  // same calendar feed, each flagged when you may need to be available for 2FA.
  const { data: hamiltonResult } = useQuery({
    queryKey: ["hamilton-calendar", monthStr, profileId],
    queryFn: () => getHamiltonCalendar({ month: monthStr, profileId }),
    enabled: !!profileId,
    staleTime: 60_000,
  })

  const calEvents = useMemo(() => {
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

  // Map deadlines to days
  const deadlinesByDay = useMemo(() => {
    const map = {}
    for (const ev of calEvents) {
      if (!ev.deadline) continue
      const day = ev.deadline.split("T")[0]
      if (!map[day]) map[day] = []
      map[day].push(ev)
    }
    return map
  }, [calEvents])

  // Upcoming deadlines (next 30 days, from all sources)
  const upcoming = useMemo(() => {
    const now = new Date()
    return calEvents
      .filter((e) => {
        if (!e.deadline) return false
        const d = new Date(e.deadline)
        const diff = differenceInDays(d, now)
        return diff >= 0 && diff <= 30
      })
      .sort((a, b) => a.deadline.localeCompare(b.deadline))
      .slice(0, 20)
  }, [calEvents])

  // Events for selected day
  const selectedDayEvents = useMemo(() => {
    if (!selectedDay) return []
    const key = format(selectedDay, "yyyy-MM-dd")
    return deadlinesByDay[key] || []
  }, [selectedDay, deadlinesByDay])

  // Pipeline grant deadlines (existing logic, enhanced)
  const isValidDate = (ds) => ds && !isNaN(new Date(ds).getTime())
  const upcomingGrants = grants
    .filter((g) => {
      if (!["discovered", "interested", "drafting"].includes(g.status)) return false
      if (!g.deadline || g.deadline.toLowerCase() === "rolling" || !isValidDate(g.deadline)) return false
      return new Date(g.deadline) >= new Date(new Date().setHours(0, 0, 0, 0))
    })
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))

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
              placeholder="All profiles"
            />
          </div>
        </div>

        {profileId ? <HamiltonReadinessBanner profileId={profileId} /> : null}

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
                    const daysLeft = Math.max(0, differenceInDays(new Date(ev.deadline), new Date()))
                    return (
                      <div key={i} className="flex items-start gap-2 p-2 bg-slate-50 rounded-lg">
                        <Clock className={`w-4 h-4 mt-0.5 flex-shrink-0 ${daysLeft <= 7 ? "text-red-500" : "text-slate-400"}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{ev.title}</p>
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span>{format(new Date(ev.deadline), "MMM d")}</span>
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
                    const daysLeft = Math.max(0, differenceInDays(new Date(grant.deadline), new Date()))
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
