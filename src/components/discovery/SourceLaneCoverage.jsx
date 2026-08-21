import React, { useEffect, useState } from 'react'
import { apiFetch } from '@/api/client'
import { ShieldCheck, Radar, ChevronRight, ChevronDown } from 'lucide-react'

// Source-lane coverage / "negative evidence" for the user (mission goal #9 —
// explainable, trustworthy results). Shows which discovery sources GrantFlow
// searched for this profile and which were checked but currently have no match
// — so a user sees "we looked here too; nothing open right now" instead of a
// silent gap. Fetched from the off-hot-path coverage endpoint; renders nothing
// until it has data, and never blocks the results.
export default function SourceLaneCoverage({ profileId, refreshKey, onCoverage }) {
  const [coverage, setCoverage] = useState(null)
  const [showExcluded, setShowExcluded] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!profileId) { setCoverage(null); return undefined }
    apiFetch(`/api/matching/profile/${profileId}/coverage`)
      .then((res) => { if (!cancelled) setCoverage(res) })
      .catch(() => { if (!cancelled) setCoverage(null) })
    return () => { cancelled = true }
  }, [profileId, refreshKey])

  // Lift the "sources with matches" count up so the results view can reconcile
  // it against what is actually rendered (profile-type-agnostic).
  useEffect(() => {
    if (typeof onCoverage !== 'function') return
    const withResults = Array.isArray(coverage?.sources_with_results) ? coverage.sources_with_results : []
    const searchedSources = Array.isArray(coverage?.sources_searched) ? coverage.sources_searched : []
    onCoverage({ matchedSources: withResults.length, searchedSources: searchedSources.length })
  }, [coverage, onCoverage])

  const searched = Array.isArray(coverage?.sources_searched) ? coverage.sources_searched : []
  if (!coverage || searched.length === 0) return null

  const noMatch = Array.isArray(coverage.sources_no_current_match) ? coverage.sources_no_current_match : []
  const withResults = Array.isArray(coverage.sources_with_results) ? coverage.sources_with_results : []
  const excluded = Array.isArray(coverage.excluded_sources) ? coverage.excluded_sources : []

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-slate-700">
        <Radar className="h-4 w-4 text-indigo-600" />
        Searched {searched.length} funding source{searched.length === 1 ? '' : 's'} for this profile
        {withResults.length > 0 && (
          <span className="inline-flex items-center gap-1 text-emerald-700">
            <ShieldCheck className="h-3.5 w-3.5" /> {withResults.length} with matches
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {searched.map((s) => {
          const hit = withResults.includes(s.source_id)
          return (
            <span
              key={s.source_id}
              className={`rounded-full px-2 py-0.5 text-xs ${hit ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200' : 'bg-slate-200 text-slate-600 dark:bg-slate-800'}`}
              title={hit ? 'Has current matches' : 'Checked — no current match'}
            >
              {s.name}
            </span>
          )
        })}
      </div>
      {noMatch.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Checked but no open match right now: {noMatch.map((s) => s.name).join(', ')}. We keep watching these — new opportunities appear as agencies post them.
        </p>
      )}
      {excluded.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowExcluded((v) => !v)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
            aria-expanded={showExcluded}
          >
            {showExcluded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Not searched for this profile: {excluded.length} source{excluded.length === 1 ? '' : 's'} — why
          </button>
          {showExcluded && (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
              {excluded.map((s) => (
                <li key={s.source_id}>
                  <span className="font-medium text-slate-600">{s.name}</span>
                  {Array.isArray(s.reasons) && s.reasons.length > 0 ? ` — ${s.reasons.join('; ')}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
