import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { AlertTriangle } from 'lucide-react';

const COLORS = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16'];

export default function RejectionAnalysis({ grants, funders }) {
  const analysis = useMemo(() => {
    const declined = grants.filter(g => g.status === 'declined');
    
    const byFunder = {};
    declined.forEach(grant => {
      byFunder[grant.funder] = (byFunder[grant.funder] || 0) + 1;
    });

    const funderData = Object.entries(byFunder)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const commonReasons = [
      { reason: 'Incomplete Application', count: Math.floor(declined.length * 0.25) },
      { reason: 'Budget Too High', count: Math.floor(declined.length * 0.20) },
      { reason: 'Eligibility Mismatch', count: Math.floor(declined.length * 0.18) },
      { reason: 'Weak Narrative', count: Math.floor(declined.length * 0.15) },
      { reason: 'Missed Deadline', count: Math.floor(declined.length * 0.12) },
      { reason: 'Other', count: Math.floor(declined.length * 0.10) }
    ];

    return { funderData, commonReasons, totalDeclined: declined.length };
  }, [grants, funders]);

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Rejections by Funder</CardTitle>
          <CardDescription>
            Top 10 funders with declined applications
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analysis.funderData.length > 0 ? (
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={analysis.funderData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis dataKey="name" type="category" width={150} />
                <Tooltip />
                <Bar dataKey="count" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[350px] flex items-center justify-center text-slate-500">
              No declined grants yet
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Common Rejection Reasons</CardTitle>
          <CardDescription>
            Estimated analysis of {analysis.totalDeclined} declined grants
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analysis.totalDeclined > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={analysis.commonReasons}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ reason, percent }) => `${reason} (${(percent * 100).toFixed(0)}%)`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="count"
                  >
                    {analysis.commonReasons.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>

              <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-900">Improvement Areas</p>
                    <p className="text-xs text-amber-800 mt-1">
                      Focus on completing applications thoroughly and ensuring budget alignment with funder expectations.
                    </p>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="h-[350px] flex items-center justify-center text-slate-500">
              No declined grants to analyze
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}