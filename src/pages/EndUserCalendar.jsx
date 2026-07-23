import React, { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  addMonths,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  format,
  getDay,
  isSameDay,
  isToday,
  startOfMonth,
  subMonths,
} from 'date-fns'
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import client from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuthStore } from '@/stores/authStore'

const ITEM_COLORS = Object.freeze({
  completed: '#bbf7d0',
  needed: '#fef08a',
  submission: '#fecaca',
})

const TERMINAL_HIDDEN_STATUSES = new Set([
  'rejected',
  'withdrawn',
  'deleted',
  'archived',
  'expired',
])

function toLocalDate(value) {
  if (!value) return null
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim())
  if (bare) return new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]))
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function dayKey(value) {
  const date = value instanceof Date ? value : toLocalDate(value)
  return date ? format(date, 'yyyy-MM-dd') : null
}

function grantTitle(grant) {
  return grant?.title || grant?.name || 'Funding source'
}

function grantSponsor(grant) {
  return grant?.funder || grant?.sponsor || grant?.funder_name || ''
}

function segmentedBackground(items) {
  if (!Array.isArray(items) || items.length === 0) return undefined
  const width = 100 / items.length
  const stops = items.flatMap((item, index) => {
    const start = Number((index * width).toFixed(4))
    const end = Number(((index + 1) * width).toFixed(4))
    const color = ITEM_COLORS[item.kind] || '#ffffff'
    return [`${color} ${start}%`, `${color} ${end}%`]
  })
  return { backgroundImage: `linear-gradient(to right, ${stops.join(', ')})` }
}

function statusLabel(kind) {
  if (kind === 'completed') return 'Completed'
  if (kind === 'submission') return 'Submission deadline'
  return 'Needed by this date'
}

function statusIcon(kind) {
  if (kind === 'completed') return CheckCircle2
  if (kind === 'submission') return CircleAlert
  return Clock3
}

