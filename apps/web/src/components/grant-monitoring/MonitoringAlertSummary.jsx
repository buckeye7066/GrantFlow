import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bell, CheckCircle, BellOff } from 'lucide-react';

/**
 * Summary of active alert types
 */
export default function MonitoringAlertSummary({ alertConfigs }) {
  const alertTypes = ['deadline_approaching', 'status_change', 'new_match', 'milestone_due'];

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="w-5 h-5" />
          Active Alert Types ({alertConfigs.filter(a => a.enabled).length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {alertTypes.map(type => {
            const config = alertConfigs.find(a => a.alert_type === type);
            const isEnabled = config?.enabled;
            
            return (
              <div key={type} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-2">
                  {isEnabled ? (
                    <CheckCircle className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <BellOff className="w-4 h-4 text-slate-400" />
                  )}
                  <span className="text-sm font-medium capitalize">
                    {type.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}