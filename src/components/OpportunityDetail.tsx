import { Link } from 'react-router-dom';
import type { Opportunity } from '../lib/types';
import { StatusBadge } from './StatusBadge';
import { FreshnessIndicator } from './FreshnessIndicator';
import { SafeOutboundLink } from './SafeOutboundLink';

export function OpportunityDetail({
  opp, versions = [],
}: {
  opp: Opportunity; versions?: Array<{ versionNumber: number; changeType: string; changedFields: string[]; capturedAt: string }>;
}) {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link to="/discover" className="text-sm text-blue-700 hover:underline">&larr; Back to discover</Link>
      <div className="mt-4 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{opp.title}</h1>
        <StatusBadge status={opp.status} />
      </div>
      {opp.funderName && (
        <p className="mt-2 text-sm"><Link to={`/funders/${opp.funderId}`} className="text-blue-700 hover:underline">{opp.funderName}</Link></p>
      )}
      {opp.opportunityNumber && <p className="text-sm text-gray-600">Opportunity #: {opp.opportunityNumber}</p>}
      {opp.assistanceListingNumber && <p className="text-sm text-gray-600">Assistance Listing #: {opp.assistanceListingNumber}</p>}

      <div className="mt-6 grid gap-6 md:grid-cols-3">
        <section className="md:col-span-2 space-y-4">
          {opp.awardMin != null && opp.awardMax != null && (
            <p className="text-sm">Award range: ${opp.awardMin.toLocaleString()} – ${opp.awardMax.toLocaleString()}</p>
          )}
          {opp.estimatedTotal != null && <p className="text-sm">Estimated total: ${opp.estimatedTotal.toLocaleString()}</p>}
          {opp.openingDate && <p className="text-sm">Opens: {new Date(opp.openingDate).toLocaleDateString()}</p>}
          {opp.deadline && <p className="text-sm font-semibold">Deadline: {new Date(opp.deadline).toLocaleDateString()}</p>}
          {opp.applicantTypes.length > 0 && (
            <div><h2 className="text-sm font-semibold text-gray-700">Eligible Applicant Types</h2><p className="text-sm text-gray-600">{opp.applicantTypes.join(', ')}</p></div>
          )}
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Official Application</h2>
            <SafeOutboundLink href={opp.canonicalApplicationUrl ?? opp.sourceUrl}>View official application &rarr;</SafeOutboundLink>
          </div>
        </section>
        <aside className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h2 className="text-sm font-semibold text-gray-700">Data Freshness</h2>
          <div className="mt-2"><FreshnessIndicator lastRetrievedAt={opp.lastRetrievedAt} lastChangedAt={opp.lastChangedAt} lastVerifiedAt={opp.lastVerifiedAt} /></div>
          <p className="mt-3 text-xs text-gray-500">Source: {opp.sourceConnectorName ?? opp.sourceConnectorId}</p>
          {opp.confidence != null && <p className="text-xs text-gray-500">Confidence: {Math.round(opp.confidence * 100)}%</p>}
        </aside>
      </div>

      {versions.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900">Version History</h2>
          <ul className="mt-2 space-y-2">
            {versions.map((v) => (
              <li key={v.versionNumber} className="rounded border border-gray-200 p-3 text-sm">
                <span className="font-semibold">v{v.versionNumber}</span> — {v.changeType} at {new Date(v.capturedAt).toLocaleString()}
                {v.changedFields.length > 0 && <span className="text-gray-500