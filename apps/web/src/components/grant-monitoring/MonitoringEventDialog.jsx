import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { getSeverityBadgeClass, getEventTypeLabel } from '@/components/shared/monitoringUtils';

/**
 * Dialog for viewing event details
 */
export default function MonitoringEventDialog({ event, open, onOpenChange }) {
  if (!event) return null;

  const severityClass = getSeverityBadgeClass(event.severity);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Event Details</DialogTitle>
          <DialogDescription>
            Detailed information about this monitoring event
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <Label className="text-sm text-slate-500">Event Type</Label>
            <p className="font-semibold">{getEventTypeLabel(event.event_type)}</p>
          </div>
          <div>
            <Label className="text-sm text-slate-500">Severity</Label>
            <Badge className={severityClass}>
              {event.severity}
            </Badge>
          </div>
          <div>
            <Label className="text-sm text-slate-500">Details</Label>
            <pre className="text-sm bg-slate-50 p-3 rounded mt-1 overflow-auto">
              {JSON.stringify(JSON.parse(event.event_data || '{}'), null, 2)}
            </pre>
          </div>
          <div>
            <Label className="text-sm text-slate-500">Occurred</Label>
            <p className="text-sm">{format(new Date(event.created_date), 'PPpp')}</p>
          </div>
          {event.acknowledged && (
            <div>
              <Label className="text-sm text-slate-500">Acknowledged</Label>
              <p className="text-sm">{format(new Date(event.acknowledged_at), 'PPpp')}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}