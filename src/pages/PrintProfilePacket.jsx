import React, { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Printer, X, Loader2, AlertTriangle, UserCheck, Calendar, DollarSign, ExternalLink, ListChecks } from 'lucide-react'
import { format } from 'date-fns'
import { apiFetch } from '@/api/client'
import { getStageHelp } from '@/components/pipeline/pipelineStageHelp'
import '@/styles/print.css'

/**
 * PrintProfilePacket
 * ------------------
 * One printable packet per profile. Fetches `/api/profiles/:id/report-packet`
 * and renders the five sections from the user-facing spec:
 *
 *   1. Profile summary       — who this profile is for
 *   2. Pipeline              — where each funding source stands (grouped by stage)
 *   3. Human intervention    — items that need a person now
 *   4. Potential funds       — possible funding sources (server placeholder)
 *   5. Next steps checklist  — simple next steps per pipeline item
 *
 * Mounted at /PrintProfilePacket?profile_id=<id>. Opened from
 * ProfileDetail.jsx and Pipeline.jsx via `window.open(...)` so the print
 * dialog shows the packet, not the app.
 */

function parseDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

function formatDateSafe(value, fallback = '—') {
  const d = parseDate(value)
  return d ? format(d, 'MMM d, yyyy') : fallback
}

function formatDeadlineSafe(grant) {
  const value = grant?.deadline
  const type = String(grant?.deadline_type || '').trim().toLowerCase()
  if (String(value || '').trim().toLowerCase() === 'rolling' || type === 'rolling' || type === 'ongoing') {
    return 'Rolling / ongoing'
  }
  return formatDateSafe(value, 'Deadline not posted')
}

function formatMoneyRange(min, max, requested) {
  const fmt = (n) => {
    const v = typeof n === 'number' ? n : Number(n)
    if (!Number.isFinite(v) || v <= 0) return null
    return '$' + Math.round(v).toLocaleString('en-US')
  }
  const r = fmt(requested)
  if (r) return r
  const a = fmt(min)
  const b = fmt(max)
  if (a && b) return a === b ? a : `${a} – ${b}`
  return a || b || '—'
}

function profileDisplayName(profile) {
  if (!profile) return 'Profile'
  return (
    profile.display_name ||
    profile.organization_name ||
    profile.name ||
    profile.id ||
    'Profile'
  )
}

