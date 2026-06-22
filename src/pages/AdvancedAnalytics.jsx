import React, { useState, useMemo } from "react"
import { LineChart, Award, DollarSign, Target, Download, TrendingUp } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { differenceInDays, format } from "date-fns"
import { canonicalStage } from "../../shared/pipelineStages.js"

export default function AdvancedAnalytics() {
  const [timeRange, setTimeRange] = useState("12m")

  const { data: grants = [] } = useQuery({
    queryKey: ['grants'],
    queryFn: () => apiFetch('/api/grants'),
    staleTime: 60_000,
  })

  const { data: opportunities = [] } = useQuery({
    queryKey: ['opportunities'],
    queryFn: () => apiFetch('/api/opportunities'),
    staleTime: 60_000,
  })

  // Calculate metrics
  const metrics = useMemo(() => {
    // Bucket by CANONICAL stage so legacy statuses (auto_applied,
    // pending_review, under_review → submitted; rejected → declined) are
    // counted the same way the Pipeline Kanban counts them. Comparing raw
    // literal statuses made these metrics read 0 even with a full pipeline.
    const awarded = grants.filter(g => canonicalStage(g.status) === 'awarded')
    const submitted = grants.filter(g => ['submitted', 'awarded', 'declined'].includes(canonicalStage(g.status)))

    const totalAwarded = awarded.reduce((sum, g) => sum + (g.amount_awarded || 0), 0)
    const winRate = submitted.length > 0 ? (awarded.length / submitted.length * 100).toFixed(1) : 0

    // Calculate average time to award. The schema column is `award_date`
    // (not `awarded_date`); reading the wrong name silently produced 0 days.
    const awardedWithDates = awarded.filter(g => g.submitted_date && g.award_date)
    const avgDays = awardedWithDates.length > 0
      ? Math.round(
          awardedWithDates.reduce((sum, g) => {
            try {
              const submittedDate = new Date(g.submitted_date)
              const awardedDate = new Date(g.award_date)
              if (isNaN(submittedDate.getTime()) || isNaN(awardedDate.getTime())) {
                return sum
              }
              const days = differenceInDays(awardedDate, submittedDate)
              return sum + (days >= 0 ? days : 0)
            } catch {
              return sum
            }
          }, 0) / awardedWithDates.length
        )
      : 0

    // Portfolio health score (simple calculation). Active = in-progress
    // canonical stages (everything pre-outcome that is past discovery).
    const active = grants.filter(g => ['saved', 'interested', 'gathering_documents', 'drafting', 'ready_to_submit', 'submitted', 'follow_up'].includes(canonicalStage(g.status)))
    const healthScore = grants.length > 0 ? Math.min(100, (active.length / grants.length * 100 + Number(winRate)) / 2).toFixed(0) : 0

    return {
      totalAwarded,
      winRate,
      avgDays,
      healthScore,
      awarded: awarded.length,
      submitted: submitted.length,
      active: active.length,
      rejected: grants.filter(g => canonicalStage(g.status) === 'declined').length,
    }
  }, [grants])

  // Group grants by status for portfolio view
  const grantsByStatus = useMemo(() => {
    const statusGroups = {}
    grants.forEach(grant => {
      const status = grant.status || 'unknown'
      if (!statusGroups[status]) {
        statusGroups[status] = []
      }
      statusGroups[status].push(grant)
    })
    return statusGroups
  }, [grants])

  // Group by state for geographic analysis
  const grantsByState = useMemo(() => {
    const stateMap = new Map()
    grants.forEach(grant => {
      // grant.state is surfaced by GET /api/grants as
      // COALESCE(funding_opportunity.state, organization.state). Fall back to
      // any other location hint the row may carry before "Unknown".
      const state = grant.state || grant.region || grant.organization_state || 'Unknown'
      if (!stateMap.has(state)) {
        stateMap.set(state, { state, count: 0, awarded: 0, total: 0 })
      }
      const data = stateMap.get(state)
      data.count++
      if (canonicalStage(grant.status) === 'awarded') {
        data.awarded++
        data.total += grant.amount_awarded || 0
      }
    })
    return Array.from(stateMap.values()).sort((a, b) => b.count - a.count)
  }, [grants])

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <LineChart className="w-8 h-8" />
              Advanced Analytics
            </h1>
            <p className="text-slate-600 mt-2">
              Performance insights and portfolio analysis
            </p>
          </div>
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="3m">Last 3 months</SelectItem>
              <SelectItem value="6m">Last 6 months</SelectItem>
              <SelectItem value="12m">Last 12 months</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                <Award className="w-4 h-4" />
                Win Rate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{metrics.winRate}%</div>
              <p className="text-xs text-slate-600 mt-1">{metrics.awarded} of {metrics.submitted} submitted</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                <DollarSign className="w-4 h-4" />
                Total Awarded
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${metrics.totalAwarded.toLocaleString()}</div>
              <p className="text-xs text-slate-600 mt-1">Lifetime funding (recorded awards)</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                <Target className="w-4 h-4" />
                Avg. Time to Award
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{metrics.avgDays > 0 ? `${metrics.avgDays}d` : '—'}</div>
              <p className="text-xs text-slate-600 mt-1">From submission</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Portfolio Health
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{metrics.healthScore}</div>
              <p className="text-xs text-slate-600 mt-1">Overall score</p>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="portfolio" className="space-y-4">
          <TabsList>
            <TabsTrigger value="portfolio">Portfolio Overview</TabsTrigger>
            <TabsTrigger value="geography">Geographic Analysis</TabsTrigger>
            <TabsTrigger value="performance">Performance Metrics</TabsTrigger>
          </TabsList>

          <TabsContent value="portfolio" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Grant Portfolio by Status</CardTitle>
                <CardDescription>
                  Distribution of grants across pipeline stages
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid md:grid-cols-4 gap-4">
                    <Card className="border-2">
                      <CardContent className="p-4">
                        <div className="text-sm font-medium text-slate-600 mb-2">Active Pipeline</div>
                        <div className="text-2xl font-bold">{metrics.active}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-2 border-green-200 bg-green-50">
                      <CardContent className="p-4">
                        <div className="text-sm font-medium text-green-700 mb-2">Awarded</div>
                        <div className="text-2xl font-bold text-green-900">{metrics.awarded}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-2">
                      <CardContent className="p-4">
                        <div className="text-sm font-medium text-slate-600 mb-2">Submitted</div>
                        <div className="text-2xl font-bold">{metrics.submitted}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-2 border-red-200 bg-red-50">
                      <CardContent className="p-4">
                        <div className="text-sm font-medium text-red-700 mb-2">Rejected</div>
                        <div className="text-2xl font-bold text-red-900">{metrics.rejected}</div>
                      </CardContent>
                    </Card>
                  </div>
                  
                  {Object.keys(grantsByStatus).length > 0 && (
                    <div className="space-y-2">
                      {Object.entries(grantsByStatus).map(([status, statusGrants]) => (
                        <div key={status} className="flex items-center gap-4 p-3 border rounded-lg">
                          <div className="flex-1">
                            <div className="font-medium capitalize">{status.replace(/_/g, ' ')}</div>
                            <div className="text-sm text-slate-600">{statusGrants.length} grants</div>
                          </div>
                          <div className="text-sm font-semibold">
                            {((statusGrants.length / grants.length) * 100).toFixed(0)}%
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="geography" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Geographic Distribution</CardTitle>
                <CardDescription>
                  Grant distribution by state/region
                </CardDescription>
              </CardHeader>
              <CardContent>
                {grantsByState.length > 0 ? (
                  <div className="space-y-2">
                    {grantsByState.map((item) => (
                      <div key={item.state} className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="flex-1">
                          <div className="font-medium">{item.state}</div>
                          <div className="text-sm text-slate-600">
                            {item.count} grants • {item.awarded} awarded
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">${item.total.toLocaleString()}</div>
                          <div className="text-xs text-slate-600">awarded</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12 text-slate-600">
                    No geographic data available
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="performance" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Performance Summary</CardTitle>
                <CardDescription>
                  Key performance indicators for your grant portfolio
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="p-4 border rounded-lg">
                      <div className="text-sm text-slate-600 mb-1">Success Rate</div>
                      <div className="text-2xl font-bold">{metrics.winRate}%</div>
                      <div className="text-xs text-slate-500 mt-1">
                        {metrics.awarded} awarded out of {metrics.submitted} decisions
                      </div>
                    </div>
                    <div className="p-4 border rounded-lg">
                      <div className="text-sm text-slate-600 mb-1">Average Award</div>
                      <div className="text-2xl font-bold">
                        ${metrics.awarded > 0 ? (metrics.totalAwarded / metrics.awarded).toFixed(0).toLocaleString() : '0'}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        Per awarded grant
                      </div>
                    </div>
                  </div>
                  
                  <div className="p-4 border rounded-lg">
                    <div className="text-sm text-slate-600 mb-2">Grant Pipeline Health</div>
                    <div className="w-full bg-slate-200 rounded-full h-2 mb-2">
                      <div 
                        className="bg-blue-600 h-2 rounded-full transition-all" 
                        style={{ width: `${metrics.healthScore}%` }}
                      />
                    </div>
                    <div className="text-xs text-slate-600">
                      {metrics.active} active grants in pipeline
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
