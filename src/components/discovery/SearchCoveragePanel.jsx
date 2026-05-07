import React from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, AlertTriangle, Info, ChevronDown } from 'lucide-react'

/**
 * Mission Goal 7 — Clear discovery UI.
 * Mission Goal 9 — Explainable.
 *
 * Renders the canonical Coverage Plan / Coverage Report from
 * /api/real-crawlers/run so users can see which source families
 * GrantFlow planned to query for their profile, which categories were
 * actually represented in this run, and which gaps remain.
 *
 * Props:
 *   coveragePlan   - { profile_type, sources_planned[], directory_sources[], direct_sources[], notes[] }
 *   coverageReport - { sources_required[], sources_queried[], coverage_gaps[], notes[] }
 *   sourceLabels   - { [SOURCE_ID]: { label, directory, trust } }  (optional but preferred)
 *   crawlerType    - the strategy id used (for context)
 */

function humanize(id) {
  if (!id) return ''
  return String(id)
    .toLowerCase()
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join(' ')
}

function SourceBadge({ id, status, label, directory }) {
  // status: 'planned' | 'queried' | 'gap'
  const variant = status === 'queried' ? 'default' : status === 'gap' ? 'destructive' : 'secondary'
  const icon =
    status === 'queried' ? (
      <CheckCircle2 className="h-3 w-3 mr-1" />
    ) : status === 'gap' ? (
      <AlertTriangle className="h-3 w-3 mr-1" />
    ) : (
      <Info className="h-3 w-3 mr-1" />
    )
  return (
    <Badge variant={variant} className="text-xs flex items-center gap-1 mr-1 mb-1">
      {icon}
      <span>{label || humanize(id)}</span>
      {directory ? <span className="ml-1 opacity-70">(directory)</span> : null}
    </Badge>
  )
}

export default function SearchCoveragePanel({
  coveragePlan,
  coverageReport,
  sourceLabels,
  crawlerType,
}) {
  const [open, setOpen] = React.useState(false)

  const planned = Array.isArray(coveragePlan?.sources_planned) ? coveragePlan.sources_planned : []
  const required = Array.isArray(coverageReport?.sources_required)
    ? coverageReport.sources_required
    : planned
  const queried = Array.isArray(coverageReport?.sources_queried)
    ? coverageReport.sources_queried
    : []
  const gaps = Array.isArray(coverageReport?.coverage_gaps) ? coverageReport.coverage_gaps : []
  const notes = Array.isArray(coveragePlan?.notes)
    ? coveragePlan.notes
    : Array.isArray(coverageReport?.notes)
      ? coverageReport.notes
      : []

  // Treat anything in `required` that's not a gap as queried for display purposes.
  // (When real per-source outcomes wire through, queried[] will be authoritative.)
  const inferredQueried = new Set([...queried, ...required.filter((id) => !gaps.includes(id))])

  if (planned.length === 0 && required.length === 0) return null

  const lookup = sourceLabels || {}
  const labelFor = (id) => lookup[id]?.label || humanize(id)
  const directoryFor = (id) => lookup[id]?.directory ?? false

  // Collapsed summary line so the panel never dominates the page.
  const summary = `Searched ${inferredQueried.size} of ${required.length || planned.length} planned source families${gaps.length ? ` — ${gaps.length} gap${gaps.length === 1 ? '' : 's'}` : ''}`

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
              {summary}
              {coveragePlan?.profile_type ? ` • profile type: ${coveragePlan.profile_type}` : ''}
              {crawlerType ? ` • strategy: ${crawlerType}` : ''}
            </CardDescription>
          </div>
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </CardHeader>
      {open ? (
        <CardContent className="pt-0">
          {required.length > 0 ? (
            <div className="mb-3">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Source families planned for your profile
              </div>
              <div className="flex flex-wrap">
                {required.map((id) => (
                  <SourceBadge
                    key={`req-${id}`}
                    id={id}
                    label={labelFor(id)}
                    directory={directoryFor(id)}
                    status={inferredQueried.has(id) ? 'queried' : 'gap'}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {gaps.length > 0 ? (
            <div className="mb-3">
              <div className="text-xs font-medium text-amber-700 mb-1">
                Coverage gaps (no opportunities returned from these source families this run)
              </div>
              <div className="flex flex-wrap">
                {gaps.map((id) => (
                  <SourceBadge
                    key={`gap-${id}`}
                    id={id}
                    label={labelFor(id)}
                    directory={directoryFor(id)}
                    status="gap"
                  />
                ))}
              </div>
            </div>
          ) : null}

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
            Coverage is part of GrantFlow's mission promise: every search reports
            which source families it planned, queried, and missed. Gaps surface in
            Anya so you can act on them.
          </div>
        </CardContent>
      ) : null}
    </Card>
  )
}
