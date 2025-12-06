import React from 'react';
import GrantCardPrint from './GrantCardPrint';

/**
 * GrantStatusColumn - Column displaying grants for a specific status
 * 
 * @param {Object} props
 * @param {string} props.label - Status label
 * @param {string} props.icon - Icon emoji
 * @param {Array} props.grants - Grants for this status
 * @param {string} props.colorClass - Tailwind color classes for header
 */
export default function GrantStatusColumn({ label, icon, grants, colorClass }) {
  if (!grants || grants.length === 0) return null;

  return (
    <section 
      className="print-status-column break-inside-avoid"
      aria-label={`${label} grants`}
    >
      {/* Column Header */}
      <div className={`${colorClass} p-2 rounded-t-lg mb-2 flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          {icon && <span className="text-sm" aria-hidden="true">{icon}</span>}
          <h3 className="font-semibold text-sm">{label}</h3>
        </div>
        <span className="text-xs font-medium bg-white/80 px-2 py-0.5 rounded">
          {grants.length}
        </span>
      </div>

      {/* Grant Cards */}
      <div className="space-y-2">
        {grants.map((grant) => (
          <GrantCardPrint key={grant.id} grant={grant} />
        ))}
      </div>
    </section>
  );
}