import React from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, AlertTriangle, AlertOctagon, Info, ChevronDown, MinusCircle } from 'lucide-react'

/**
 * Mission Goal 7 — Clear discovery UI.
 * Mission Goal 9 — Explainable, reliable, testable.
 *
 * Renders the canonical Coverage Plan / Coverage Report / Coverage
 * Outcomes from /api/real-crawlers/run so users can see, per source
 * family:
 *
 *   - Planned: source family was selected for this profile type.
 *   - Queried: GrantFlow actually loaded candidates from this family.
 *   - Failed:  GrantFlow tried but the source returned an error.
 *   - Found:   how many opportunities ended up coming from this family.
 *   - Not yet queried: planned but the strategy didn't reach it
 *                     (coverage gap; honestly surfaced).
 *
 * The panel never claims a source was "searched" when no candidates
 * loaded — that was the previous bug. Outcomes come from the new
 * coverage_outcomes payload; the panel still degrades gracefully if a
 * deploy hands back the older shape.
 *
 * Props:
 *   coveragePlan      - planCoverage() output
 *   coverageReport    - buildCoverageReport(plan, outcomes) output
 *   coverageOutcomes  - per-source outcomes array (preferred, may be null)
 *   coverageSummary   - summariseOutcomes() output (preferred, may be null)
 *   sourceLabels      - { [SOURCE_ID]: { label, directory, trust } }
 *   crawlerType       - the strategy id used (for context)
 */

function humanize(id) {
  if (!id) return ''
  return String(id)
    .toLowerCase()
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join(' ')
}

const STATUS_META = {
  queried_with_results: { variant: 'default',     icon: CheckCircle2, color: 'text-emerald-700' },
  queried_no_results:   { variant: 'secondary',   icon: MinusCircle,  color: 'text-slate-700'   },
  // Legacy-backend inference only: we know the family was reached, we do NOT
  // know whether it returned anything. Claiming "returned results" here is the
  // same overstatement this panel exists to prevent.
  queried_unknown_results: { variant: 'secondary', icon: Info,        color: 'text-slate-700'   },
  failed:               { variant: 'destructive', icon: AlertOctagon, color: 'text-red-700'     },
  not_yet_queried:      { variant: 'outline',     icon: AlertTriangle, color: 'text-amber-700'  },
  planned:              { variant: 'secondary',   icon: Info,         color: 'text-slate-600'   },
}

function SourceBadge({ id, status, label, directory, found, error }) {
  const meta = STATUS_META[status] || STATUS_META.planned
  const Icon = meta.icon
  const tooltip = error ? `${label || id}: ${error}` : `${label || id}${typeof found === 'number' ? ` — ${found} found` : ''}`
  return (
    <Badge
      variant={meta.variant}
      className={`text-xs flex items-center gap-1 mr-1 mb-1 ${meta.color}`}
      title={tooltip}
    >
      <Icon className="h-3 w-3" />
      <span>{label || humanize(id)}</span>
      {directory ? <span className="ml-1 opacity-70">(directory)</span> : null}
      {typeof found === 'number' && found > 0 ? (
        <span className="ml-1 rounded bg-white/40 px-1 text-[10px] font-semibold">{found}</span>
      ) : null}
    </Badge>
  )
}

function classifyOutcome(outcome) {
  if (!outcome) return 'planned'
  if (outcome.failed) return 'failed'
  if (outcome.queried) return outcome.found > 0 ? 'queried_with_results' : 'queried_no_results'
  return 'not_yet_queried'
}

