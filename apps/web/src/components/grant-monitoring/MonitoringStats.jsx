import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Target, AlertCircle, AlertTriangle, Clock, TrendingUp } from 'lucide-react';

/**
 * Statistics cards for monitoring overview
 */
export default function MonitoringStats({ stats }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-6 mb-8">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-500">Active Grants</div>
              <div className="text-3xl font-bold text-slate-900 mt-1">
                {stats.totalActive}
              </div>
            </div>
            <Target className="w-10 h-10 text-blue-500 opacity-50" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-500">Critical Alerts</div>
              <div className="text-3xl font-bold text-red-600 mt-1">
                {stats.criticalAlerts}
              </div>
            </div>
            <AlertCircle className="w-10 h-10 text-red-500 opacity-50" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-500">High Priority</div>
              <div className="text-3xl font-bold text-orange-600 mt-1">
                {stats.highAlerts}
              </div>
            </div>
            <AlertTriangle className="w-10 h-10 text-orange-500 opacity-50" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-500">Deadlines</div>
              <div className="text-3xl font-bold text-amber-600 mt-1">
                {stats.upcomingDeadlines}
              </div>
            </div>
            <Clock className="w-10 h-10 text-amber-500 opacity-50" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-500">New Matches</div>
              <div className="text-3xl font-bold text-emerald-600 mt-1">
                {stats.newMatches}
              </div>
            </div>
            <TrendingUp className="w-10 h-10 text-emerald-500 opacity-50" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}