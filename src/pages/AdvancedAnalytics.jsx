import React, { useState } from "react"
import { LineChart, BarChart3, PieChart, TrendingUp, Award, DollarSign, Target, Download } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export default function AdvancedAnalytics() {
  const [timeRange, setTimeRange] = useState("12m")

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <LineChart className="w-8 h-8" />
              Advanced Analytics
            </h1>
            <p className="text-slate-600 mt-2">
              Deep insights into performance trends, win rates, and portfolio health
            </p>
          </div>
          <div className="flex gap-2">
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
            <Button variant="outline" className="gap-2">
              <Download className="w-4 h-4" />
              Export
            </Button>
          </div>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                <Award className="w-4 h-4" />
                Win Rate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0%</div>
              <p className="text-xs text-slate-600 mt-1">Applications awarded</p>
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
              <div className="text-2xl font-bold">$0</div>
              <p className="text-xs text-slate-600 mt-1">Lifetime funding</p>
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
              <div className="text-2xl font-bold">—</div>
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
              <div className="text-2xl font-bold">—</div>
              <p className="text-xs text-slate-600 mt-1">Overall score</p>
            </CardContent>
          </Card>
        </div>

        {/* Main Analytics Tabs */}
        <Tabs defaultValue="trends" className="space-y-4">
          <TabsList>
            <TabsTrigger value="trends">Performance Trends</TabsTrigger>
            <TabsTrigger value="winrate">Win Rate Analysis</TabsTrigger>
            <TabsTrigger value="portfolio">Portfolio Health</TabsTrigger>
            <TabsTrigger value="geography">Geographic Analysis</TabsTrigger>
          </TabsList>

          <TabsContent value="trends" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Grant Submission & Award Trends</CardTitle>
                <CardDescription>
                  Track submission volume and success rate over time
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-80 flex items-center justify-center border-2 border-dashed border-slate-200 rounded-lg">
                  <div className="text-center">
                    <BarChart3 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">Performance Chart</h3>
                    <p className="text-sm text-slate-600">
                      Submit grants to see performance trends and analytics
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="winrate" className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Win Rate by Category</CardTitle>
                  <CardDescription>Success rate across different grant types</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-64 flex items-center justify-center border-2 border-dashed border-slate-200 rounded-lg">
                    <div className="text-center">
                      <PieChart className="w-12 h-12 mx-auto text-slate-300 mb-2" />
                      <p className="text-sm text-slate-600">No data available</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Win Rate by Funder</CardTitle>
                  <CardDescription>Success rate with different funders</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-64 flex items-center justify-center border-2 border-dashed border-slate-200 rounded-lg">
                    <div className="text-center">
                      <BarChart3 className="w-12 h-12 mx-auto text-slate-300 mb-2" />
                      <p className="text-sm text-slate-600">No data available</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="portfolio" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Portfolio Health Dashboard</CardTitle>
                <CardDescription>
                  Overall health metrics for your grant portfolio
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid md:grid-cols-3 gap-4">
                    <Card className="border-2">
                      <CardContent className="p-4">
                        <div className="text-sm font-medium text-slate-600 mb-2">Active Grants</div>
                        <div className="text-2xl font-bold">0</div>
                      </CardContent>
                    </Card>
                    <Card className="border-2">
                      <CardContent className="p-4">
                        <div className="text-sm font-medium text-slate-600 mb-2">In Progress</div>
                        <div className="text-2xl font-bold">0</div>
                      </CardContent>
                    </Card>
                    <Card className="border-2">
                      <CardContent className="p-4">
                        <div className="text-sm font-medium text-slate-600 mb-2">Under Review</div>
                        <div className="text-2xl font-bold">0</div>
                      </CardContent>
                    </Card>
                  </div>
                  <div className="h-64 flex items-center justify-center border-2 border-dashed border-slate-200 rounded-lg">
                    <div className="text-center">
                      <Target className="w-12 h-12 mx-auto text-slate-300 mb-2" />
                      <p className="text-sm text-slate-600">Portfolio visualization will appear here</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="geography" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Geographic Distribution</CardTitle>
                <CardDescription>
                  Analyze grant distribution and success by location
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-96 flex items-center justify-center border-2 border-dashed border-slate-200 rounded-lg">
                  <div className="text-center">
                    <LineChart className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">Geographic Map</h3>
                    <p className="text-sm text-slate-600">
                      Geographic analysis will be displayed here
                    </p>
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
