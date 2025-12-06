import React, { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bell, Check, X, Calendar, AlertTriangle, FileText, Target } from 'lucide-react';
import { formatDateSafe } from '@/components/shared/dateUtils';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useToast } from '@/components/ui/use-toast';

/**
 * NotificationCenter - Displays all automation alerts and notifications
 */
export default function NotificationCenter({ organizationId, compact = false }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch alerts
  const { data: alerts = [] } = useQuery({
    queryKey: ['automationAlerts', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      return await base44.entities.GrantMonitoringLog.filter(
        { organization_id: organizationId, acknowledged: false },
        '-created_date'
      );
    },
    enabled: !!organizationId,
    refetchInterval: 30000 // Refresh every 30 seconds
  });

  // Acknowledge mutation
  const acknowledgeMutation = useMutation({
    mutationFn: (alertId) => 
      base44.entities.GrantMonitoringLog.update(alertId, {
        acknowledged: true,
        acknowledged_at: new Date().toISOString()
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automationAlerts'] });
      toast({
        title: '✓ Alert Acknowledged',
        description: 'Notification has been marked as read',
      });
    }
  });

  // Dismiss all mutation
  const dismissAllMutation = useMutation({
    mutationFn: async () => {
      await Promise.all(
        alerts.map(alert => 
          base44.entities.GrantMonitoringLog.update(alert.id, {
            acknowledged: true,
            acknowledged_at: new Date().toISOString()
          })
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automationAlerts'] });
      toast({
        title: '✓ All Alerts Cleared',
        description: 'All notifications have been acknowledged',
      });
    }
  });

  const groupedAlerts = useMemo(() => {
    return {
      critical: alerts.filter(a => a.severity === 'critical'),
      high: alerts.filter(a => a.severity === 'high'),
      medium: alerts.filter(a => a.severity === 'medium'),
      low: alerts.filter(a => a.severity === 'low')
    };
  }, [alerts]);

  const getAlertIcon = (eventType) => {
    switch (eventType) {
      case 'deadline_approaching': return Calendar;
      case 'alert_triggered': return Bell;
      case 'status_changed': return Target;
      default: return FileText;
    }
  };

  if (!organizationId) return null;

  if (compact) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bell className="w-4 h-4" />
              Notifications
            </CardTitle>
            <Badge>{alerts.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">
              No new notifications
            </p>
          ) : (
            <div className="space-y-2">
              {alerts.slice(0, 3).map(alert => {
                const Icon = getAlertIcon(alert.event_type);
                return (
                  <Link
                    key={alert.id}
                    to={createPageUrl(`GrantDetail?id=${alert.grant_id}`)}
                    className="block"
                  >
                    <div className={`p-2 rounded-lg text-sm border ${
                      alert.severity === 'critical' ? 'border-red-200 bg-red-50' :
                      alert.severity === 'high' ? 'border-amber-200 bg-amber-50' :
                      'border-slate-200 bg-slate-50'
                    }`}>
                      <div className="flex items-start gap-2">
                        <Icon className="w-4 h-4 mt-0.5 text-slate-600" />
                        <p className="flex-1 truncate">{alert.event_data?.message}</p>
                      </div>
                    </div>
                  </Link>
                );
              })}
              {alerts.length > 3 && (
                <Link to={createPageUrl('GrantMonitoring')}>
                  <p className="text-xs text-blue-600 hover:underline text-center pt-2">
                    View {alerts.length - 3} more
                  </p>
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Bell className="w-5 h-5 text-blue-600" />
            Notification Center
          </CardTitle>
          {alerts.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => dismissAllMutation.mutate()}
              disabled={dismissAllMutation.isPending}
            >
              <Check className="w-4 h-4 mr-1" />
              Clear All
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <div className="text-center py-12">
            <Check className="w-16 h-16 mx-auto text-emerald-600 mb-4" />
            <h3 className="text-lg font-semibold text-slate-900 mb-2">All Caught Up!</h3>
            <p className="text-slate-600">No pending notifications</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Critical Alerts */}
            {groupedAlerts.critical.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  Critical ({groupedAlerts.critical.length})
                </h4>
                <div className="space-y-2">
                  {groupedAlerts.critical.map(alert => {
                    const Icon = getAlertIcon(alert.event_type);
                    return (
                      <div
                        key={alert.id}
                        className="border-2 border-red-200 bg-red-50 rounded-lg p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 flex-1">
                            <Icon className="w-5 h-5 text-red-600 mt-0.5" />
                            <div className="flex-1">
                              <Link
                                to={createPageUrl(`GrantDetail?id=${alert.grant_id}`)}
                                className="font-medium text-red-900 hover:underline"
                              >
                                {alert.event_data?.message}
                              </Link>
                              <p className="text-xs text-red-700 mt-1">
                                {formatDateSafe(alert.created_date, 'MMM d, h:mm a')}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => acknowledgeMutation.mutate(alert.id)}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* High Priority Alerts */}
            {groupedAlerts.high.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-amber-700 mb-2">
                  High Priority ({groupedAlerts.high.length})
                </h4>
                <div className="space-y-2">
                  {groupedAlerts.high.map(alert => {
                    const Icon = getAlertIcon(alert.event_type);
                    return (
                      <div
                        key={alert.id}
                        className="border border-amber-200 bg-amber-50 rounded-lg p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 flex-1">
                            <Icon className="w-4 h-4 text-amber-600 mt-0.5" />
                            <div className="flex-1">
                              <Link
                                to={createPageUrl(`GrantDetail?id=${alert.grant_id}`)}
                                className="text-sm font-medium text-amber-900 hover:underline"
                              >
                                {alert.event_data?.message}
                              </Link>
                              <p className="text-xs text-amber-700 mt-1">
                                {formatDateSafe(alert.created_date, 'MMM d, h:mm a')}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => acknowledgeMutation.mutate(alert.id)}
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Medium/Low Alerts */}
            {(groupedAlerts.medium.length > 0 || groupedAlerts.low.length > 0) && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-2">
                  Other ({groupedAlerts.medium.length + groupedAlerts.low.length})
                </h4>
                <div className="space-y-1">
                  {[...groupedAlerts.medium, ...groupedAlerts.low].map(alert => {
                    const Icon = getAlertIcon(alert.event_type);
                    return (
                      <div
                        key={alert.id}
                        className="border border-slate-200 bg-white rounded-lg p-2 flex items-center justify-between gap-2"
                      >
                        <Link
                          to={createPageUrl(`GrantDetail?id=${alert.grant_id}`)}
                          className="flex items-center gap-2 flex-1 min-w-0"
                        >
                          <Icon className="w-3 h-3 text-slate-500 flex-shrink-0" />
                          <p className="text-xs text-slate-700 truncate">
                            {alert.event_data?.message}
                          </p>
                        </Link>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 flex-shrink-0"
                          onClick={() => acknowledgeMutation.mutate(alert.id)}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}