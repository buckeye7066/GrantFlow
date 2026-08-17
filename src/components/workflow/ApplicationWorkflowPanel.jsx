/**
 * ApplicationWorkflowPanel
 *
 * Phase 7 mission rule: every saved opportunity should generate a visible
 * action plan, document checklist, deadline tracker, and step-by-step
 * workflow. This panel is the canonical UI for the workflow service
 * exposed at /api/application-workflow/* — embed it anywhere a user
 * needs to track an opportunity from "discovered" through to "awarded".
 *
 * Props:
 *   opportunity    — canonical funding-result object (used to seed/save)
 *   profileId      — required to start a plan
 *   pipelineGrantId — optional tracked-grant id that owns drafts/documents
 *   applicationId  — optional. If known, panel loads steps/docs/deadlines.
 *
 * If neither applicationId nor opportunity is provided, the panel is a
 * no-op (render-friendly).
 */

import React, { useState, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { apiFetch } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, CheckSquare, Square, Calendar, FileText, Target, Plus, Upload } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

const ALLOWED_STATUSES = [
  'draft',
  'in_progress',
  'submitted',
  'under_review',
  'awarded',
  'denied',
  'withdrawn',
  'closed',
]

function formatDeadline(value) {
  if (!value) return 'No date'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.valueOf())) return String(value)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return String(value)
  }
}

