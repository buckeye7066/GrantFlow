import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart3, TrendingUp, PieChart, Users, Calendar, Loader2 } from 'lucide-react';

import SuccessRateChart from '@/components/analytics/SuccessRateChart';
import RejectionAnalysis from '@/components/analytics/RejectionAnalysis';
import FundingBreakdown from '@/components/analytics/FundingBreakdown';
import TeamPerformance from '@/components/analytics/TeamPerformance';
import TrendPredictions from '@/components/analytics/TrendPredictions';
import AnalyticsSummary from '@/components/analytics/AnalyticsSummary';

export default function AdvancedAnalytics() {
  const [timeRange, setTimeRange] = useState('all');
  const [selectedOrg, setSelectedOrg] = useState('all');

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: async () => {
      try {
        return await base44.auth.me();
      } catch (error) {
        console.error('[AdvancedAnalytics] Auth error:', error);
        return null;
      }
    },
  });

  const isAdmin = user?.role === 'admin';

  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', user?.email, isAdmin],
    queryFn: () => {
      if (!isAdmin) {
        return base44.entities.Grant.filter({ created_by: user?.email });
      }
      return base44.entities.Grant.list();
    },
    enabled: !!user?.email,
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Organization.list()
      : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const { data: funders = [] } = useQuery({
    queryKey: ['funders'],
    queryFn: async () => {
      const list = await base44.entities.Funder.list();
      return Array.isArray(list) ? list : [];
    },
    enabled: !!user?.email,
  });

  const filteredGrants = useMemo(() => {
    let filtered = grants;

    if (selectedOrg !== 'all') {
      filtered = filtered.filter(g => g.organization_id === selectedOrg);
    }

    if (timeRange !== 'all') {
      const now = new Date();
      const cutoff = new Date();
      
      switch(timeRange) {
        case '30d':
          cutoff.setDate(now.getDate() - 30);
          break;
        case '90d':
          cutoff.setDate(now.getDate() - 90);
          break;
        case '1y':
          cutoff.setFullYear(now.getFullYear() - 1);
          break;
      }
      
      filtered = filtered.filter(g => {
        const d = new Date(g.created_date || g.created_at || g.createdAt);
        return !isNaN(d) && d >= cutoff;
      });
    }

    return filtered;
  }, [grants, selectedOrg, timeRange]);

  if (isLoadingGrants) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <BarChart3 className="w-8 h-8 text-blue-600" />
            Advanced Analytics Dashboard
          </h1>
          <p className="text-slate-600 mt-1">Deep insights into your grant application process</p>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Time Range</label>
                <Select value={timeRange} onValueChange={setTimeRange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Time</SelectItem>
                    <SelectItem value="30d">Last 30 Days</SelectItem>
                    <SelectItem value="90d">Last 90 Days</SelectItem>
                    <SelectItem value="1y">Last Year</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Organization</label>
                <Select value={selectedOrg} onValueChange={setSelectedOrg}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Organizations</SelectItem>
                    {organizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <AnalyticsSummary grants={filteredGrants} />

        <Tabs defaultValue="success" className="space-y-6">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="success">
              <TrendingUp className="w-4 h-4 mr-2" />
              Success Rates
            </TabsTrigger>
            <TabsTrigger value="rejection">
              <Calendar className="w-4 h-4 mr-2" />
              Rejections
            </TabsTrigger>
            <TabsTrigger value="funding">
              <PieChart className="w-4 h-4 mr-2" />
              Funding
            </TabsTrigger>
            <TabsTrigger value="team">
              <Users className="w-4 h-4 mr-2" />
              Team
            </TabsTrigger>
            <TabsTrigger value="trends">
              <BarChart3 className="w-4 h-4 mr-2" />
              Predictions
            </TabsTrigger>
          </TabsList>

          <TabsContent value="success">
            <SuccessRateChart grants={filteredGrants} />
          </TabsContent>

          <TabsContent value="rejection">
            <RejectionAnalysis grants={filteredGrants} funders={funders} />
          </TabsContent>

          <TabsContent value="funding">
            <FundingBreakdown grants={filteredGrants} funders={funders} />
          </TabsContent>

          <TabsContent value="team">
            <TeamPerformance grants={filteredGrants} />
          </TabsContent>

          <TabsContent value="trends">
            <TrendPredictions grants={filteredGrants} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}