import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Bell, CheckCircle2, Calendar, AlertCircle, X, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

export default function NotificationCenter({ organizationId }) {
  const queryClient = useQueryClient();
  const [expandedAlert, setExpandedAlert] = useState(null);

  // Fetch alerts
  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ['grantAlerts', organizationId],
    queryFn: async () => {
      const allAlerts = organizationId
        ? await base44.entities.GrantAlert.filter({ 
            organization_id: organizationId 
          }, '-sent_at')
        : await base44.entities.GrantAlert.list('-sent_at');
      
      return allAlerts.slice(0, 20); // Latest 20
    },
    refetchInterval: 30000 // Refresh every 30 seconds
  });

  // Mark as read mutation
  const markReadMutation = useMutation({
    mutationFn: (alertId) => base44.entities.GrantAlert.update(alertId, { read: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grantAlerts'] });
    }
  });

  // Dismiss alert mutation
  const dismissMutation = useMutation({
    mutationFn: (alertId) => base44.entities.GrantAlert.delete(alertId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grantAlerts'] });
    }
  });

  const unreadCount = alerts.filter(a => !a.read).length;

  const getUrgencyColor = (daysUntil) => {
    if (daysUntil <= 1) return 'bg-red-100 border-red-300 text-red-900';
    if (daysUntil <= 3) return 'bg-orange-100 border-orange-300 text-orange-900';
    if (daysUntil <= 7) return 'bg-yellow-100 border-yellow-300 text-yellow-900';
    return 'bg-blue-100 border-blue-300 text-blue-900';
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-8 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
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
            Deadline Alerts
            {unreadCount > 0 && (
              <Badge className="bg-red-600 text-white">
                {unreadCount} new
              </Badge>
            )}
          </CardTitle>
          {alerts.length > 0 && (
            <Button
              onClick={() => {
                alerts.filter(a => !a.read).forEach(a => markReadMutation.mutate(a.id));
              }}
              variant="ghost"
              size="sm"
              disabled={unreadCount === 0}
            >
              Mark All Read
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <div className="text-center py-8">
            <CheckCircle2 className="w-12 h-12 mx-auto text-green-500 mb-3" />
            <p className="text-slate-600 font-medium">All caught up!</p>
            <p className="text-sm text-slate-500">No pending deadline alerts</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[500px] overflow-y-auto">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className={`p-4 rounded-lg border-2 transition-all ${
                  alert.read ? 'bg-slate-50 border-slate-200' : getUrgencyColor(alert.days_until_deadline)
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Calendar className={`w-4 h-4 ${alert.read ? 'text-slate-400' : ''}`} />
                      <p className={`font-semibold text-sm ${alert.read ? 'text-slate-600' : ''}`}>
                        {alert.days_until_deadline} day{alert.days_until_deadline !== 1 ? 's' : ''} until deadline
                      </p>
                      {!alert.read && (
                        <Badge variant="outline" className="text-xs">
                          New
                        </Badge>
                      )}
                    </div>

                    {expandedAlert === alert.id ? (
                      <div className="space-y-2">
                        <p className={`text-sm ${alert.read ? 'text-slate-600' : 'text-slate-800'}`}>
                          {alert.message}
                        </p>
                        <div className="text-xs text-slate-500 space-y-1">
                          <p>Alert sent: {format(new Date(alert.sent_at), 'PPp')}</p>
                        </div>
                      </div>
                    ) : (
                      <p className={`text-sm ${alert.read ? 'text-slate-500' : 'text-slate-700'} line-clamp-2`}>
                        {alert.message}
                      </p>
                    )}

                    <Button
                      onClick={() => setExpandedAlert(expandedAlert === alert.id ? null : alert.id)}
                      variant="link"
                      className="p-0 h-auto text-xs mt-2"
                    >
                      {expandedAlert === alert.id ? 'Show less' : 'Show more'}
                    </Button>
                  </div>

                  <div className="flex gap-1">
                    {!alert.read && (
                      <Button
                        onClick={() => markReadMutation.mutate(alert.id)}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Mark as read"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      onClick={() => dismissMutation.mutate(alert.id)}
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Dismiss"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}