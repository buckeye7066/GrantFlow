import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Trophy, TrendingUp } from 'lucide-react';

export default function TeamPerformance({ grants }) {
  const teamStats = useMemo(() => {
    const byMember = {};

    grants.forEach(grant => {
      const member = grant.created_by || 'Unknown';
      
      if (!byMember[member]) {
        byMember[member] = {
          name: member,
          total: 0,
          awarded: 0,
          declined: 0,
          inProgress: 0
        };
      }

      byMember[member].total++;
      
      if (grant.status === 'awarded') byMember[member].awarded++;
      if (grant.status === 'declined') byMember[member].declined++;
      if (['interested', 'drafting', 'submitted'].includes(grant.status)) {
        byMember[member].inProgress++;
      }
    });

    const teamData = Object.values(byMember).map(member => ({
      ...member,
      successRate: member.awarded + member.declined > 0
        ? ((member.awarded / (member.awarded + member.declined)) * 100).toFixed(1)
        : 0
    })).sort((a, b) => b.total - a.total);

    const topPerformer = teamData.reduce((best, current) => {
      const currentRate = parseFloat(current.successRate);
      const bestRate = parseFloat(best?.successRate || 0);
      return currentRate > bestRate && current.awarded >= 3 ? current : best;
    }, null);

    return { teamData, topPerformer };
  }, [grants]);

  return (
    <div className="space-y-6">
      {teamStats.topPerformer && (
        <Card className="bg-gradient-to-br from-amber-50 to-yellow-50 border-amber-200">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Trophy className="w-8 h-8 text-amber-600" />
              <div>
                <p className="text-sm font-medium text-slate-600">Top Performer</p>
                <p className="text-xl font-bold text-slate-900">{teamStats.topPerformer.name}</p>
                <p className="text-sm text-slate-600">
                  {teamStats.topPerformer.successRate}% success rate • {teamStats.topPerformer.awarded} awarded
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Team Member Performance</CardTitle>
          <CardDescription>
            Grant applications and success rates by team member
          </CardDescription>
        </CardHeader>
        <CardContent>
          {teamStats.teamData.length > 0 ? (
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={teamStats.teamData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="awarded" fill="#10b981" name="Awarded" />
                <Bar dataKey="declined" fill="#ef4444" name="Declined" />
                <Bar dataKey="inProgress" fill="#f59e0b" name="In Progress" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[400px] flex items-center justify-center text-slate-500">
              No team performance data available
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detailed Team Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {teamStats.teamData.map((member, idx) => (
              <div key={idx} className="flex items-center justify-between p-4 border rounded-lg hover:bg-slate-50 transition-colors">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-slate-900">{member.name}</p>
                    {parseFloat(member.successRate) >= 70 && member.awarded >= 3 && (
                      <Badge className="bg-green-100 text-green-800">High Performer</Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-600 mt-1">
                    {member.total} total grants • {member.awarded} awarded • {member.declined} declined
                  </p>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-1">
                    <TrendingUp className={`w-4 h-4 ${parseFloat(member.successRate) >= 50 ? 'text-green-600' : 'text-slate-400'}`} />
                    <p className="text-2xl font-bold text-slate-900">{member.successRate}%</p>
                  </div>
                  <p className="text-xs text-slate-500">success rate</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}