export default function ApplicationWorkflowPanel({ opportunity, profileId, pipelineGrantId, applicationId: applicationIdProp }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [applicationId, setApplicationId] = useState(applicationIdProp || null)
  const [newStepTitle, setNewStepTitle] = useState('')
  const [docFilename, setDocFilename] = useState('')

  const detailQuery = useQuery({
    queryKey: ['application-workflow', applicationId],
    queryFn: () => apiFetch(`/api/application-workflow/${applicationId}`),
    enabled: Boolean(applicationId),
  })

  const previewQuery = useQuery({
    queryKey: ['application-workflow-preview', profileId, opportunity?.id || opportunity?.title],
    queryFn: () => apiFetch('/api/application-workflow/preview', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId, opportunity }),
    }),
    enabled: Boolean(opportunity && profileId && !applicationId),
  })

  const saveMut = useMutation({
    mutationFn: () => apiFetch('/api/application-workflow/from-opportunity', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId, pipeline_grant_id: pipelineGrantId || null, opportunity }),
    }),
    onSuccess: (data) => {
      setApplicationId(data?.id)
      toast({ title: data?.created ? 'Application started' : 'Already saved', description: 'Workflow ready below.' })
      queryClient.invalidateQueries({ queryKey: ['application-workflow', data?.id] })
    },
    onError: (err) => toast({ variant: 'destructive', title: 'Could not save', description: err?.message ?? String(err) }),
  })

  const completeStepMut = useMutation({
    mutationFn: (stepId) => apiFetch(`/api/application-workflow/steps/${stepId}/complete`, { method: 'PATCH' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['application-workflow', applicationId] }),
  })

  const addStepMut = useMutation({
    mutationFn: ({ title }) => apiFetch(`/api/application-workflow/${applicationId}/steps`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
    onSuccess: () => {
      setNewStepTitle('')
      queryClient.invalidateQueries({ queryKey: ['application-workflow', applicationId] })
    },
  })

  const addDocMut = useMutation({
    mutationFn: ({ filename }) => apiFetch(`/api/application-workflow/${applicationId}/documents`, {
      method: 'POST',
      body: JSON.stringify({ filename }),
    }),
    onSuccess: () => {
      setDocFilename('')
      queryClient.invalidateQueries({ queryKey: ['application-workflow', applicationId] })
    },
  })

  const statusMut = useMutation({
    mutationFn: ({ status }) => apiFetch(`/api/application-workflow/${applicationId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-workflow', applicationId] })
      toast({ title: 'Status updated' })
    },
  })

  const recordSubmissionMut = useMutation({
    mutationFn: ({ event_type, notes }) => apiFetch(`/api/application-workflow/${applicationId}/submissions`, {
      method: 'POST',
      body: JSON.stringify({ event_type, notes }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['application-workflow', applicationId] }),
  })

  const detail = detailQuery.data
  const preview = previewQuery.data?.plan

  const saveButton = useMemo(() => {
    if (applicationId) return null
    return (
      <Button
        onClick={() => saveMut.mutate()}
        disabled={saveMut.isPending || !profileId || !opportunity}
        className="w-full"
      >
        {saveMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
        {saveMut.isPending ? 'Starting workflow…' : 'Save & start application workflow'}
      </Button>
    )
  }, [applicationId, saveMut.isPending, profileId, opportunity, saveMut])

  const handleSubmissionShortcut = useCallback((eventType) => {
    recordSubmissionMut.mutate({ event_type: eventType, notes: null })
  }, [recordSubmissionMut])

  // No-op render if we have nothing to show.
  if (!opportunity && !applicationId) return null

  return (
    <Card className="border-slate-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="w-4 h-4" />
          Application workflow
          {detail?.application?.status && (
            <Badge variant="outline" className="ml-2 capitalize">{detail.application.status.replace(/_/g, ' ')}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Save / start panel */}
        {!applicationId && (
          <div className="space-y-3">
            {preview && (
              <div className="rounded-lg border bg-slate-50 p-3 text-sm text-slate-700 space-y-2">
                <p className="font-semibold text-slate-900">Plan preview</p>
                <p className="text-xs text-slate-600">{preview.next_steps?.length ?? 0} steps · {preview.documents_needed?.length ?? 0} documents · {preview.deadlines?.length ?? 0} deadlines</p>
                <ul className="list-disc pl-5 space-y-0.5">
                  {(preview.next_steps ?? []).slice(0, 5).map((s, i) => (
                    <li key={i}>{s.title}</li>
                  ))}
                </ul>
              </div>
            )}
            {saveButton}
          </div>
        )}

        {/* Loaded application detail */}
        {applicationId && detailQuery.isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
          </div>
        )}
        {applicationId && detail && (
          <div className="space-y-5">
            {/* Status changer */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</span>
              {ALLOWED_STATUSES.map((s) => (
                <Button
                  key={s}
                  variant={detail.application?.status === s ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => statusMut.mutate({ status: s })}
                  disabled={statusMut.isPending}
                  className="capitalize text-xs h-7"
                >
                  {s.replace(/_/g, ' ')}
                </Button>
              ))}
            </div>

            <Button asChild size="sm" variant="outline">
              <Link to={`/GrantLifecycle/${encodeURIComponent(applicationId)}`}>Open lifecycle workspace</Link>
            </Button>

            {/* Steps */}
            <section>
              <h4 className="font-semibold text-sm text-slate-900 mb-2 flex items-center gap-2">
                <CheckSquare className="w-4 h-4" /> Steps ({detail.steps?.length ?? 0})
              </h4>
              <ul className="space-y-1.5">
                {(detail.steps ?? []).map((step) => {
                  const done = step.status === 'completed'
                  return (
                    <li key={step.id} className="flex items-start gap-2 text-sm">
                      <button
                        type="button"
                        className="mt-0.5 shrink-0 text-slate-500 hover:text-emerald-600"
                        onClick={() => !done && completeStepMut.mutate(step.id)}
                        disabled={done || completeStepMut.isPending}
                        title={done ? 'Completed' : 'Mark complete'}
                      >
                        {done ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4" />}
                      </button>
                      <span className={done ? 'line-through text-slate-500' : 'text-slate-800'}>{step.title}</span>
                    </li>
                  )
                })}
              </ul>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={newStepTitle}
                  onChange={(e) => setNewStepTitle(e.target.value)}
                  placeholder="Add a custom step…"
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => newStepTitle.trim() && addStepMut.mutate({ title: newStepTitle.trim() })}
                  disabled={addStepMut.isPending || !newStepTitle.trim()}
                >
                  <Plus className="w-3 h-3 mr-1" /> Add
                </Button>
              </div>
            </section>

            {/* Documents */}
            <section>
              <h4 className="font-semibold text-sm text-slate-900 mb-2 flex items-center gap-2">
                <FileText className="w-4 h-4" /> Documents ({detail.documents?.length ?? 0})
              </h4>
              <ul className="space-y-1 text-sm">
                {(detail.documents ?? []).map((doc) => (
                  <li key={doc.id} className="text-slate-800 truncate">• {doc.filename}{doc.document_type ? ` (${doc.document_type})` : ''}</li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={docFilename}
                  onChange={(e) => setDocFilename(e.target.value)}
                  placeholder="Attach document filename…"
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => docFilename.trim() && addDocMut.mutate({ filename: docFilename.trim() })}
                  disabled={addDocMut.isPending || !docFilename.trim()}
                >
                  <Upload className="w-3 h-3 mr-1" /> Attach
                </Button>
              </div>
            </section>

            {/* Deadlines */}
            <section>
              <h4 className="font-semibold text-sm text-slate-900 mb-2 flex items-center gap-2">
                <Calendar className="w-4 h-4" /> Deadlines ({detail.deadlines?.length ?? 0})
              </h4>
              <ul className="space-y-1 text-sm">
                {(detail.deadlines ?? []).map((ev) => (
                  <li key={ev.id} className="text-slate-800">
                    <span className="font-medium">{formatDeadline(ev.due_at)}</span>
                    <span className="text-slate-500 ml-2 capitalize">{(ev.event_type || '').replace(/_/g, ' ')}</span>
                    {ev.notes && <span className="text-slate-500 ml-2">— {ev.notes}</span>}
                  </li>
                ))}
              </ul>
            </section>

            {/* Submission shortcuts */}
            <section className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => handleSubmissionShortcut('submitted')} disabled={recordSubmissionMut.isPending}>
                Record: submitted
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleSubmissionShortcut('award_received')} disabled={recordSubmissionMut.isPending}>
                Record: award received
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleSubmissionShortcut('denied')} disabled={recordSubmissionMut.isPending}>
                Record: denied
              </Button>
            </section>

            {(detail.submissions ?? []).length > 0 && (
              <section>
                <h4 className="font-semibold text-sm text-slate-900 mb-1">Submission events</h4>
                <ul className="space-y-1 text-xs text-slate-600">
                  {detail.submissions.map((ev) => (
                    <li key={ev.id}>{ev.event_type} · {formatDeadline(ev.occurred_at || ev.created_at)}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
