import React, { useState, useMemo } from "react"
import { CalendarClock, Calendar, Clock, AlertTriangle, CheckCircle, Filter } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { format, differenceInDays, parseISO, isValid } from "date-fns"
import { Link } from "react-router-dom"
import { createPageUrl } from "@/utils"

function parseDateSafe(dateStr) {
  if (!dateStr) return null
  if (dateStr.toLowerCase() === 'rolling') return null
  try {
    const parsed = parseISO(dateStr)
    return isValid(parsed) ? parsed : null
  } catch {
    return null
  }
}

export default function GrantDeadline() {
  const [statusFilter, setStatusFilter] = useState("all")

  const { data: grants = [] } = useQuery({
    queryKey: ['grants'],
    queryFn: () => apiFetch('/api/grants'),
    staleTime: 60_000,
  })

  const { data: milestones = [] } = useQuery({
    queryKey: ['milestones'],
    queryFn: () => apiFetch('/api/milestones'),
    staleTime: 60_000,
  })

  // Combine grants and milestones into deadline items
  const deadlineItems = useMemo(() => {
    const items = []

    // Add grant deadlines
    grants.forEach(grant => {
      if (grant.deadline && !['awarded', 'rejected', 'closed', 'archived'].includes(grant.status)) {
        const isRolling = grant.deadline.toLowerCase() === 'rolling'
        const date = isRolling ? null : parseDateSafe(grant.deadline)
        const daysUntil = date ? differenceInDays(date, new Date()) : null

        items.push({
          id: `grant-${grant.id}`,
          type: 'grant',
          title: grant.title || 'Untitled Grant',
          deadline: grant.deadline,
          date,
          daysUntil,
          isRolling,
          status: grant.status,
          urgency: daysUntil !== null ? (daysUntil < 0 ? 'overdue' : daysUntil <= 7 ? 'critical' : daysUntil <= 14 ? 'warning' : 'normal') : 'rolling',
          grant,
        })
      }
    })

    // Add milestones
    milestones.forEach(milestone => {
      if (milestone.due_date && !milestone.completed_at) {
        const date = parseDateSafe(milestone.due_date)
        const daysUntil = date ? differenceInDays(date, new Date()) : null

        items.push({
          id: `milestone-${milestone.id}`,
          type: 'milestone',
          title: milestone.name || 'Untitled Milestone',
          deadline: milestone.due_date,
          date,
          daysUntil,
          isRolling: false,
          status: milestone.status || 'pending',
          urgency: daysUntil !== null ? (daysUntil < 0 ? 'overdue' : daysUntil <= 3 ? 'critical' : daysUntil <= 7 ? 'warning' : 'normal') : 'normal',
          milestone,
        })
      }
    })

    return items.sort((a, b) => {
      // Rolling deadlines last
      if (a.isRolling && !b.isRolling) return 1
      if (!a.isRolling && b.isRolling) return -1
      
      // Sort by days until deadline
      if (a.daysUntil !== null && b.daysUntil !== null) {
        return a.daysUntil - b.daysUntil
      }
      if (a.daysUntil !== null) return -1
      if (b.daysUntil !== null) return 1
      
      return 0
    })
  }, [grants, milestones])

  const filteredItems = useMemo(() => {
    if (statusFilter === 'all') return deadlineItems
    if (statusFilter === 'overdue') return deadlineItems.filter(i => i.urgency === 'overdue')
    if (statusFilter === 'critical') return deadlineItems.filter(i => i.urgency === 'critical')
    if (statusFilter === 'warning') return deadlineItems.filter(i => i.urgency === 'warning')
    if (statusFilter === 'rolling') return deadlineItems.filter(i => i.isRolling)
    return deadlineItems
  }, [deadlineItems, statusFilter])

  // Split the rendered list so past-due items are never presented under the
  // "Upcoming" header. Overdue = a real deadline already in the past.
  const overdueItems = useMemo(
    () => filteredItems.filter(i => i.urgency === 'overdue'),
    [filteredItems],
  )
  const upcomingItems = useMemo(
    () => filteredItems.filter(i => i.urgency !== 'overdue'),
    [filteredItems],
  )

  const stats = useMemo(() => ({
    total: deadlineItems.length,
    overdue: deadlineItems.filter(i => i.urgency === 'overdue').length,
    critical: deadlineItems.filter(i => i.urgency === 'critical').length,
    warning: deadlineItems.filter(i => i.urgency === 'warning').length,
    rolling: deadlineItems.filter(i => i.isRolling).length,
  }), [deadlineItems])

  const getUrgencyColor = (urgency) => {
    switch (urgency) {
      case 'overdue': return 'text-red-800 bg-red-100 border-red-400'
      case 'critical': return 'text-red-600 bg-red-50 border-red-200'
      case 'warning': return 'text-amber-600 bg-amber-50 border-amber-200'
      case 'rolling': return 'text-blue-600 bg-blue-50 border-blue-200'
      default: return 'text-slate-600 bg-slate-50 border-slate-200'
    }
  }

  const renderDeadlineItem = (item) => (
    <Card key={item.id} className={`border-2 ${getUrgencyColor(item.urgency)}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              {item.type === 'grant' ? <Calendar className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
              <h3 className="font-semibold text-slate-900">{item.title}</h3>
              <Badge variant="secondary">
                {item.type === 'grant' ? 'Grant' : 'Milestone'}
              </Badge>
              {item.urgency === 'overdue' && (
                <Badge variant="destructive">Overdue</Badge>
              )}
            </div>

            <div className="flex items-center gap-4 text-sm text-slate-600">
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {item.isRolling ? (
                  <span>Rolling deadline</span>
                ) : item.date ? (
                  <>
                    <span>{format(item.date, 'PPP')}</span>
                    {item.daysUntil !== null && (
                      <span className="ml-2 font-medium">
                        ({item.daysUntil >= 0 ? `${item.daysUntil} days` : `${Math.abs(item.daysUntil)} days overdue`})
                      </span>
                    )}
                  </>
                ) : (
                  <span>Date TBD</span>
                )}
              </div>

              {item.type === 'grant' && item.grant?.status && (
                <Badge variant="outline" className="capitalize">
                  {item.grant.status.replace(/_/g, ' ')}
                </Badge>
              )}
            </div>

            {item.type === 'grant' && item.grant?.funder && (
              <div className="text-xs text-slate-500 mt-2">
                Funder: {item.grant.funder}
              </div>
            )}
          </div>

          <Button size="sm" variant="outline" asChild>
            <Link to={item.type === 'grant' ? createPageUrl("Pipeline") : createPageUrl("Calendar")}>
              View
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <CalendarClock className="w-8 h-8" />
            Grant Deadline Tracker
          </h1>
          <p className="text-slate-600 mt-2">
            Monitor all upcoming deadlines and milestones in one place
          </p>
        </div>

        <div className="grid md:grid-cols-5 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600">Total Deadlines</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card className="border-red-400 bg-red-100">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-red-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                Overdue
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-900">{stats.overdue}</div>
              <p className="text-xs text-red-800 mt-1">Past due</p>
            </CardContent>
          </Card>
          <Card className="border-red-200 bg-red-50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-red-700 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                Critical
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-900">{stats.critical}</div>
              <p className="text-xs text-red-700 mt-1">≤7 days</p>
            </CardContent>
          </Card>
          <Card className="border-amber-200 bg-amber-50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-amber-700">Warning</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-900">{stats.warning}</div>
              <p className="text-xs text-amber-700 mt-1">8-14 days</p>
            </CardContent>
          </Card>
          <Card className="border-blue-200 bg-blue-50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-blue-700">Rolling</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-900">{stats.rolling}</div>
              <p className="text-xs text-blue-700 mt-1">No fixed deadline</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Deadlines &amp; Milestones</CardTitle>
                <CardDescription>Grants and milestones requiring attention</CardDescription>
              </div>
              <Tabs value={statusFilter} onValueChange={setStatusFilter}>
                <TabsList>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="overdue">Overdue</TabsTrigger>
                  <TabsTrigger value="critical">Critical</TabsTrigger>
                  <TabsTrigger value="warning">Warning</TabsTrigger>
                  <TabsTrigger value="rolling">Rolling</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent>
            {filteredItems.length > 0 ? (
              <div className="space-y-6">
                {/* Overdue — past-due items kept clearly separate from upcoming */}
                {overdueItems.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-700" />
                      <h3 className="text-sm font-semibold text-red-800 uppercase tracking-wide">
                        Overdue — Past Due ({overdueItems.length})
                      </h3>
                    </div>
                    {overdueItems.map((item) => renderDeadlineItem(item))}
                  </div>
                )}

                {/* Upcoming — only items not yet past due */}
                {upcomingItems.length > 0 && (
                  <div className="space-y-3">
                    {overdueItems.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-slate-600" />
                        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
                          Upcoming ({upcomingItems.length})
                        </h3>
                      </div>
                    )}
                    {upcomingItems.map((item) => renderDeadlineItem(item))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-12">
                <CalendarClock className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">No Deadlines Found</h3>
                <p className="text-slate-600">
                  {statusFilter === 'all'
                    ? 'No upcoming deadlines. Start adding grants to track deadlines.'
                    : `No ${statusFilter} deadlines at this time.`}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
