import React from 'react';

/**
 * Bill to section with organization information
 */
export default function BillToInfo({ organization }) {
  if (!organization) {
    return (
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">
          Bill To
        </h3>
        <p className="text-slate-400">Organization information not available</p>
      </div>
    );
  }

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">
        Bill To
      </h3>
      <div className="text-slate-900">
        <p className="font-semibold text-lg">{organization.name}</p>
        {organization.address && <p>{organization.address}</p>}
        {(organization.city || organization.state || organization.zip) && (
          <p>
            {[organization.city, organization.state, organization.zip]
              .filter(Boolean)
              .join(', ')}
          </p>
        )}
        {organization.email && Array.isArray(organization.email) && organization.email[0] && (
          <p className="mt-2 text-slate-600">{organization.email[0]}</p>
        )}
        {organization.phone && Array.isArray(organization.phone) && organization.phone[0] && (
          <p className="text-slate-600">{organization.phone[0]}</p>
        )}
      </div>
    </div>
  );
}