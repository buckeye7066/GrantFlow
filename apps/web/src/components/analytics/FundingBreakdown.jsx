import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

export default function FundingBreakdown({ grants, funders }) {
  const breakdown = useMemo(() => {
    const byType = {};
    const byFunder = {};

    grants.forEach(grant => {
      const funder = funders.find(f => f.name === grant.funder);
      const type = funder?.funder_type || 'other';
      
      byType[type] = (byType[type] || 0) + 1;
      byFunder[grant.funder] = (byFunder[grant.funder] || 0) + 1;
    });

    const typeData = Object.entries(byType).map(([name, value]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      value
    }));

    const funderData = Object.entries(byFunder)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return { typeData, funderData };
  }, [grants, funders]);

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Funding by Type</CardTitle>
          <CardDescription>
            Distribution of grants across funder types
          </CardDescription>
        </CardHeader>
        <CardContent>
          {breakdown.typeData.length > 0 ? (
            <ResponsiveContainer width="100%" height={400}>
              <PieChart>
                <Pie
                  data={breakdown.typeData}
                  cx="50%"
                  cy="50%"
                  labelLine={true}
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  outerRadius={120}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {breakdown.typeData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[400px] flex items-center justify-center text-slate-500">
              No funding data available
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top Funding Sources</CardTitle>
          <CardDescription>
            Most active funders in your pipeline
          </CardDescription>
        </CardHeader>
        <CardContent>
          {breakdown.funderData.length > 0 ? (
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={breakdown.funderData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" angle={-45} textAnchor="end" height={100} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="count" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[400px] flex items-center justify-center text-slate-500">
              No funder data available
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}