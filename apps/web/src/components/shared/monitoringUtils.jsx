import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

/**
 * Get the icon component for a severity level
 */
export function getSeverityIcon(severity) {
  switch (severity) {
    case 'critical':
      return AlertCircle;
    case 'high':
      return AlertTriangle;
    case 'medium':
      return Info;
    default:
      return Info;
  }
}

/**
 * Get the badge color classes for a severity level
 */
export function getSeverityBadgeClass(severity) {
  switch (severity) {
    case 'critical':
      return 'bg-red-100 text-red-700 border-red-200';
    case 'high':
      return 'bg-orange-100 text-orange-700 border-orange-200';
    case 'medium':
      return 'bg-blue-100 text-blue-700 border-blue-200';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200';
  }
}

/**
 * Get human-readable label for event type
 */
export function getEventTypeLabel(type) {
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
}