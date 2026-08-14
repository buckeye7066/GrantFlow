import React from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Clock, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

// FIX: This component now fetches its own data, making it self-sufficient and fixing the crash.
export default function TimeTrackingTab({ grantId, organizationId }) {
  
  const { data: timeLogs = [], isLoading: isLoadingLogs } = useQuery({
      queryKey: ['timeEntries', organizationId, grantId],
      queryFn: () => client.entities.TimeEntry.filter({ organization_id: organizationId, grant_id: grantId }),
      enabled: !!organizationId && !!grantId,
  });

  const { data: grant, isLoading: isLoadingGrant } = useQuery({
      queryKey: ['grant', grantId],
      queryFn: () => client.entities.Grant.get(grantId),
      enabled: !!grantId,
  });

  // Helper to validate date
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  if (isLoadingLogs || isLoadingGrant) {
    return (
      <div className="flex justify-center items-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  // Filter time logs to the relevant grant period if dates are available
  const grantTimeLogs = (grant?.start_date && grant?.end_date)
    ? timeLogs.filter(log => {
        if (!isValidDate(log.start_at)) return false;
        const logDate = new Date(log.start_at);
        return logDate >= new Date(grant.start_date) && logDate <= new Date(grant.end_date);
    })
    : timeLogs.filter(log => isValidDate(log.start_at)); // Show all with valid dates if no date range

  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>Time Log Entries</CardTitle>
      </CardHeader>
      <CardContent>
        {grantTimeLogs.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <Clock className="w-16 h-16 mx-auto mb-4 text-slate-300" />
            <p className="font-semibold">No Time Entries Yet</p>
            <p className="text-sm mb-4">Start logging time for this profile to see entries here.</p>
            {/* The button can be a trigger for a modal in the future */}
            <Button disabled>Log Time</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {grantTimeLogs.slice(0, 10).map(log => {
              return (
                <div key={log.id} className="p-3 border rounded-md bg-slate-50">
                  <div className="flex justify-between items-center">
                    <p className="font-semibold">{log.note || 'General Activity'}</p>
                    <span className="font-bold text-lg">{log.rounded_minutes !== null ? (log.rounded_minutes / 60).toFixed(2) + 'h' : '—'}</span>
                  </div>
                  <div className="text-sm text-slate-500 mt-1">
                    <span>{isValidDate(log.start_at) ? format(new Date(log.start_at), 'MMM d, yyyy') : 'Unknown date'}</span> | <span>{log.task_category || 'Uncategorized'}</span>
                  </div>
                </div>
              );
            })}
             {grantTimeLogs.length > 10 && <p className="text-center text-sm text-slate-500 mt-4">...and {grantTimeLogs.length - 10} more entries.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}