export default function SearchCoveragePanel({
  coveragePlan,
  coverageReport,
  coverageOutcomes,
  coverageSummary,
  sourceLabels,
  crawlerType,
}) {
  const [open, setOpen] = React.useState(false)

  const planned = Array.isArray(coveragePlan?.sources_planned) ? coveragePlan.sources_planned : []
  const required = Array.isArray(coverageReport?.sources_required)
    ? coverageReport.sources_required
    : planned
  const notes = Array.isArray(coveragePlan?.notes)
    ? coveragePlan.notes
    : Array.isArray(coverageReport?.notes)
      ? coverageReport.notes
      : []

  const outcomes = Array.isArray(coverageOutcomes) ? coverageOutcomes : []
  const outcomeBySourceId = new Map(outcomes.map((o) => [o.source_id, o]))

  // Combine ids from the plan AND any synthetic curated_<group> ids
  // the backend reports outcomes for so the user sees everything that
  // actually ran, not just what was planned in advance.
  const allIds = new Set([
    ...planned,
    ...required,
    ...outcomes.map((o) => o.source_id).filter(Boolean),
  ])

  if (allIds.size === 0 && planned.length === 0 && required.length === 0) return null

  const lookup = sourceLabels || {}
  const labelFor = (id) => lookup[id]?.label || humanize(id)
  const directoryFor = (id) => lookup[id]?.directory ?? false

  // Backwards-compatible derivation: if outcomes are missing (older
  // backend), fall back to the previous "queried = required - gaps"
  // inference so the panel still renders something useful instead of
  // breaking.
  const fallbackQueried = new Set(coverageReport?.sources_queried ?? [])
  const fallbackGaps = new Set(coverageReport?.coverage_gaps ?? [])
  const fallbackInferred = new Set([...fallbackQueried, ...required.filter((id) => !fallbackGaps.has(id))])

  const summary = coverageSummary || {
    sources_total: outcomes.length || required.length,
    sources_queried: outcomes.length
      ? outcomes.filter((o) => o.queried).length
      : fallbackInferred.size,
    sources_failed: outcomes.filter((o) => o.failed).length,
    direct_found: coverageReport?.direct_opportunities_found ?? 0,
    directory_found: coverageReport?.directory_opportunities_found ?? 0,
  }

  const headlineParts = [
    `Searched ${summary.sources_queried} of ${summary.sources_total || planned.length} planned source families`,
  ]
  if (summary.sources_failed > 0) headlineParts.push(`${summary.sources_failed} failed`)
  const directFound = summary.direct_found ?? 0
  const directoryFound = summary.directory_found ?? 0
  if (directFound + directoryFound > 0) {
    headlineParts.push(`${directFound} direct + ${directoryFound} directory results`)
  }

  // Bucket the ids for display so the panel reads top-to-bottom in
  // priority order: failures first (need attention), then "queried but
  // empty" (honest), then "queried with results", then "not yet
  // queried" / planned.
  const grouped = {
    failed: [],
    queried_with_results: [],
    queried_no_results: [],
    queried_unknown_results: [],
    not_yet_queried: [],
    planned: [],
  }
  for (const id of allIds) {
    const outcome = outcomeBySourceId.get(id)
    let status
    if (outcome) {
      status = classifyOutcome(outcome)
    } else if (outcomes.length === 0) {
      // Legacy shape: `sources_queried` / `coverage_gaps` say only whether the
      // family was REACHED. They carry no result count, so this row may not be
      // reported as "returned results".
      status = fallbackInferred.has(id) ? 'queried_unknown_results' : 'not_yet_queried'
    } else {
      status = 'not_yet_queried'
    }
    grouped[status].push({ id, outcome })
  }

  const renderGroup = (status, title, helper) => {
    const items = grouped[status]
    if (!items.length) return null
    return (
      <div className="mb-3">
        <div className="text-xs font-medium text-muted-foreground mb-1">
          {title}
          {helper ? <span className="ml-1 opacity-70">— {helper}</span> : null}
        </div>
        <div className="flex flex-wrap">
          {items.map(({ id, outcome }) => (
            <SourceBadge
              key={`${status}-${id}`}
              id={id}
              status={status}
              label={labelFor(id)}
              directory={directoryFor(id)}
              found={outcome?.found}
              error={outcome?.error}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <Card className="mb-4 border-dashed">
      <CardHeader className="pb-2">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Info className="h-4 w-4 text-blue-600" />
              Search coverage
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {headlineParts.join(' • ')}
              {coveragePlan?.profile_type ? ` • profile type: ${coveragePlan.profile_type}` : ''}
              {crawlerType ? ` • strategy: ${crawlerType}` : ''}
            </CardDescription>
          </div>
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </CardHeader>
      {open ? (
        <CardContent className="pt-0">
          {renderGroup('failed', 'Source families that failed', 'we tried but the source returned an error')}
          {renderGroup('queried_with_results', 'Source families that returned results', null)}
          {renderGroup('queried_no_results', 'Source families queried but empty', 'we ran the search; no matching opportunities surfaced this run')}
          {renderGroup('queried_unknown_results', 'Source families queried', 'this run did not report per-source result counts')}
          {renderGroup('not_yet_queried', 'Coverage gaps', 'planned for this profile but not reached this run')}
          {renderGroup('planned', 'Other planned source families', null)}

          {notes.length > 0 ? (
            <div className="text-xs text-muted-foreground mt-2">
              <div className="font-medium mb-1">Planning notes</div>
              <ul className="list-disc pl-5 space-y-0.5">
                {notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="text-[11px] text-muted-foreground mt-3 italic">
            Coverage is part of GrantFlow&apos;s mission promise: every search reports
            which source families it planned, queried, failed, and missed. Gaps
            surface here and in Anya so you can act on them.
          </div>
        </CardContent>
      ) : null}
    </Card>
  )
}
