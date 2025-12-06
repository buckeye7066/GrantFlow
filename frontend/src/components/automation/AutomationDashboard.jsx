import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatDateSafe } from '@/components/shared/dateUtils';
import {
  Zap,
  Clock,
  Target,
  Bell,
  CheckCircle2,
  AlertTriangle,
  TrendingUp,
  Calendar
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

/**
 * AutomationDashboard - Shows automation status and notifications
 */
export default function AutomationDashboard({ organizationId }) {
  // Fetch automation settings
  const { data: settings } = useQuery({
    queryKey: ['automationSettings', organizationId],
    queryFn: async () => {
      if (!organizationId) return null;
      const allSettings = await base44.entities.AutomationSettings.filter({ 
        organization_id: organizationId 
      });
      return allSettings[0];
    },
    enabled: !!organizationId
  });

  // Fetch recent automation activity
  const { data: recentActivity = [] } = useQuery({
    queryKey: ['recentAutomationActivity', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      return await base44.entities.TimeEntry.filter(
        { organization_id: organizationId, source: 'auto' },
        '-created_date',
        10
      );
    },
    enabled: !!organizationId,
    refetchInterval: 30000 // Refresh every 30 seconds
  });

  // Fetch unacknowledged alerts
  const { data: alerts = [] } = useQuery({
    queryKey: ['automationAlerts', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      return await base44.entities.GrantMonitoringLog.filter({
        organization_id: organizationId,
        acknowledged: false
      }, '-created_date');
    },
    enabled: !!organizationId,
    refetchInterval: 60000 // Refresh every minute
  });

  if (!organizationId || !settings) {
    return null;
  }

  const totalActivityMinutes = recentActivity.reduce((sum, entry) => sum + (entry.rounded_minutes || 0), 0);
  const criticalAlerts = alerts.filter(a => a.severity === 'critical');
  const highAlerts = alerts.filter(a => a.severity === 'high');

  return (
    <div className="space-y-4">
      {/* Automation Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className={settings.daily_discovery_enabled ? 'border-blue-200 bg-blue-50' : ''}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <Target className="w-5 h-5 text-blue-600" />
              <Badge variant={settings.daily_discovery_enabled ? 'default' : 'outline'}>
                {settings.daily_discovery_enabled ? 'Active' : 'Off'}
              </Badge>
            </div>
            <p className="text-sm font-medium text-slate-900">Daily Discovery</p>
            {settings.last_discovery_run && (
              <p className="text-xs text-slate-600 mt-1">
                Last: {formatDateSafe(settings.last_discovery_run, 'MMM d, h:mm a')}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className={settings.auto_analyze_enabled ? 'border-purple-200 bg-purple-50' : ''}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <Zap className="w-5 h-5 text-purple-600" />
              <Badge variant={settings.auto_analyze_enabled ? 'default' : 'outline'}>
                {settings.auto_analyze_enabled ? 'Active' : 'Off'}
              </Badge>
            </div>
            <p className="text-sm font-medium text-slate-900">Auto-Analyze</p>
            <p className="text-xs text-slate-600 mt-1">
              Min score: {settings.min_match_score}%
            </p>
          </CardContent>
        </Card>

        <Card className={settings.auto_advance_enabled ? 'border-emerald-200 bg-emerald-50' : ''}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <TrendingUp className="w-5 h-5 text-emerald-600" />
              <Badge variant={settings.auto_advance_enabled ? 'default' : 'outline'}>
                {settings.auto_advance_enabled ? 'Active' : 'Off'}
              </Badge>
            </div>
            <p className="text-sm font-medium text-slate-900">Auto-Advance</p>
            {settings.last_auto_advance_run && (
              <p className="text-xs text-slate-600 mt-1">
                Last: {formatDateSafe(settings.last_auto_advance_run, 'MMM d, h:mm a')}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className={settings.time_tracking_enabled ? 'border-amber-200 bg-amber-50' : ''}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <Clock className="w-5 h-5 text-amber-600" />
              <Badge variant={settings.time_tracking_enabled ? 'default' : 'outline'}>
                {settings.time_tracking_enabled ? 'Active' : 'Off'}
              </Badge>
            </div>
            <p className="text-sm font-medium text-slate-900">Time Tracking</p>
            <p className="text-xs text-slate-600 mt-1">
              Idle timeout: {settings.idle_timeout_minutes} min
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Critical Alerts */}
      {criticalAlerts.length > 0 && (
        <Alert className="border-red-300 bg-red-50">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-900">
            <div className="flex items-center justify-between">
              <div>
                <strong>{criticalAlerts.length} Critical Alert{criticalAlerts.length !== 1 ? 's' : ''}</strong>
                <p className="text-sm mt-1">
                  {criticalAlerts[0].event_data?.message || 'Immediate attention required'}
                </p>
              </div>
              <Link to={createPageUrl('GrantMonitoring')}>
                <Badge variant="destructive">View All</Badge>
              </Link>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Recent Activity & Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Automation Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="w-4 h-4 text-blue-600" />
              Recent Automation Activity
            </CardTitle>
            <CardDescription>
              Last 10 automated tasks • {totalActivityMinutes} min billed
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">
                No recent automation activity
              </p>
            ) : (
              <div className="space-y-2">
                {recentActivity.map((entry, idx) => (
                  <div key={idx} className="flex items-center justify-between text-sm p-2 rounded-lg bg-slate-50">
                    <div className="flex-1 min-w-0">
                      <p className="text-slate-900 truncate">{entry.note}</p>
                      <p className="text-xs text-slate-500">
                        {formatDateSafe(entry.created_date, 'MMM d, h:mm a')}
                      </p>
                    </div>
                    <Badge variant="outline" className="ml-2">
                      {entry.rounded_minutes} min
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active Alerts */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bell className="w-4 h-4 text-amber-600" />
              Active Alerts
            </CardTitle>
            <CardDescription>
              {alerts.length} unacknowledged notification{alerts.length !== 1 ? 's' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {alerts.length === 0 ? (
              <div className="text-center py-4">
                <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-600 mb-2" />
                <p className="text-sm text-slate-500">All caught up!</p>
              </div>
            ) : (
              <div className="space-y-2">
                {alerts.slice(0, 5).map((alert) => (
                  <Link 
                    key={alert.id}
                    to={createPageUrl(`GrantDetail?id=${alert.grant_id}`)}
                    className="block"
                  >
                    <div className={`p-3 rounded-lg border transition-colors hover:bg-slate-50 ${
                      alert.severity === 'critical' ? 'border-red-200 bg-red-50' :
                      alert.severity === 'high' ? 'border-amber-200 bg-amber-50' :
                      'border-slate-200'
                    }`}>
                      <div className="flex items-start gap-2">
                        {alert.event_type === 'deadline_approaching' && (
                          <Calendar className="w-4 h-4 text-amber-600 mt-0.5" />
                        )}
                        {alert.event_type === 'alert_triggered' && (
                          <Bell className="w-4 h-4 text-blue-600 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-900">
                            {alert.event_data?.message}
                          </p>
                          <p className="text-xs text-slate-600 mt-1">
                            {formatDateSafe(alert.created_date, 'MMM d, h:mm a')}
                          </p>
                        </div>
                        <Badge variant={
                          alert.severity === 'critical' ? 'destructive' :
                          alert.severity === 'high' ? 'default' : 'outline'
                        }>
                          {alert.severity}
                        </Badge>
                      </div>
                    </div>
                  </Link>
                ))}
                {alerts.length > 5 && (
                  <Link to={createPageUrl('GrantMonitoring')}>
                    <div className="text-center py-2 text-sm text-blue-600 hover:underline">
                      View {alerts.length - 5} more alert{alerts.length - 5 !== 1 ? 's' : ''}
                    </div>
                  </Link>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}