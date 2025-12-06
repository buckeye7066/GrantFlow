import React from 'react';

/**
 * Displays a preview of the current grant pipeline
 * Shows grant count and top grants
 * 
 * @param {Array} grants - Array of grants
 * @param {number} limit - Maximum grants to display
 */
export default function PipelinePreview({ grants = [], limit = 3 }) {
  const grantCount = grants.length;
  const displayGrants = grants.slice(0, limit);
  const remainingCount = grantCount - limit;

  return (
    <div className="bg-slate-50 p-4 rounded-lg border">
      <h4 className="font-semibold text-sm text-slate-900 mb-2">
        Current Pipeline Summary
      </h4>
      <p className="text-sm text-slate-600">
        <strong>{grantCount}</strong> {grantCount === 1 ? 'grant' : 'grants'} in pipeline
      </p>
      
      {displayGrants.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-slate-600">
          {displayGrants.map(grant => (
            <li key={grant.id}>
              • {grant.title} - {grant.status}
            </li>
          ))}
          {remainingCount > 0 && (
            <li className="text-slate-500">
              ... and {remainingCount} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}