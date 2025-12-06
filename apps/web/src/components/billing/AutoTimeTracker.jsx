import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Clock, TrendingUp } from 'lucide-react';

/**
 * AutoTimeTracker - Displays recent automated time entries
 * Shows users what automation work has been billed
 */
export default function AutoTimeTracker({ organizationId = null, limit = 5 }) {
  const { data: autoTimeEntries = [] } = useQuery({
    queryKey: ['autoTimeEntries', organizationId],
    queryFn: async () => {
      try {
        let entries;
        if (organizationId) {
          entries = await base44.entities.TimeEntry.filter({
            organization_id: organizationId,
            source: 'auto'
          }, '-created_date', limit * 2);
        } else {
          entries = await base44.entities.TimeEntry.filter({
            source: 'auto'
          }, '-created_date', limit * 2);
        }
        
        return (entries || [])
          .filter(e => e.source === 'auto')
          .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
          .slice(0, limit);
      } catch (error) {
        // Silently fail - rate limits are expected, don't spam console
        return [];
      }
    },
    refetchInterval: false, // Disable auto-refetch to prevent rate limits
    staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
    retry: false, // Don't retry on failure
    refetchOnWindowFocus: false, // Don't refetch on window focus
  });

  const totalMinutes = autoTimeEntries.reduce((sum, entry) => sum + (entry.rounded_minutes || 0), 0);

  // Don't render anything if no entries (prevents flash)
  if (!autoTimeEntries || autoTimeEntries.length === 0) {
    return null;
  }

  return (
    <Alert className="bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200">
      <Clock className="h-4 w-4 text-blue-600" />
      <AlertDescription className="text-blue-900">
        <div className="flex items-center justify-between mb-2">
          <strong className="flex items-center gap-2">
            🤖 Recent Automation Activity
          </strong>
          <Badge variant="outline" className="bg-white">
            <TrendingUp className="w-3 h-3 mr-1" />
            {totalMinutes} min total
          </Badge>
        </div>
        <div className="space-y-1 text-sm">
          {autoTimeEntries.map((entry, idx) => (
            <div key={entry.id || idx} className="flex items-start justify-between gap-2">
              <span className="flex-1 text-slate-700">
                • {entry.note || 'Automated work'}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="secondary" className="text-xs">
                  {entry.task_category}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {entry.rounded_minutes} min
                </Badge>
              </div>
            </div>
          ))}
        </div>
        {autoTimeEntries.length >= limit && (
          <p className="text-xs text-blue-600 mt-2 italic">
            Showing {limit} most recent • View all in Billing tab
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}