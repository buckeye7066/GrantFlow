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
  submitted: '#86efac',
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
  if (kind === 'submitted') return 'Application submitted'
  if (kind === 'submission') return 'Submission deadline'
  return 'Needed by this date'
}

function statusIcon(kind) {
  if (kind === 'completed') return CheckCircle2
  if (kind === 'submitted') return CheckCircle2
  if (kind === 'submission') return CircleAlert
  return Clock3
}

function pendingAmountLabel(grant) {
  const amt = Number(grant?.amount_requested || grant?.amount_max || grant?.amount_min || 0)
  if (!Number.isFinite(amt) || amt <= 0) return ''
  try { return ` — award pending: ${amt.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}` } catch { return ` — award pending: $${amt}` }
}

function describeCalendarDay(day, items = []) {
  const dateLabel = format(day, 'EEEE, MMMM d, yyyy')
  if (!Array.isArray(items) || items.length === 0) return `${dateLabel}. Nothing scheduled.`
  const details = items
    .map((item) => `${statusLabel(item.kind)}: ${item.title} for ${item.grantTitle}`)
    .join('. ')
  return `${dateLabel}. ${items.length} scheduled ${items.length === 1 ? 'item' : 'items'}. ${details}.`
}

function distinctKinds(items = []) {
  return [...new Set(items.map((item) => item.kind).filter(Boolean))]
}

