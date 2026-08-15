import { Link } from 'react-router-dom';
import type { Opportunity } from '../lib/types';
import { StatusBadge } from './StatusBadge';
import { FreshnessIndicator } from './FreshnessIndicator';
import { SafeOutboundLink } from './SafeOutboundLink';

export function OpportunityCard({ opp }: { opp: Opportunity }) {
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md focus-within:ring-2 focus-within:ring-blue-500">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/opportunities/${opp.id}`} className="flex-1">
          <h3 className="text-base font-semibold text-gray-900 hover:text-blue-700">
            {opp.title}
          </h3>
        </Link>
        <StatusBadge status={opp.status} />
      </div>
      {opp.funderName && <p className="mt-1 text-sm text-gray-600">{opp.funderName}</p>}
      {opp.opportunityNumber && (
        <p className="text-xs text-gray-500">Opportunity #: {opp.opportunityNumber}</p>
      )}
      {opp.awardMin != null && opp.awardMax != null && (
        <p className="mt-1 text-sm text-gray-700">
          Award: ${opp.awardMin.toLocaleString()} – ${opp.awardMax.toLocaleString()}
        </p>
      )}
      {opp.deadline && (
        <p className="text-sm text-gray-700">Deadline: {new Date(opp.deadline).toLocaleDateString()}</p>
      )}
      <div className="mt-3 border-t border-gray-100 pt-3">
        <FreshnessIndicator
          lastRetrievedAt={opp.lastRetrievedAt}
          lastChangedAt={opp.lastChangedAt}
          lastVerifiedAt={opp.lastVerifiedAt}
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500">Source: {opp.sourceConnectorName ?? opp.sourceConnectorId}</span>
        <SafeOutboundLink href={opp.canonicalApplicationUrl}>Official application &rarr;</SafeOutboundLink>
      </div>
    </article>
  );
}
