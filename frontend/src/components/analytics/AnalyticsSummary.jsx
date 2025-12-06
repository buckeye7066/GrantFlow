import React, { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Target, TrendingUp, DollarSign, Clock } from 'lucide-react';

export default function AnalyticsSummary({ grants }) {
  const stats = useMemo(() => {
    const total = grants.length;
    const awarded = grants.filter(g => g.status === 'awarded').length;
    const declined = grants.filter(g => g.status === 'declined').length;
    const inProgress = grants.filter(g => ['interested', 'drafting', 'submitted'].includes(g.status)).length;
    
    const successRate = total > 0 ? ((awarded / (awarded + declined)) * 100).toFixed(1) : 0;
    
    const avgTimeToSubmit = grants
      .filter(g => g.submission_date)
      .reduce((acc, g) => {
        const created = new Date(g.created_date);
        const submitted = new Date(g.submission_date);
        const days = Math.floor((submitted - created) / (1000 * 60 * 60 * 24));
        return acc + days;
      }, 0) / grants.filter(g => g.submission_date).length || 0;

    return {
      total,
      awarded,
      declined,
      inProgress,
      successRate,
      avgTimeToSubmit: Math.round(avgTimeToSubmit)
    };
  }, [grants]);

  return (
    <div className="grid md:grid-cols-4 gap-4">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">Total Grants</p>
              <p className="text-3xl font-bold text-slate-900">{stats.total}</p>
            </div>
            <Target className="w-10 h-10 text-blue-600 opacity-20" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">Success Rate</p>
              <p className="text-3xl font-bold text-green-600">{stats.successRate}%</p>
              <p className="text-xs text-slate-500 mt-1">{stats.awarded} awarded</p>
            </div>
            <TrendingUp className="w-10 h-10 text-green-600 opacity-20" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">In Progress</p>
              <p className="text-3xl font-bold text-amber-600">{stats.inProgress}</p>
            </div>
            <Clock className="w-10 h-10 text-amber-600 opacity-20" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">Avg. Time to Submit</p>
              <p className="text-3xl font-bold text-purple-600">{stats.avgTimeToSubmit}</p>
              <p className="text-xs text-slate-500 mt-1">days</p>
            </div>
            <DollarSign className="w-10 h-10 text-purple-600 opacity-20" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}