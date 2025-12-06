import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Custom hook for managing grant monitoring data and operations with RLS filtering
 * @param {Object} options
 * @param {Object} options.user - Current user object
 * @param {boolean} options.isAdmin - Whether user is admin
 * @param {boolean} options.enabled - Whether to enable data fetching
 */
export function useGrantMonitoring({ user, isAdmin, enabled = true } = {}) {
  const [selectedOrgId, setSelectedOrgId] = useState('all');
  const [selectedEventId, setSelectedEventId] = useState(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Fetch organizations with RLS filtering
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Organization.list()
      : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: enabled && !!user?.email,
  });

  // Fetch grants with RLS filtering
  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Grant.list()
      : base44.entities.Grant.filter({ created_by: user?.email }),
    enabled: enabled && !!user?.email,
  });

  // Fetch alert configs with RLS filtering
  const { data: allAlertConfigs = [], isLoading: isLoadingAlerts } = useQuery({
    queryKey: ['grantAlerts', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.GrantAlert.list()
      : base44.entities.GrantAlert.filter({ created_by: user?.email }),
    enabled: enabled && !!user?.email,
  });

  // Fetch monitoring logs with RLS filtering - H5 FIX: Limit to 100 results
  const { data: allMonitoringLogs = [], isLoading: isLoadingLogs } = useQuery({
    queryKey: ['monitoringLogs', user?.email, isAdmin],
    queryFn: async () => {
      const logs = isAdmin
        ? await base44.entities.GrantMonitoringLog.list()
        : await base44.entities.GrantMonitoringLog.filter({ created_by: user?.email });
      
      // H5 FIX: Limit to most recent 100 logs to prevent performance issues
      return logs.slice(0, 100);
    },
    enabled: enabled && !!user?.email,
  });

  // Validate selectedOrgId when organizations change
  useEffect(() => {
    if (selectedOrgId && selectedOrgId !== 'all' && organizations.length > 0) {
      if (!organizations.find(o => o.id === selectedOrgId)) {
        setSelectedOrgId('all');
      }
    }
  }, [selectedOrgId, organizations]);

  // Check alerts mutation with permission check
  const checkAlertsMutation = useMutation({
    mutationFn: () => {
      if (!user?.email) {
        throw new Error('You must be logged in to check alerts.');
      }
      return base44.functions.invoke('checkGrantAlerts', {});
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['monitoringLogs', user?.email, isAdmin] });
      queryClient.invalidateQueries({ queryKey: ['grantAlerts', user?.email, isAdmin] });
      
      const data = response.data;
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

  // Acknowledge event mutation with permission check
  const acknowledgeEventMutation = useMutation({
    mutationFn: (eventId) => {
      if (!user?.email) {
        throw new Error('You must be logged in to acknowledge events.');
      }
      
      // Find the event and verify permission
      const event = allMonitoringLogs.find(l => l.id === eventId);
      if (!event) {
        throw new Error('Event not found.');
      }
      
      if (!isAdmin && event.created_by !== user?.email) {
        throw new Error('You do not have permission to acknowledge this event.');
      }
      
      return base44.entities.GrantMonitoringLog.update(eventId, {
        acknowledged: true,
        acknowledged_at: new Date().toISOString()
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['monitoringLogs', user?.email, isAdmin] });
      toast({ title: 'Event Acknowledged' });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Acknowledge Failed',
        description: error.message,
      });
    }
  });

  // Filtered alert configs
  const alertConfigs = useMemo(() => {
    if (selectedOrgId === 'all') return allAlertConfigs;
    return allAlertConfigs.filter(a => a.organization_id === selectedOrgId);
  }, [allAlertConfigs, selectedOrgId]);

  // Filtered monitoring logs
  const monitoringLogs = useMemo(() => {
    if (selectedOrgId === 'all') return allMonitoringLogs;
    return allMonitoringLogs.filter(l => l.organization_id === selectedOrgId);
  }, [allMonitoringLogs, selectedOrgId]);

  // Filtered grants
  const filteredGrants = useMemo(() => {
    if (selectedOrgId === 'all') return grants;
    return grants.filter(g => g.organization_id === selectedOrgId);
  }, [grants, selectedOrgId]);

  // Compute stats
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

  // Selected event for dialog
  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return null;
    return monitoringLogs.find(l => l.id === selectedEventId);
  }, [selectedEventId, monitoringLogs]);

  const isLoading = isLoadingOrgs || isLoadingGrants || isLoadingAlerts || isLoadingLogs;

  const handleCheckAlerts = () => {
    if (!user?.email) {
      toast({
        variant: 'destructive',
        title: 'Not Authenticated',
        description: 'Please sign in to check alerts.',
      });
      return;
    }
    checkAlertsMutation.mutate();
  };

  const handleAcknowledgeEvent = (eventId) => {
    if (!user?.email) {
      toast({
        variant: 'destructive',
        title: 'Not Authenticated',
        description: 'Please sign in to acknowledge events.',
      });
      return;
    }
    acknowledgeEventMutation.mutate(eventId);
  };

  // Handle org selection change - clear event selection
  const handleSetSelectedOrgId = (orgId) => {
    setSelectedOrgId(orgId);
    setSelectedEventId(null);
  };

  return {
    // Data
    organizations,
    grants,
    alertConfigs,
    monitoringLogs,
    filteredGrants,
    stats,
    selectedEvent,
    
    // State
    selectedOrgId,
    setSelectedOrgId: handleSetSelectedOrgId,
    selectedEventId,
    setSelectedEventId,
    
    // Actions
    handleCheckAlerts,
    handleAcknowledgeEvent,
    
    // Loading
    isLoading,
    isCheckingAlerts: checkAlertsMutation.isPending,
    isAcknowledging: acknowledgeEventMutation.isPending,
  };
}