// Reduce a freeform application_steps string to renderable lines. The
// pipeline_automation worker often emits this as a numbered or
// bullet-formatted multi-line block. We keep blank-line breaks but flatten
// inline whitespace.
function splitSteps(text) {
  if (!text || typeof text !== 'string') return []
  return text
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

export default function PrintProfilePacket() {
  const location = useLocation()
  const profileId = useMemo(() => {
    const params = new URLSearchParams(location.search)
    return params.get('profile_id') || params.get('id') || null
  }, [location.search])

  const [packet, setPacket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!profileId) {
      setError('Missing profile_id in URL.')
      setLoading(false)
      return () => {}
    }
    setLoading(true)
    setError(null)
    apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/report-packet`)
      .then((data) => {
        if (cancelled) return
        setPacket(data)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message || 'Failed to load report packet.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [profileId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin mr-3" /> Loading profile packet…
      </div>
    )
  }

  if (error || !packet) {
    return (
      <div className="flex flex-col items-center justify-center h-screen p-8 text-center">
        <AlertTriangle className="w-10 h-10 text-amber-500 mb-3" />
        <h2 className="text-lg font-semibold text-slate-900">Could not load this profile packet</h2>
        <p className="text-slate-600 mt-2 max-w-md">{error || 'Unknown error.'}</p>
        <Button variant="outline" className="mt-6" onClick={() => window.close()}>
          <X className="w-4 h-4 mr-2" />
          Close
        </Button>
      </div>
    )
  }

  const { profile, pipeline_grants: pipelineGrants, handoffs, stage_summary: stageSummary, generated_at } = packet
  const displayName = profileDisplayName(profile)

  // Group pipeline_grants by status for the "where each funding source
  // stands" section. We rely on getStageHelp() to provide labels and
  // plain-English copy so the print packet stays consistent with the UI.
  const grantsByStage = pipelineGrants.reduce((acc, g) => {
    const key = String(g.status || 'unknown').toLowerCase()
    if (!acc[key]) acc[key] = []
    acc[key].push(g)
    return acc
  }, {})
  const stageOrder = (stageSummary || []).map((s) => s.status)
  const allStageKeys = Array.from(
    new Set([
      ...stageOrder,
      ...Object.keys(grantsByStage).filter((k) => !stageOrder.includes(k)),
    ]),
  )

  const handlePrint = () => window.print()
  const handleClose = () => window.close()

  return (
    <div className="bg-white min-h-screen">
      {/* Screen-only toolbar */}
      <header className="p-4 sm:p-6 border-b bg-slate-50 flex justify-between items-center print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Profile Packet</h1>
          <p className="text-slate-600">For: {displayName}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handlePrint}>
            <Printer className="w-4 h-4 mr-2" /> Print
          </Button>
          <Button variant="outline" onClick={handleClose}>
            <X className="w-4 h-4 mr-2" /> Close
          </Button>
        </div>
      </header>

      <div className="p-4 sm:p-8 gf-print-root max-w-5xl mx-auto" data-print-ready="true">
        {/* Print-only header */}
        <header className="hidden print:block mb-8">
          <h1 className="text-2xl font-bold">Profile Packet — {displayName}</h1>
          <p className="text-sm text-slate-600">
            Generated {generated_at ? formatDateSafe(generated_at) : ''}
          </p>
        </header>

        {/* ============================================================
            Section 1 — Who this profile is for
           ============================================================ */}
        <section className="mb-8 break-inside-avoid">
          <h2 className="text-xl font-bold text-slate-900 border-b border-slate-300 pb-2 mb-3">
            1. Who this profile is for
          </h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="font-semibold text-slate-600">Name</dt>
              <dd className="text-slate-900">{displayName}</dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-600">Profile type</dt>
              <dd className="text-slate-900">{profile.primary_type || '—'}</dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-600">Status</dt>
              <dd className="text-slate-900">{profile.status || '—'}</dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-600">Pipeline funds (active)</dt>
              <dd className="text-slate-900">
                {profile.pipeline_funds_total !== null && profile.pipeline_funds_total !== undefined
                  ? '$' + Number(profile.pipeline_funds_total).toLocaleString('en-US')
                  : '—'}
              </dd>
            </div>
          </dl>

          {Array.isArray(profile.sections) && profile.sections.length > 0 && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {profile.sections.map((section) => (
                <div key={section.section_key} className="border border-slate-200 rounded p-3 text-sm break-inside-avoid">
                  <h3 className="font-semibold text-slate-800 mb-1 capitalize">
                    {String(section.section_key || '').replace(/_/g, ' ')}
                  </h3>
                  <pre className="text-slate-700 text-xs whitespace-pre-wrap font-sans m-0">
                    {JSON.stringify(section.data || {}, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ============================================================
            Section 2 — Where each funding source stands (pipeline)
           ============================================================ */}
        <section className="mb-8">
          <h2 className="text-xl font-bold text-slate-900 border-b border-slate-300 pb-2 mb-3">
            2. Where each funding source stands
          </h2>
          {pipelineGrants.length === 0 ? (
            <p className="text-slate-600 text-sm italic">
              No funding sources are in this profile’s pipeline yet.
            </p>
          ) : (
            allStageKeys.map((stageKey) => {
              const items = grantsByStage[stageKey] || []
              if (items.length === 0) return null
              const help = getStageHelp(stageKey)
              return (
                <div key={stageKey} className="mb-5 break-inside-avoid">
                  <h3 className="font-semibold text-slate-900">
                    {help.label}{' '}
                    <span className="font-normal text-slate-500">({items.length})</span>
                  </h3>
                  <p className="text-xs text-slate-600 italic mb-2">{help.plainEnglish}</p>
                  <ul className="divide-y divide-slate-200 border border-slate-200 rounded">
                    {items.map((g) => (
                      <li key={g.id} className="p-3 text-sm">
                        <div className="flex justify-between gap-3 flex-wrap">
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900">{g.title || '(untitled)'}</p>
                            <p className="text-slate-600 text-xs">
                              {g.funder || g.organization_name || 'Unknown funder'}
                            </p>
                          </div>
                          <div className="text-right text-xs text-slate-600 shrink-0">
                            <div className="flex items-center gap-1 justify-end">
                              <Calendar className="w-3 h-3" />
                              {formatDeadlineSafe(g)}
                            </div>
                            <div className="flex items-center gap-1 justify-end mt-0.5">
                              <DollarSign className="w-3 h-3" />
                              {formatMoneyRange(g.amount_min, g.amount_max, g.amount_requested)}
                            </div>
                          </div>
                        </div>
                        {help.nextStep && (
                          <p className="text-xs text-slate-700 mt-1">
                            <strong>Next step:</strong> {help.nextStep}
                          </p>
                        )}
                        {g.application_url && (
                          <p className="text-xs text-blue-700 mt-1 break-all">
                            <ExternalLink className="inline w-3 h-3 mr-1" />
                            {g.application_url}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })
          )}
        </section>

        {/* ============================================================
            Section 3 — Items that need a person now
           ============================================================ */}
        <section className="mb-8">
          <h2 className="text-xl font-bold text-slate-900 border-b border-slate-300 pb-2 mb-3 flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-amber-600" />
            3. Items that need a person now
          </h2>
          {handoffs.length === 0 ? (
            <p className="text-slate-600 text-sm italic">
              Nothing needs a person right now. GrantFlow will flag items here as they come up.
            </p>
          ) : (
            <div className="space-y-4">
              {handoffs.map((g) => {
                const help = getStageHelp(g.status)
                const auto = g.latest_automation || null
                const steps = splitSteps(auto?.application_steps)
                const actions = Array.isArray(auto?.recommended_actions)
                  ? auto.recommended_actions.filter(Boolean)
                  : []
                return (
                  <div key={g.id} className="border border-amber-300 bg-amber-50 rounded p-4 break-inside-avoid">
                    <div className="flex justify-between gap-3 flex-wrap mb-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900">{g.title || '(untitled)'}</p>
                        <p className="text-slate-700 text-xs">
                          {g.funder || g.organization_name || 'Unknown funder'} • Stage: {help.label}
                        </p>
                      </div>
                      <div className="text-right text-xs text-slate-700 shrink-0">
                        <div>Deadline: {formatDeadlineSafe(g)}</div>
                      </div>
                    </div>
                    {auto?.handoff_reason && (
                      <p className="text-sm text-slate-900">
                        <strong>Why a person is needed:</strong> {auto.handoff_reason}
                      </p>
                    )}
                    <p className="text-sm text-slate-900 mt-1">
                      <strong>What to do next:</strong> {help.nextStep}
                    </p>
                    {steps.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm font-semibold text-slate-900">Application steps:</p>
                        <ol className="list-decimal pl-5 text-sm text-slate-800 mt-1 space-y-0.5">
                          {steps.map((step, idx) => (
                            <li key={idx}>{step}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {actions.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm font-semibold text-slate-900">Recommended actions:</p>
                        <ul className="list-disc pl-5 text-sm text-slate-800 mt-1 space-y-0.5">
                          {actions.map((a, idx) => (
                            <li key={idx}>{typeof a === 'string' ? a : JSON.stringify(a)}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {g.application_url && (
                      <p className="text-xs text-blue-800 mt-2 break-all">
                        <ExternalLink className="inline w-3 h-3 mr-1" />
                        Portal / contact: {g.application_url}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ============================================================
            Section 4 — Possible funding sources (placeholder)
           ============================================================ */}
        {Array.isArray(packet.potential_funds) && packet.potential_funds.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-slate-900 border-b border-slate-300 pb-2 mb-3">
              4. Possible funding sources
            </h2>
            <ul className="divide-y divide-slate-200 border border-slate-200 rounded text-sm">
              {packet.potential_funds.map((f) => (
                <li key={f.id || f.title} className="p-3">
                  <p className="font-semibold text-slate-900">{f.title}</p>
                  <p className="text-slate-600 text-xs">{f.funder}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ============================================================
            Section 5 — Simple next steps checklist
           ============================================================ */}
        <section className="mb-8 break-inside-avoid">
          <h2 className="text-xl font-bold text-slate-900 border-b border-slate-300 pb-2 mb-3 flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-emerald-600" />
            5. Simple next steps
          </h2>
          {pipelineGrants.length === 0 ? (
            <p className="text-slate-600 text-sm italic">
              Add at least one funding source to this profile’s pipeline to get next steps.
            </p>
          ) : (
            <ol className="list-decimal pl-5 text-sm space-y-1">
              {pipelineGrants.slice(0, 25).map((g) => {
                const help = getStageHelp(g.status)
                return (
                  <li key={g.id}>
                    <span className="font-semibold">{g.title || '(untitled)'}:</span>{' '}
                    {help.nextStep}
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        <footer className="text-xs text-slate-500 pt-4 border-t border-slate-200">
          Generated by GrantFlow on {generated_at ? formatDateSafe(generated_at) : ''}
        </footer>
      </div>
    </div>
  )
}
