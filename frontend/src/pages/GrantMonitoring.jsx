import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Custom hook
import { useGrantMonitoring } from '@/components/hooks/useGrantMonitoring';

// Components
import MonitoringHeader from '@/components/grant-monitoring/MonitoringHeader';
import MonitoringStats from '@/components/grant-monitoring/MonitoringStats';
import MonitoringAlertSummary from '@/components/grant-monitoring/MonitoringAlertSummary';
import MonitoringEventCard from '@/components/grant-monitoring/MonitoringEventCard';
import MonitoringEventDialog from '@/components/grant-monitoring/MonitoringEventDialog';
import AlertConfigDialog from '@/components/grant-monitoring/AlertConfigDialog';

export default function GrantMonitoring() {
  const [isAlertsConfigOpen, setIsAlertsConfigOpen] = useState(false);

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: async () => {
      try {
        return await base44.auth.me();
      } catch (error) {
        console.error('[GrantMonitoring] Auth error:', error);
        return null;
      }
    },
  });

  const isAdmin = user?.role === 'admin';

  const {
    organizations,
    grants,
    alertConfigs,
    monitoringLogs,
    stats,
    selectedEvent,
    selectedOrgId,
    setSelectedOrgId,
    selectedEventId,
    setSelectedEventId,
    handleCheckAlerts,
    handleAcknowledgeEvent,
    isLoading,
    isCheckingAlerts,
    isAcknowledging,
  } = useGrantMonitoring({
    user,
    isAdmin,
    enabled: !!user?.email && !isLoadingUser,
  });

  // Validate selectedOrgId against RLS-filtered organizations
  useEffect(() => {
    if (!organizations || !selectedOrgId || selectedOrgId === 'all') return;

    const orgExists = organizations.some(org => org.id === selectedOrgId);
    if (!orgExists) {
      setSelectedOrgId('all');
    }
  }, [organizations, selectedOrgId, setSelectedOrgId]);

  // Combined loading state
  if (isLoadingUser || isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <MonitoringHeader
          selectedOrgId={selectedOrgId}
          onSelectOrg={setSelectedOrgId}
          organizations={organizations}
          onCheckAlerts={handleCheckAlerts}
          isCheckingAlerts={isCheckingAlerts}
          onOpenSettings={() => setIsAlertsConfigOpen(true)}
        />

        <MonitoringStats stats={stats} />

        <MonitoringAlertSummary alertConfigs={alertConfigs} />

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
                  
                  return (
                    <MonitoringEventCard
                      key={event.id}
                      event={event}
                      grant={grant}
                      onAcknowledge={handleAcknowledgeEvent}
                      onClick={() => setSelectedEventId(event.id)}
                      isAcknowledging={isAcknowledging}
                    />
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Event Detail Dialog */}
        <MonitoringEventDialog
          event={selectedEvent}
          open={!!selectedEventId}
          onOpenChange={() => setSelectedEventId(null)}
        />

        {/* Alert Configuration Dialog */}
        <AlertConfigDialog
          open={isAlertsConfigOpen}
          onOpenChange={setIsAlertsConfigOpen}
        />
      </div>
    </div>
  );
}