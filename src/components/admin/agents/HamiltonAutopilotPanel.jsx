import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Workflow } from 'lucide-react'

/**
 * Hamilton Autopilot dashboard panel — separate agent from the
 * existing Yana lead-discovery funnel. Renders Hamilton's primary
 * application-completion metrics (fields filled, drafts, submissions,
 * open blockers, autopilot run status).
 */
export default function HamiltonAutopilotPanel({ data }) {
  const summary = data?.summary || null
  const installed = !!summary?.installed
  const m = summary?.primary_metrics || {}
  const blockerTypes = m.open_blockers_by_type || {}
  const runStatus = m.autopilot_runs_by_status || {}

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Workflow className="h-4 w-4 text-emerald-600" />
          Hamilton Autopilot
        </CardTitle>
        <span className="text-xs text-slate-500">
          {installed
            ? `${Number(m.submissions_completed || 0).toLocaleString()} submissions / ${Number(m.open_blockers || 0).toLocaleString()} open blockers`
            : 'Not installed'}
        </span>
      </CardHeader>
      <CardContent>
        {!installed ? (
          <p className="text-xs text-slate-500">
            Hamilton has no telemetry tables yet. Run the application autopilot
            once to populate hamilton_runs / hamilton_autopilot_runs.
          </p>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Fields filled" value={m.fields_filled} />
              <Stat label="Drafts completed" value={m.drafts_completed} />
              <Stat label="Submissions" value={m.submissions_completed} />
              <Stat label="Blocked safety" value={m.blocked_safety} />
            </div>
            {Object.keys(runStatus).length ? (
              <div>
                <div className="mb-1 text-slate-500">Autopilot runs</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(runStatus).map(([k, v]) => (
                    <span
                      key={k}
                      className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-900"
                    >
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {Object.keys(blockerTypes).length ? (
              <div>
                <div className="mb-1 text-slate-500">Open blocker categories</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(blockerTypes).map(([k, v]) => (
                    <span
                      key={k}
                      className="rounded bg-amber-50 px-2 py-0.5 text-amber-900"
                    >
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-slate-500">{label}</div>
      <div className="font-semibold text-slate-900">
        {Number(value || 0).toLocaleString()}
      </div>
    </div>
  )
}
