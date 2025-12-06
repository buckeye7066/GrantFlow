import React from 'react';

/**
 * Badge displaying partner health status
 */
export default function HealthStatusBadge({ status }) {
  const styles = {
    active: 'bg-emerald-100 text-emerald-800',
    inactive: 'bg-slate-100 text-slate-800',
    throttled: 'bg-amber-100 text-amber-800',
    error: 'bg-red-100 text-red-800',
  };

  return (
    <span className={`px-2 py-1 text-xs font-medium rounded-full ${styles[status] || styles.inactive}`}>
      {status}
    </span>
  );
}