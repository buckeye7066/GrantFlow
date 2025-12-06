import React from 'react';
import { AlertCircle } from 'lucide-react';
import { truncateText } from '@/components/shared/grantCardUtils';

/**
 * GrantSummaryBox - AI-generated summary and match reasons
 * @param {Object} props
 * @param {string} props.summary - AI summary text
 * @param {string[]} props.matchReasons - Why this matches
 * @param {string[]} props.matchWarnings - Warnings/concerns
 * @param {boolean} props.show - Whether to show summary
 */
export default function GrantSummaryBox({ summary, matchReasons, matchWarnings, show }) {
  if (!show) return null;

  const reasons = Array.isArray(matchReasons) ? matchReasons : [];
  const warnings = Array.isArray(matchWarnings) ? matchWarnings : [];
  const hasMatchReasons = reasons.length > 0;
  const hasWarnings = warnings.length > 0;

  const summaryStr = typeof summary === 'string' ? summary : '';
  const hasSummary = summaryStr.trim().length > 0;

  if (!hasMatchReasons && !hasWarnings && !hasSummary) return null;

  return (
    <div className="space-y-2">
      {/* Match Reasons */}
      {hasMatchReasons && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-md p-2 space-y-1 transition-all hover:shadow-sm">
          <p className="text-xs font-semibold text-emerald-900">Why this matches:</p>
          {reasons.slice(0, 3).map((reason, idx) => (
            <p key={idx} className="text-xs text-emerald-700 leading-tight">
              • {truncateText(String(reason || ''), 120)}
            </p>
          ))}
          {reasons.length > 3 && (
            <p className="text-xs text-emerald-600 italic">
              +{reasons.length - 3} more reasons
            </p>
          )}
        </div>
      )}

      {/* Warnings */}
      {hasWarnings && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-2 space-y-1 transition-all hover:shadow-sm">
          <div className="flex items-center gap-1">
            <AlertCircle className="w-3 h-3 text-amber-600" aria-hidden="true" />
            <p className="text-xs font-semibold text-amber-900">Note:</p>
          </div>
          {warnings.slice(0, 2).map((warning, idx) => (
            <p key={idx} className="text-xs text-amber-700 leading-tight">
              • {truncateText(String(warning || ''), 120)}
            </p>
          ))}
          {warnings.length > 2 && (
            <p className="text-xs text-amber-600 italic">
              +{warnings.length - 2} more concerns
            </p>
          )}
        </div>
      )}

      {/* AI Summary */}
      {hasSummary && (
        <div className="bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 rounded-md p-2 mt-2 transition-all hover:shadow-sm">
          <p className="text-xs text-slate-700 leading-relaxed">
            {truncateText(summaryStr, 200)}
          </p>
        </div>
      )}
    </div>
  );
}