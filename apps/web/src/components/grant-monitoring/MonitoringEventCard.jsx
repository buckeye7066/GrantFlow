import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Check, Eye, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { formatDistanceToNow } from 'date-fns';
import { getSeverityIcon, getSeverityBadgeClass, getEventTypeLabel } from '@/components/shared/monitoringUtils';

/**
 * Individual monitoring event card
 */
export default function MonitoringEventCard({ 
  event, 
  grant, 
  onAcknowledge, 
  onClick,
  isAcknowledging 
}) {
  const SeverityIcon = getSeverityIcon(event.severity);
  const severityClass = getSeverityBadgeClass(event.severity);
  const eventData = JSON.parse(event.event_data || '{}');

  return (
    <div
      className={`p-4 border rounded-lg transition-all cursor-pointer hover:border-blue-300 ${
        event.acknowledged ? 'bg-slate-50' : 'bg-white'
      }`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3 flex-1">
          <SeverityIcon className="w-5 h-5" style={{ color: severityClass.includes('red') ? '#dc2626' : severityClass.includes('orange') ? '#ea580c' : '#2563eb' }} />
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-semibold text-slate-900">
                {getEventTypeLabel(event.event_type)}
              </span>
              <Badge variant="outline" className={severityClass}>
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
              {formatDistanceToNow(new Date(event.created_date), { addSuffix: true })}
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
                onAcknowledge(event.id);
              }}
              disabled={isAcknowledging}
            >
              <Check className="w-4 h-4" />
            </Button>
          )}
          {grant && (
            <Link to={createPageUrl(`GrantDetail?id=${grant.id}`)}>
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
}