export default function EndUserCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectedDay, setSelectedDay] = useState(null)
  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const profiles = useAuthStore((state) => state.profiles)
  const profileId = activeProfileId && activeProfileId !== '__admin__'
    ? activeProfileId
    : profiles?.[0]?.id ?? null

  const grantsQuery = useQuery({
    queryKey: ['grants', 'end-user-calendar', profileId],
    queryFn: () => client.entities.Grant.list(
      '-created_date',
      2000,
      profileId ? { profile_id: profileId } : {},
    ),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })

  const milestonesQuery = useQuery({
    queryKey: ['milestones', 'end-user-calendar', profileId],
    queryFn: () => client.entities.Milestone.list(),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })

  const grants = grantsQuery.data ?? []
  const milestones = milestonesQuery.data ?? []

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
      // WHEN THE SUBMISSION OCCURRED (owner 2026-08-22): a grant Hamilton (or the
      // user) has submitted shows a "submitted ✓" marker on its submission date,
      // with the award amount noted as pending. Distinct from the DEADLINE below.
      const status = String(grant.status || '').toLowerCase()
      const submittedRaw = grant.submitted_date || grant.submitted_at || null
      if (submittedRaw || status === 'submitted') {
        const subDate = toLocalDate(submittedRaw) || (status === 'submitted' ? toLocalDate(grant.updated_at) : null)
        if (subDate) {
          items.push({
            id: `submitted:${grant.id}`,
            kind: 'submitted',
            date: subDate,
            dateKey: dayKey(subDate),
            title: 'Application submitted',
            description: `Submitted to ${grantSponsor(grant) || grantTitle(grant)}${pendingAmountLabel(grant)}. Awaiting the funder's decision.`,
            grantId: grant.id,
            grantTitle: grantTitle(grant),
            sponsor: grantSponsor(grant),
          })
        }
      }

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

  const isLoading = grantsQuery.isLoading || milestonesQuery.isLoading
  const hasError = grantsQuery.isError || milestonesQuery.isError

  if (!profileId) {
    return (
      <section className="px-4 pb-12 pt-6 md:px-6 lg:px-10">
        <Card className="mx-auto max-w-lg">
          <CardContent className="p-8 text-center">
            <CalendarDays className="mx-auto h-9 w-9 text-primary" aria-hidden="true" />
            <h1 className="mt-4 text-xl font-semibold text-foreground">Your calendar will appear here</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Anya is still connecting your funding profile. Ask her what is needed next.
            </p>
            <Button asChild className="mt-5">
              <Link to="/Help">Ask Anya</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    )
  }

  return (
    <section className="px-4 pb-12 pt-6 md:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
            <CalendarDays className="h-3.5 w-3.5" />
            Pipeline schedule
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Your funding deadlines</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground md:text-base">
            Every date comes from a funding source in your pipeline. Select a highlighted square to see exactly what happened or what is due.
          </p>
        </div>

          <div className="flex flex-wrap gap-3 text-xs font-medium text-foreground" role="group" aria-label="Calendar status key">
          <Legend kind="completed" color={ITEM_COLORS.completed} label="Completed" />
          <Legend kind="needed" color={ITEM_COLORS.needed} label="Needed by this date" />
          <Legend kind="submission" color={ITEM_COLORS.submission} label="Submission deadline" />
          <span className="self-center text-muted-foreground">Split squares mean more than one item shares that date.</span>
        </div>

        {hasError ? (
          <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
            <p className="font-semibold">We could not load every calendar date.</p>
            <p className="mt-1">Check your connection, then try again. No missing date is being treated as complete.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                grantsQuery.refetch()
                milestonesQuery.refetch()
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <Button variant="ghost" size="icon" onClick={() => setCurrentMonth((month) => subMonths(month, 1))} aria-label="Previous month">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <CardTitle id="calendar-month-heading">{format(currentMonth, 'MMMM yyyy')}</CardTitle>
                <Button variant="ghost" size="icon" onClick={() => setCurrentMonth((month) => addMonths(month, 1))} aria-label="Next month">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-2 pb-6 sm:px-6">
              {isLoading ? (
                <div role="status" aria-live="polite" className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">
                  Loading your pipeline schedule…
                </div>
              ) : hasError ? (
                <div className="flex min-h-[240px] items-center justify-center px-4 text-center text-sm text-muted-foreground">
                  Calendar dates are unavailable until the retry succeeds.
                </div>
              ) : (
                <>
                  <div className="mb-1 grid grid-cols-7 gap-px">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => (
                      <div key={label} className="py-1 text-center text-[10px] font-medium text-muted-foreground sm:text-xs">{label}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl bg-border" role="group" aria-labelledby="calendar-month-heading">
                    {Array.from({ length: leadingBlanks }).map((_, index) => (
                      <div key={`blank-${index}`} className="min-h-[68px] bg-muted/40 sm:min-h-[94px]" aria-hidden="true" />
                    ))}
                    {monthDays.map((day) => {
                      const key = dayKey(day)
                      const items = itemsByDay.get(key) || []
                      const selected = selectedDay && isSameDay(day, selectedDay)
                      const today = isToday(day)
                      const kinds = distinctKinds(items)
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSelectedDay(day)}
                          style={segmentedBackground(items)}
                          aria-label={describeCalendarDay(day, items)}
                          aria-pressed={Boolean(selected)}
                          aria-current={today ? 'date' : undefined}
                          className={`relative min-h-[68px] !min-w-0 bg-card p-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset sm:min-h-[94px] sm:p-2 ${
                            selected ? 'z-[1] ring-2 ring-primary ring-inset' : ''
                          } ${items.length === 0 ? 'hover:bg-muted/60' : 'hover:brightness-[0.98]'} `}
                        >
                          <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md bg-background/90 px-1 text-sm font-semibold shadow-sm ${today ? 'text-blue-800 ring-1 ring-blue-700/40 dark:text-blue-200' : 'text-foreground'}`}>
                            {format(day, 'd')}
                          </span>
                          {items.length > 0 ? (
                            <span className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded-md bg-background/95 px-1 py-0.5 text-foreground shadow-sm sm:bottom-1.5 sm:right-1.5">
                              {kinds.map((kind) => {
                                const Icon = statusIcon(kind)
                                return <Icon key={kind} className="h-3 w-3" aria-hidden="true" />
                              })}
                              <span className="sr-only">{items.length} scheduled</span>
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>

                  {selectedDay ? (
                    <div className="mt-5 border-t border-border pt-4" aria-live="polite">
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
              {isLoading ? (
                <p role="status" className="py-8 text-center text-sm text-muted-foreground">Loading upcoming dates…</p>
              ) : hasError ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Upcoming dates are unavailable until the calendar reloads.</p>
              ) : upcomingItems.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  <p>No upcoming pipeline deadlines.</p>
                  <Button asChild variant="outline" size="sm" className="mt-4">
                    <Link to="/Pipeline">Open your pipeline</Link>
                  </Button>
                </div>
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

function Legend({ kind, color, label }) {
  const Icon = statusIcon(kind)
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
      <span className="h-3 w-3 rounded-sm border border-black/10" style={{ backgroundColor: color }} />
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
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
