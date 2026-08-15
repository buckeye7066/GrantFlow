import { useState } from 'react';
import type { MatchResult } from '../lib/types';

export function MatchExplainer({ match }: { match: MatchResult }) {
  const [open, setOpen] = useState(false);
  const pass = match.eligibilityResult === 'pass';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
      >
        <span className="flex items-center gap-3">
          <span className="text-2xl font-bold text-gray-900">{Math.round(match.overallScore)}</span>
          <span className="text-sm text-gray-600">Overall match</span>
        </span>
        <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${pass ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          Eligibility: {match.eligibilityResult}
        </span>
        <span aria-hidden className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><div className="text-lg font-semibold">{Math.round(match.programRelevanceScore)}</div><div className="text-xs text-gray-500">Relevance</div></div>
            <div><div className="text-lg font-semibold">{Math.round(match.competitivenessScore)}</div><div className="text-xs text-gray-500">Competitive</div></div>
            <div><div className="text-lg font-semibold">{Math.round(match.readinessScore)}</div><div className="text-xs text-gray-500">Readiness</div></div>
          </div>

          {match.factorContributions.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700">Factor Contributions</h4>
              <ul className="mt-1 space-y-1">
                {match.factorContributions.map((f, i) => (
                  <li key={i} className="text-sm text-gray-600">
                    <strong>{f.factor}</strong>: score {f.score}, contribution {f.contribution} — {f.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold text-green-700">Why it matches</h4>
              <ul className="mt-1 list-disc pl-5 text-sm text-gray-600">
                {match.matchReasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold text-red-700">Why it may not</h4>
              <ul className="mt-1 list-disc pl-5 text-sm text-gray-600">
                {match.mismatchReasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          </div>

          {match.disqualifyingConditions.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50 p-3">
              <h4 className="text-sm font-semibold text-red-800">Disqualifying Conditions</h4>
              <ul className="mt-1 list-disc pl-5 text-sm text-red-700">
                {match.disqualifyingConditions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}

          {match.missingProfileFields.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-amber-700">Missing Profile Fields</h4>
              <ul className="mt-1 list-disc pl-5 text-sm text-gray-600">
                {match.missingProfileFields.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}

          <div>
            <h4 className="text-sm font-semibold text-gray-700">Source Evidence</h4>
            <ul className="mt-1 space-y-0.5 text-sm text-gray-600">
              {match.sourceEvidence.map((e, i) => (
                <li key={i}><strong>{e.field}</strong> — from {e.sourceConnectorName}{e.sourceUrl ? ` (${e.sourceUrl})` : ''}</li>
              ))}
            </ul>
          </div>

          <div className="flex items-center justify-between border-t border-gray-100 pt-3">
            <span className="text-sm text-gray-600">Confidence: {Math.round(match.confidence * 100)}%</span>
            <span className="text-sm font-medium text-blue-700">{match.recommendedAction}</span>
          </div>
        </div>
      )}
    </div>
  );
}
