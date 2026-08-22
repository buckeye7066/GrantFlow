import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Bell,
  BellOff,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Info,
  Loader2,
  Clock,
  TrendingUp,
  Target,
  Calendar,
  FileText,
  Zap,
  Play,
  Eye,
  Check
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { useToast } from '@/components/ui/use-toast';
import {
  acknowledgeMonitoringEvent,
  checkGrantAlerts,
  listGrantMonitoringAlerts,
  listGrantMonitoringLogs,
} from '@/api/grantMonitoring';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

export default function GrantMonitoring() {
  const [selectedOrgId, setSelectedOrgId] = useState('all');
  const [isAlertsConfigOpen, setIsAlertsConfigOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list('name'),
  });

  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants'],
    queryFn: () => client.entities.Grant.list('-updated_date'),
  });

  const { data: allAlertConfigs = [], isLoading: isLoadingAlerts } = useQuery({
    queryKey: ['grantAlerts'],
    queryFn: () => listGrantMonitoringAlerts(),
  });

  const { data: allMonitoringLogs = [], isLoading: isLoadingLogs } = useQuery({
    queryKey: ['monitoringLogs'],
    queryFn: () => listGrantMonitoringLogs({ limit: 100 }),
  });

  const checkAlertsMutation = useMutation({
    mutationFn: () => checkGrantAlerts({}),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['monitoringLogs'] });
      queryClient.invalidateQueries({ queryKey: ['grantAlerts'] });
      
      const data = response ?? {};
      toast({
        title: 'Alerts Checked',
        description: `Found ${data.alerts_sent || 0} new alerts and logged ${data.events_logged || 0} events.`,
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Alert Check Failed',
        description: error.message,
      });
    }
  });

  const acknowledgeEventMutation = useMutation({
    mutationFn: (eventId) => acknowledgeMonitoringEvent(eventId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['monitoringLogs'] });
      toast({ title: 'Event Acknowledged' });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Acknowledge Failed',
        description: error?.message || 'Could not acknowledge event. Please try again.',
      });
    }
  });

  const alertConfigs = useMemo(() => {
    if (selectedOrgId === 'all') return allAlertConfigs;
    return allAlertConfigs.filter(a => a.organization_id === selectedOrgId);
  }, [allAlertConfigs, selectedOrgId]);

  const monitoringLogs = useMemo(() => {
    if (selectedOrgId === 'all') return allMonitoringLogs;
    return allMonitoringLogs.filter(l => l.organization_id === selectedOrgId);
  }, [allMonitoringLogs, selectedOrgId]);

  const filteredGrants = useMemo(() => {
    if (selectedOrgId === 'all') return grants;
    return grants.filter(g => g.organization_id === selectedOrgId);
  }, [grants, selectedOrgId]);

  const stats = useMemo(() => {
    const now = new Date();
    
    const upcomingDeadlines = filteredGrants.filter(g => {
      if (!g.deadline || g.deadline.toLowerCase() === 'rolling') return false;
      if (!['discovered', 'interested', 'drafting', 'portal', 'application_prep', 'revision'].includes(g.status)) return false;
      const deadline = new Date(g.deadline);
      const daysUntil = Math.floor((deadline - now) / (1000 * 60 * 60 * 24));
      return daysUntil >= 0 && daysUntil <= 14;
    });

    const criticalAlerts = monitoringLogs.filter(l => 
      l.severity === 'critical' && !l.acknowledged
    );

    const highAlerts = monitoringLogs.filter(l => 
      l.severity === 'high' && !l.acknowledged
    );

    const newMatches = monitoringLogs.filter(l => 
      l.event_type === 'new_match_found' && !l.acknowledged
    );

    return {
      upcomingDeadlines: upcomingDeadlines.length,
      criticalAlerts: criticalAlerts.length,
      highAlerts: highAlerts.length,
      newMatches: newMatches.length,
      totalActive: filteredGrants.filter(g => 
        !['closed', 'declined'].includes(g.status)
      ).length
    };
  }, [filteredGrants, monitoringLogs]);

  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return null;
    return monitoringLogs.find(l => l.id === selectedEventId);
  }, [selectedEventId, monitoringLogs]);

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'critical': return <AlertCircle className="w-5 h-5 text-red-500" />;
      case 'high': return <AlertTriangle className="w-5 h-5 text-orange-500" />;
      case 'medium': return <Info className="w-5 h-5 text-blue-500" />;
      default: return <Info className="w-5 h-5 text-slate-400" />;
    }
  };

  const getSeverityBadgeClass = (severity) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 text-red-700 border-red-200';
      case 'high': return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'medium': return 'bg-blue-100 text-blue-700 border-blue-200';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const getEventTypeLabel = (type) => {
    const labels = {
      'status_changed': 'Status Change',
      'deadline_approaching': 'Deadline Alert',
      'new_match_found': 'New Match',
      'document_submitted': 'Document Submitted',
      'report_submitted': 'Report Submitted',
      'milestone_completed': 'Milestone Complete',
      'funding_announced': 'Funding Announced',
      'alert_triggered': 'Alert Triggered'
    };
    return labels[type] || type;
  };

  if (isLoadingOrgs || isLoadingGrants || isLoadingAlerts || isLoadingLogs) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
                <Bell className="w-8 h-8 text-blue-600" />
                Grant Monitoring
              </h1>
              <p className="text-slate-600 mt-2">
                Automated deadline and status <span className="font-medium">alerts</span> for your
                grant applications. For a plain, per-grant timeline of what was submitted, what is
                due, and pending awards, open the{' '}
                <Link to={createPageUrl('Calendar')} className="text-blue-600 underline hover:text-blue-700">
                  grant calendar
                </Link>
                .
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button asChild variant="outline">
                <Link to={createPageUrl('Calendar')}>
                  <Calendar className="w-4 h-4 mr-2" />
                  View calendar
                </Link>
              </Button>
              <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Organizations</SelectItem>
                  {organizations.map(org => (
                    <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                onClick={() => checkAlertsMutation.mutate()}
                disabled={checkAlertsMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {checkAlertsMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking...</>
                ) : (
                  <><Play className="w-4 h-4 mr-2" /> Check Alerts Now</>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={() => setIsAlertsConfigOpen(true)}
              >
                <Bell className="w-4 h-4 mr-2" />
                Alert Settings
              </Button>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-6 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-slate-500">Open Grants</div>
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

        {/* Alert Configuration Summary */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5" />
              Active Alert Types ({alertConfigs.filter(a => a.enabled).length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {['deadline_approaching', 'status_change', 'new_match', 'milestone_due'].map(type => {
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

        {/* Monitoring Events */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Monitoring Events</CardTitle>
          </CardHeader>
          <CardContent>
            {monitoringLogs.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <Bell className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                <p className="font-semibold">No Monitoring Events Yet</p>
                <p className="text-sm mt-1">Events will appear here once monitoring is active</p>
              </div>
            ) : (
              <div className="space-y-3">
                {monitoringLogs.slice(0, 20).map((event) => {
                  const grant = grants.find(g => g.id === event.grant_id);
                  let eventData = {};
try {
  eventData = JSON.parse(event.event_data || '{}');
} catch (_parseErr) {
  eventData = {};
}
                  
                  return (
                    <div
                      key={event.id}
                      className={`p-4 border rounded-lg transition-all cursor-pointer hover:border-blue-300 ${
                        event.acknowledged ? 'bg-slate-50' : 'bg-white'
                      }`}
                      onClick={() => setSelectedEventId(event.id)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3 flex-1">
                          {getSeverityIcon(event.severity)}
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-semibold text-slate-900">
                                {getEventTypeLabel(event.event_type)}
                              </span>
                              <Badge variant="outline" className={getSeverityBadgeClass(event.severity)}>
                                {event.severity}
                              </Badge>
                              {event.acknowledged && (
                                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                                  <Check className="w-3 h-3 mr-1" />
                                  Acknowledged
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-slate-600">
                              {grant?.title || eventData.grant_title || 'Unknown Grant'}
                            </p>
                            {eventData.days_until !== undefined && (
                              <p className="text-xs text-slate-500 mt-1">
                                <Clock className="w-3 h-3 inline mr-1" />
                                {eventData.days_until} days remaining
                              </p>
                            )}
                            <p className="text-xs text-slate-400 mt-1">
                              {event.created_date && !isNaN(new Date(event.created_date).getTime())
                                ? formatDistanceToNow(new Date(event.created_date), { addSuffix: true })
                                : 'Unknown time'}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {!event.acknowledged && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                acknowledgeEventMutation.mutate(event.id);
                              }}
                              disabled={acknowledgeEventMutation.isPending}
                            >
                              <Check className="w-4 h-4" />
                            </Button>
                          )}
                          {grant && (
                            <Link to={createPageUrl("GrantDetail", { id: grant.id })}>
                              <Button size="sm" variant="outline" onClick={(e) => e.stopPropagation()}>
                                <Eye className="w-4 h-4 mr-1" />
                                View
                              </Button>
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Event Detail Dialog */}
        <Dialog open={!!selectedEventId} onOpenChange={() => setSelectedEventId(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Event Details</DialogTitle>
              <DialogDescription>
                Detailed information about this monitoring event
              </DialogDescription>
            </DialogHeader>
            {selectedEvent && (
              <div className="space-y-4 py-4">
                <div>
                  <Label className="text-sm text-slate-500">Event Type</Label>
                  <p className="font-semibold">{getEventTypeLabel(selectedEvent.event_type)}</p>
                </div>
                <div>
                  <Label className="text-sm text-slate-500">Severity</Label>
                  <Badge className={getSeverityBadgeClass(selectedEvent.severity)}>
                    {selectedEvent.severity}
                  </Badge>
                </div>
                <div>
                  <Label className="text-sm text-slate-500">Details</Label>
                  <pre className="text-sm bg-slate-50 p-3 rounded mt-1 overflow-auto">
                    {(() => {
  try {
    return JSON.stringify(JSON.parse(selectedEvent.event_data || '{}'), null, 2);
  } catch (_e) {
    return selectedEvent.event_data || '{}';
  }
})()}
                  </pre>
                </div>
                <div>
                  <Label className="text-sm text-slate-500">Occurred</Label>
                  <p className="text-sm">{(() => { const created = new Date(selectedEvent.created_date); return isNaN(created.getTime()) ? 'Unknown time' : format(created, 'PPpp'); })()}</p>
                </div>
                {selectedEvent.acknowledged && selectedEvent.acknowledged_at && (
                  <div>
                    <Label className="text-sm text-slate-500">Acknowledged</Label>
                    <p className="text-sm">
                      {isNaN(new Date(selectedEvent.acknowledged_at).getTime())
                        ? 'Unknown time'
                        : format(new Date(selectedEvent.acknowledged_at), 'PPpp')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Alert Configuration Dialog */}
        <Dialog open={isAlertsConfigOpen} onOpenChange={setIsAlertsConfigOpen}>
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Alert Configuration</DialogTitle>
              <DialogDescription>
                Configure which alerts you want to receive for your grants
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <p className="text-sm text-slate-600 mb-4">
                Alert settings are per-organization. Select an organization above to configure its alerts.
              </p>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <p className="text-sm text-amber-900 font-semibold">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  Alert configuration is not yet available in this view.
                  Use your organization dashboard to manage notification preferences,
                  or contact support to enable alerts for this account.
                </p>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}