export default function EndUserCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectedDay, setSelectedDay] = useState(null)
  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const profiles = useAuthStore((state) => state.profiles)
  const profileId = activeProfileId && activeProfileId !== '__admin__'
    ? activeProfileId
    : profiles?.[0]?.id ?? null

  const { data: grants = [], isLoading: grantsLoading } = useQuery({
    queryKey: ['grants', 'end-user-calendar', profileId],
    queryFn: () => client.entities.Grant.list(
      '-created_date',
      2000,
      profileId ? { profile_id: profileId } : {},
    ),
    staleTime: 30_000,
  })

  const { data: milestones = [], isLoading: milestonesLoading } = useQuery({
    queryKey: ['milestones'],
    queryFn: () => client.entities.Milestone.list(),
    staleTime: 30_000,
  })

  const pipelineGrants = useMemo(
    () => (Array.isArray(grants) ? grants : []).filter((grant) => {
      if (!grant?.id) return false
      if (profileId && String(grant.profile_id || '') !== String(profileId)) return false
      return !TERMINAL_HIDDEN_STATUSES.has(String(grant.status || '').toLowerCase())
    }),
    [grants, profileId],
  )

  const calendarItems = useMemo(() => {
    const grantById = new Map(pipelineGrants.map((grant) => [String(grant.id), grant]))
    const items = []

    for (const milestone of Array.isArray(milestones) ? milestones : []) {
      const grant = grantById.get(String(milestone?.grant_id || ''))
      const date = toLocalDate(milestone?.due_date)
      if (!grant || !date) continue
      items.push({
        id: `milestone:${milestone.id}`,
        kind: milestone.completed ? 'completed' : 'needed',
        date,
        dateKey: dayKey(date),
        title: milestone.title || 'Application step',
        description: milestone.description || '',
        grantId: grant.id,
        grantTitle: grantTitle(grant),
        sponsor: grantSponsor(grant),
        completedDate: milestone.completed_date || null,
      })
    }

    for (const grant of pipelineGrants) {
      if (!grant.deadline || String(grant.deadline).toLowerCase() === 'rolling') continue
      const date = toLocalDate(grant.deadline)
      if (!date) continue
      items.push({
        id: `submission:${grant.id}`,
        kind: 'submission',
        date,
        dateKey: dayKey(date),
        title: 'Submit application',
        description: 'Final funding source submission deadline',
        grantId: grant.id,
        grantTitle: grantTitle(grant),
        sponsor: grantSponsor(grant),
      })
    }

    return items.sort((a, b) => a.date - b.date || a.title.localeCompare(b.title))
  }, [milestones, pipelineGrants])

  const itemsByDay = useMemo(() => {
    const map = new Map()
    for (const item of calendarItems) {
      if (!item.dateKey) continue
      const existing = map.get(item.dateKey) || []
      existing.push(item)
      map.set(item.dateKey, existing)
    }
    return map
  }, [calendarItems])

  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd })
  const leadingBlanks = getDay(monthStart)

  const selectedItems = selectedDay
    ? itemsByDay.get(dayKey(selectedDay)) || []
    : []

  const upcomingItems = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return calendarItems
      .filter((item) => item.kind !== 'completed' && differenceInCalendarDays(item.date, today) >= 0)
      .slice(0, 12)
  }, [calendarItems])

  const isLoading = grantsLoading || milestonesLoading

  return (
    <section className="px-4 pb-12 pt-6 md:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-primary">
            <CalendarDays className="h-3.5 w-3.5" />
            Pipeline schedule
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Your funding deadlines</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground md:text-base">
            Every date comes from a funding source in your pipeline. Select a highlighted square to see exactly what happened or what is due.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 text-xs font-medium text-foreground">
          <Legend color={ITEM_COLORS.completed} label="Completed" />
          <Legend color={ITEM_COLORS.needed} label="Needed by this date" />
          <Legend color={ITEM_COLORS.submission} label="Submission deadline" />
          <span className="self-center text-muted-foreground">Split squares mean more than one item shares that date.</span>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <Button variant="ghost" size="icon" onClick={() => setCurrentMonth((month) => subMonths(month, 1))} aria-label="Previous month">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <CardTitle>{format(currentMonth, 'MMMM yyyy')}</CardTitle>
                <Button variant="ghost" size="icon" onClick={() => setCurrentMonth((month) => addMonths(month, 1))} aria-label="Next month">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">Loading your pipeline schedule…</div>
              ) : (
                <>
                  <div className="mb-1 grid grid-cols-7 gap-px">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => (
                      <div key={label} className="py-1 text-center text-xs font-medium text-muted-foreground">{label}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl bg-border">
                    {Array.from({ length: leadingBlanks }).map((_, index) => (
                      <div key={`blank-${index}`} className="min-h-[94px] bg-muted/40" />
                    ))}
                    {monthDays.map((day) => {
                      const key = dayKey(day)
                      const items = itemsByDay.get(key) || []
                      const selected = selectedDay && isSameDay(day, selectedDay)
                      const today = isToday(day)
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSelectedDay(day)}
                          style={segmentedBackground(items)}
                          className={`relative min-h-[94px] min-w-0 bg-card p-2 text-left transition focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset ${
                            selected ? 'z-[1] ring-2 ring-primary ring-inset' : ''
                          } ${items.length === 0 ? 'hover:bg-muted/60' : 'hover:brightness-[0.98]'} `}
                          title={items.length ? items.map((item) => `${statusLabel(item.kind)}: ${item.title} — ${item.grantTitle}`).join('\n') : undefined}
                        >
                          <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md bg-background/85 px-1.5 text-sm font-semibold shadow-sm ${today ? 'text-primary ring-1 ring-primary/40' : 'text-foreground'}`}>
                            {format(day, 'd')}
                          </span>
                          {items.length > 0 ? (
                            <span className="absolute bottom-1.5 right-1.5 rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-bold text-foreground shadow-sm">
                              {items.length}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>

                  {selectedDay ? (
                    <div className="mt-5 border-t border-border pt-4">
                      <h2 className="font-semibold text-foreground">{format(selectedDay, 'MMMM d, yyyy')}</h2>
                      {selectedItems.length === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">Nothing is scheduled for this date.</p>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {selectedItems.map((item) => <CalendarItem key={item.id} item={item} />)}
                        </div>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock3 className="h-5 w-5 text-amber-600" />
                Coming up
              </CardTitle>
            </CardHeader>
            <CardContent>
              {upcomingItems.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No upcoming pipeline deadlines.</p>
              ) : (
                <div className="space-y-3">
                  {upcomingItems.map((item) => (
                    <Link
                      key={item.id}
                      to={`/Pipeline?grant_id=${encodeURIComponent(item.grantId)}`}
                      className="block rounded-xl border border-border bg-background p-3 transition hover:border-primary/40 hover:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{item.grantTitle}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{item.title}</p>
                        </div>
                        <Badge variant="outline" className={item.kind === 'submission' ? 'border-red-300 bg-red-50 text-red-700' : 'border-amber-300 bg-amber-50 text-amber-800'}>
                          {format(item.date, 'MMM d')}
                        </Badge>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}

function Legend({ color, label }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
      <span className="h-3 w-3 rounded-sm border border-black/10" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}

function CalendarItem({ item }) {
  const Icon = statusIcon(item.kind)
  const badgeClass = item.kind === 'completed'
    ? 'border-green-300 bg-green-50 text-green-700'
    : item.kind === 'submission'
      ? 'border-red-300 bg-red-50 text-red-700'
      : 'border-amber-300 bg-amber-50 text-amber-800'

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-medium text-foreground">{item.title}</p>
          <p className="truncate text-sm text-muted-foreground">{item.grantTitle}{item.sponsor ? ` · ${item.sponsor}` : ''}</p>
          {item.description ? <p className="mt-1 text-xs text-muted-foreground">{item.description}</p> : null}
          {item.completedDate ? <p className="mt-1 text-xs text-green-700">Completed {item.completedDate}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline" className={badgeClass}>{statusLabel(item.kind)}</Badge>
        <Button asChild size="sm" variant="outline">
          <Link to={`/Pipeline?grant_id=${encodeURIComponent(item.grantId)}`}>Open</Link>
        </Button>
      </div>
    </div>
  )
}
