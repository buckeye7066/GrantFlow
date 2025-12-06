import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { TrendingUp, DollarSign, Target, Award } from 'lucide-react';

/**
 * Performance Analytics - Success rates, award amounts, and trends
 */
export default function PerformanceAnalytics({ grants, dateRange = 'all' }) {
  const analytics = useMemo(() => {
    const submitted = grants.filter(g => ['submitted', 'awarded', 'declined'].includes(g.status));
    const awarded = grants.filter(g => g.status === 'awarded');
    const declined = grants.filter(g => g.status === 'declined');
    
    // Success rate
    const successRate = submitted.length > 0 
      ? (awarded.length / submitted.length) * 100 
      : 0;

    // Average award amount
    const totalAwarded = awarded.reduce((sum, g) => {
      const amount = g.award_ceiling || g.award_floor || 0;
      return sum + amount;
    }, 0);
    const avgAward = awarded.length > 0 ? totalAwarded / awarded.length : 0;

    // Award size distribution
    const awardRanges = [
      { range: '$0-$10K', min: 0, max: 10000, count: 0, color: '#3b82f6' },
      { range: '$10K-$50K', min: 10000, max: 50000, count: 0, color: '#8b5cf6' },
      { range: '$50K-$100K', min: 50000, max: 100000, count: 0, color: '#ec4899' },
      { range: '$100K-$500K', min: 100000, max: 500000, count: 0, color: '#f59e0b' },
      { range: '$500K+', min: 500000, max: Infinity, count: 0, color: '#10b981' }
    ];

    awarded.forEach(grant => {
      const amount = grant.award_ceiling || grant.award_floor || 0;
      const range = awardRanges.find(r => amount >= r.min && amount < r.max);
      if (range) range.count++;
    });

    // Monthly trends
    const monthlyData = {};
    submitted.forEach(grant => {
      const date = new Date(grant.created_date);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { month: monthKey, submitted: 0, awarded: 0, declined: 0 };
      }
      
      monthlyData[monthKey].submitted++;
      if (grant.status === 'awarded') monthlyData[monthKey].awarded++;
      if (grant.status === 'declined') monthlyData[monthKey].declined++;
    });

    const monthlyTrends = Object.values(monthlyData).sort((a, b) => 
      a.month.localeCompare(b.month)
    ).slice(-12); // Last 12 months

    // Funder type performance
    const funderStats = {};
    awarded.forEach(grant => {
      const type = grant.funder_type || 'unknown';
      if (!funderStats[type]) {
        funderStats[type] = { type, count: 0, totalAmount: 0 };
      }
      funderStats[type].count++;
      funderStats[type].totalAmount += (grant.award_ceiling || grant.award_floor || 0);
    });

    const funderPerformance = Object.values(funderStats).map(stat => ({
      ...stat,
      avgAmount: stat.totalAmount / stat.count
    }));

    return {
      successRate,
      avgAward,
      totalAwarded,
      awardedCount: awarded.length,
      submittedCount: submitted.length,
      declinedCount: declined.length,
      awardRanges: awardRanges.filter(r => r.count > 0),
      monthlyTrends,
      funderPerformance
    };
  }, [grants, dateRange]);

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <Target className="w-5 h-5 text-blue-600" />
              <span className="text-2xl font-bold text-blue-600">
                {analytics.successRate.toFixed(1)}%
              </span>
            </div>
            <p className="text-sm font-medium text-slate-900">Success Rate</p>
            <p className="text-xs text-slate-500 mt-1">
              {analytics.awardedCount} of {analytics.submittedCount} submitted
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <DollarSign className="w-5 h-5 text-emerald-600" />
              <span className="text-2xl font-bold text-emerald-600">
                ${(analytics.avgAward / 1000).toFixed(0)}K
              </span>
            </div>
            <p className="text-sm font-medium text-slate-900">Avg Award</p>
            <p className="text-xs text-slate-500 mt-1">
              Per successful grant
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <Award className="w-5 h-5 text-purple-600" />
              <span className="text-2xl font-bold text-purple-600">
                ${(analytics.totalAwarded / 1000000).toFixed(2)}M
              </span>
            </div>
            <p className="text-sm font-medium text-slate-900">Total Awarded</p>
            <p className="text-xs text-slate-500 mt-1">
              All time
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <TrendingUp className="w-5 h-5 text-amber-600" />
              <span className="text-2xl font-bold text-amber-600">
                {analytics.submittedCount}
              </span>
            </div>
            <p className="text-sm font-medium text-slate-900">Applications</p>
            <p className="text-xs text-slate-500 mt-1">
              {analytics.declinedCount} declined
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Monthly Trends */}
      {analytics.monthlyTrends.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Application Trends</CardTitle>
            <CardDescription>Monthly submission and success rates</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={analytics.monthlyTrends}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="month" 
                  tick={{ fontSize: 12 }}
                />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line 
                  type="monotone" 
                  dataKey="submitted" 
                  stroke="#3b82f6" 
                  name="Submitted"
                  strokeWidth={2}
                />
                <Line 
                  type="monotone" 
                  dataKey="awarded" 
                  stroke="#10b981" 
                  name="Awarded"
                  strokeWidth={2}
                />
                <Line 
                  type="monotone" 
                  dataKey="declined" 
                  stroke="#ef4444" 
                  name="Declined"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Award Size Distribution */}
        {analytics.awardRanges.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Award Size Distribution</CardTitle>
              <CardDescription>Grants by funding level</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={analytics.awardRanges}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={(entry) => `${entry.range} (${entry.count})`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="count"
                  >
                    {analytics.awardRanges.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Funder Type Performance */}
        {analytics.funderPerformance.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Performance by Funder Type</CardTitle>
              <CardDescription>Success rates by funder category</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={analytics.funderPerformance}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="type" 
                    tick={{ fontSize: 12 }}
                    angle={-45}
                    textAnchor="end"
                    height={80}
                  />
                  <YAxis />
                  <Tooltip 
                    formatter={(value) => `$${(value / 1000).toFixed(0)}K`}
                  />
                  <Legend />
                  <Bar dataKey="count" fill="#3b82f6" name="Awards Won" />
                  <Bar dataKey="avgAmount" fill="#10b981" name="Avg Amount" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}