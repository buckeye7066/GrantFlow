/**
 * HamiltonTaskDrawer — full task review modal. Shows portal link, missing
 * info form, audit timeline, and the auto-submit toggle.
 */

import React, { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Sparkles, AlertTriangle, CheckCircle2, ExternalLink, Download, Mail, Send, Phone } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showErrorToast, showInfoToast } from '@/components/shared/toastHelpers'
import * as hamiltonApi from '@/api/hamilton'
import client from '@/api/client'
import MissingInfoChecklist from '@/components/profiles/MissingInfoChecklist'
import { resolveMissingInfoTarget } from '@/config/missingInfoTargets'

export default function HamiltonTaskDrawer({ open, onClose, task: initialTask, onTaskUpdated }) {
  const { toast } = useToast()
  const [task, setTask] = useState(initialTask || null)
  const [events, setEvents] = useState([])
  const [missingInfo, setMissingInfo] = useState([])
  const [openBlockers, setOpenBlockers] = useState([])
  const [values, setValues] = useState({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setTask(initialTask || null)
    setValues({})
  }, [initialTask?.id])

  useEffect(() => {
    if (!open || !task?.id) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const detail = await hamiltonApi.getApplicationTask(task.id)
        if (!cancelled) {
          setTask(detail?.task || task)
          setEvents(Array.isArray(detail?.events) ? detail.events : [])
          setMissingInfo(Array.isArray(detail?.missing_info) ? detail.missing_info.filter((m) => !m.resolved) : [])
        }
        const bRes = await client.get(`/api/hamilton/automation/tasks/${task.id}/blockers?onlyOpen=true`).catch(() => null)
        if (!cancelled) setOpenBlockers(Array.isArray(bRes?.blockers) ? bRes.blockers : [])
      } catch (err) {
        if (!cancelled) {
          showErrorToast(toast, 'Could not load task', err?.message || 'See logs.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [open, task?.id, toast])

  async function submitMissingInfo() {
    if (!task?.id) return
    const items = missingInfo
      .filter((m) => values[m.id] !== undefined && values[m.id] !== '')
      .map((m) => ({ kind: m.kind, key: m.key, value: values[m.id] }))
    if (items.length === 0) {
      showErrorToast(toast, 'Nothing to send', 'Fill in at least one item to update Hamilton.')
      return
    }
    setBusy(true)
    try {
      const result = await hamiltonApi.supplyMissingInfo(task.id, items)
      setMissingInfo(result?.remaining_missing_info || [])
      setTask(result?.task || task)
      onTaskUpdated?.(result?.task || task)
      showInfoToast(toast, 'Hamilton updated', `Resolved ${result?.resolved_count || 0} item(s). Click "Let Hamilton continue" to advance.`)
      setValues({})
    } catch (err) {
      showErrorToast(toast, 'Update failed', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function continueHamilton() {
    if (!task?.id) return
    setBusy(true)
    try {
      const result = await hamiltonApi.continueHamilton(task.id)
      setTask(result?.task || task)
      onTaskUpdated?.(result?.task || task)
      if (result?.adapter_result?.message) {
        showInfoToast(toast, 'Hamilton update', result.adapter_result.message)
      }
      // refetch events/missing
      const detail = await hamiltonApi.getApplicationTask(task.id)
      setEvents(detail?.events || [])
      setMissingInfo((detail?.missing_info || []).filter((m) => !m.resolved))
    } catch (err) {
      showErrorToast(toast, 'Hamilton could not continue', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function approveAutoSubmit(enable) {
    if (!task?.id) return
    setBusy(true)
    try {
      const result = await hamiltonApi.approveAutoSubmit(task.id, enable)
      setTask(result?.task || task)
      onTaskUpdated?.(result?.task || task)
      showInfoToast(toast, enable ? 'Auto-submit enabled' : 'Auto-submit disabled', 'Hamilton will respect this on the next continue.')
    } catch (err) {
      showErrorToast(toast, 'Update failed', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function regeneratePacket() {
    if (!task?.id) return
    setBusy(true)
    try {
      const res = await client.post(`/api/hamilton/automation/tasks/${task.id}/regenerate`, {})
      showInfoToast(toast, 'Packet regenerated', 'A new DOCX/PDF was saved under the profile\'s Documents.')
      const detail = await hamiltonApi.getApplicationTask(task.id)
      setTask(detail?.task || task)
      setEvents(detail?.events || [])
      onTaskUpdated?.(detail?.task || task)
      void res
    } catch (err) {
      showErrorToast(toast, 'Could not regenerate', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function resolveBlocker(note = '') {
    if (!task?.id) return
    setBusy(true)
    try {
      const res = await client.post(`/api/hamilton/automation/tasks/${task.id}/resolve-blocker`, note ? { note } : {})
      setTask(res?.task || task)
      onTaskUpdated?.(res?.task || task)
      showInfoToast(toast, 'Hamilton Autopilot resumed', 'Hamilton is running again. You will be alerted only on a true hard blocker.')
      const detail = await hamiltonApi.getApplicationTask(task.id)
      setEvents(detail?.events || [])
      setMissingInfo((detail?.missing_info || []).filter((m) => !m.resolved))
      const bRes = await client.get(`/api/hamilton/automation/tasks/${task.id}/blockers?onlyOpen=true`).catch(() => null)
      setOpenBlockers(Array.isArray(bRes?.blockers) ? bRes.blockers : [])
    } catch (err) {
      showErrorToast(toast, 'Could not resume Hamilton', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function cancelTask() {
    if (!task?.id) return
    if (!window.confirm('Cancel this Hamilton task? She will stop and clear the alert. You can re-queue this funding source later.')) return
    setBusy(true)
    try {
      await client.post(`/api/hamilton/automation/tasks/${task.id}/cancel`, { reason: 'cancelled_from_task_drawer' })
      const detail = await hamiltonApi.getApplicationTask(task.id)
      setTask(detail?.task || task)
      onTaskUpdated?.(detail?.task || task)
      setOpenBlockers([])
      showInfoToast(toast, 'Hamilton task cancelled', 'The alert has been cleared.')
    } catch (err) {
      showErrorToast(toast, 'Could not cancel', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function markChannel(channel) {
    if (!task?.id) return
    setBusy(true)
    try {
      const res = await client.post(`/api/hamilton/automation/tasks/${task.id}/mark-${channel}`, {})
      setTask(res?.task || task)
      onTaskUpdated?.(res?.task || task)
      showInfoToast(toast, `Marked ${channel}`, 'Hamilton logged the submission.')
    } catch (err) {
      showErrorToast(toast, `Could not mark ${channel}`, err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  function downloadHref(documentId) {
    if (!documentId) return null
    return `/api/documents/${encodeURIComponent(documentId)}/download`
  }

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose?.()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            Hamilton Autopilot task
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="py-6 flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading task…
          </div>
        )}

        {!loading && task && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{hamiltonApi.statusLabel(task.status)}</Badge>
              {task.automation_type && task.automation_type !== 'unknown' && (
                <Badge variant="outline" className="text-xs bg-indigo-50 text-indigo-800 border-indigo-200">
                  {task.automation_type.replace('_', ' ')}
                </Badge>
              )}
              {task.selected_from_stage && (
                <Badge variant="outline" className="text-xs">from {task.selected_from_stage}</Badge>
              )}
              {task.application_id && (
                <Badge variant="outline" className="text-xs">apply-engine: {String(task.application_id).slice(0, 8)}…</Badge>
              )}
              <Badge variant="outline" className="text-xs">{task.assigned_agent}</Badge>
              {task.auto_submit_enabled && (
                <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
                  Auto-submit ON
                </Badge>
              )}
            </div>
            {task.last_agent_message && (
              <div className="text-sm bg-purple-50 border border-purple-200 rounded p-3">
                <span className="font-medium text-purple-900">Hamilton said:</span> {task.last_agent_message}
              </div>
            )}

            {task.status === 'submitted' && task.submission_proof && (
              task.submission_proof.verified_external ? (
                <div className="text-sm bg-emerald-50 border border-emerald-200 rounded p-3 space-y-1.5">
                  <div className="flex items-center gap-2 font-medium text-emerald-900">
                    <CheckCircle2 className="w-4 h-4" /> Externally submitted — portal confirmation on file
                  </div>
                  {task.submission_proof.confirmation_reference && (
                    <div className="text-xs text-emerald-800">Confirmation: {task.submission_proof.confirmation_reference}</div>
                  )}
                  {task.submission_proof.proof_document_id && (
                    <a
                      href={downloadHref(task.submission_proof.proof_document_id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-emerald-300 hover:bg-emerald-100 text-emerald-900"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="w-3 h-3" /> Open confirmation
                    </a>
                  )}
                </div>
              ) : (
                <div className="text-sm bg-amber-50 border border-amber-200 rounded p-3 space-y-1">
                  <div className="flex items-center gap-2 font-medium text-amber-900">
                    <AlertTriangle className="w-4 h-4" /> Marked submitted (internal record only)
                  </div>
                  <div className="text-xs text-amber-800">
                    This records that it was marked submitted — it is <span className="font-semibold">not</span> confirmed sent to the
                    funder, and no captured portal confirmation is on file. A generated application packet is what would be submitted,
                    never proof that it was.
                  </div>
                </div>
              )
            )}

            {openBlockers.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-amber-900 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> Hard stops awaiting action ({openBlockers.length})
                </h4>
                {openBlockers.map((b) => (
                  <BlockerCard
                    key={b.id}
                    blocker={b}
                    busy={busy}
                    onResume={() => resolveBlocker(`Resolved ${b.blocker_type}`)}
                    onCancel={cancelTask}
                  />
                ))}
              </div>
            )}

            {(task.output_pdf_document_id || task.output_docx_document_id) && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-slate-800">Generated application packet</h4>
                <div className="flex flex-wrap gap-2">
                  {task.output_docx_document_id && (
                    <a
                      href={downloadHref(task.output_docx_document_id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-slate-300 hover:bg-slate-50"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="w-3 h-3" /> Download DOCX
                    </a>
                  )}
                  {task.output_pdf_document_id && (
                    <a
                      href={downloadHref(task.output_pdf_document_id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-slate-300 hover:bg-slate-50"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="w-3 h-3" /> Download PDF
                    </a>
                  )}
                  <Button variant="ghost" size="sm" onClick={regeneratePacket} disabled={busy}>
                    Regenerate
                  </Button>
                </div>
              </div>
            )}

            {task.mailing_instructions && Array.isArray(task.mailing_instructions.instructions) && task.mailing_instructions.instructions.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-slate-800">Submission instructions</h4>
                <ul className="text-xs text-slate-700 list-disc pl-5 space-y-1 bg-slate-50 border border-slate-200 rounded p-3">
                  {task.mailing_instructions.instructions.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                {(task.status === 'ready_to_print_mail' || task.status === 'ready_to_email' || task.status === 'ready_to_fax') && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {task.status === 'ready_to_print_mail' && (
                      <Button size="sm" variant="outline" onClick={() => markChannel('mailed')} disabled={busy}>
                        <Mail className="w-3 h-3 mr-1" /> Mark mailed
                      </Button>
                    )}
                    {task.status === 'ready_to_email' && (
                      <Button size="sm" variant="outline" onClick={() => markChannel('emailed')} disabled={busy}>
                        <Send className="w-3 h-3 mr-1" /> Mark emailed
                      </Button>
                    )}
                    {task.status === 'ready_to_fax' && (
                      <Button size="sm" variant="outline" onClick={() => markChannel('faxed')} disabled={busy}>
                        <Phone className="w-3 h-3 mr-1" /> Mark faxed
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {missingInfo.length > 0 ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-amber-800">
                  <AlertTriangle className="w-4 h-4" />
                  <h4 className="text-sm font-semibold">Provide missing information</h4>
                </div>

                {/* Items that map to a profile field → clickable checklist that
                    deep-links straight into the matching ProfileDetail section. */}
                {missingInfo.some((m) => resolveMissingInfoTarget(m.key)) && (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-500">
                      Fix these on the profile — each links to the exact section. Hamilton re-checks them on the next continue.
                    </p>
                    <MissingInfoChecklist
                      profileId={task?.profile_id}
                      items={missingInfo.filter((m) => resolveMissingInfoTarget(m.key))}
                    />
                  </div>
                )}

                {/* Items with no profile home (portal login, funder address,
                    application fee, …) — answer Hamilton directly inline. */}
                {missingInfo.some((m) => !resolveMissingInfoTarget(m.key)) && (
                  <div className="space-y-3">
                    <p className="text-xs font-medium text-slate-600">Answer Hamilton directly</p>
                    {missingInfo.filter((m) => !resolveMissingInfoTarget(m.key)).map((m) => (
                      <div key={m.id} className="space-y-1">
                        <label className="text-xs font-medium text-slate-700 flex items-center gap-2">
                          {m.label || m.key}
                          <Badge variant="outline" className="text-[10px]">{m.kind}</Badge>
                        </label>
                        {m.description && <p className="text-xs text-slate-500">{m.description}</p>}
                        {m.kind === 'document' || m.kind === 'login' ? (
                          <Input
                            placeholder={m.kind === 'login' ? 'Confirmation that you logged in (e.g. yes)' : 'Document filename or note'}
                            value={values[m.id] ?? ''}
                            onChange={(e) => setValues((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          />
                        ) : (
                          <Textarea
                            rows={2}
                            placeholder="Type the answer here…"
                            value={values[m.id] ?? ''}
                            onChange={(e) => setValues((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          />
                        )}
                      </div>
                    ))}
                    <Button onClick={submitMissingInfo} disabled={busy} size="sm">
                      {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                      Send to Hamilton
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="w-4 h-4" />
                No missing information. Hamilton is ready to continue.
              </div>
            )}

            {events.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-slate-800">Audit timeline</h4>
                <ol className="space-y-2 max-h-48 overflow-auto pr-2">
                  {events.slice().reverse().map((e) => (
                    <li key={e.id} className="text-xs text-slate-700 border-l-2 border-purple-300 pl-3">
                      <div className="font-medium">{e.event_type}{e.status ? ` — ${e.status}` : ''}</div>
                      {e.message && <div className="text-slate-500">{e.message}</div>}
                      <div className="text-[10px] text-slate-400">{new Date(e.created_at).toLocaleString()}</div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {task && !['submitted', 'cancelled', 'failed'].includes(task.status) && (
            <>
              <Button variant="outline" size="sm" onClick={continueHamilton} disabled={busy}>
                {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
                Let Hamilton continue
              </Button>
              {task.auto_submit_enabled ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => approveAutoSubmit(false)}
                  disabled={busy}
                >
                  Disable auto-submit
                </Button>
              ) : (
                <span className="max-w-56 text-xs text-slate-500">
                  Auto-submit is authorized only from Run to completion, where the current terms and exact task are shown.
                </span>
              )}
            </>
          )}
          {task?.application_url && (
            <a
              href={task.application_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" /> Open portal
            </a>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const ACTION_LABEL = {
  provide_info: 'Resolve blocker and continue Hamilton',
  upload_document: 'Upload document and continue Hamilton',
  renew_session: 'Renew login session and continue Hamilton',
  approve_payment: 'Approve payment and continue Hamilton',
  review_attestation: 'Review attestation and continue Hamilton',
  admin_review: 'Admin review',
  resume: 'Resume Hamilton',
  review: 'Review and continue Hamilton',
  find_alternate: 'Find alternate funding',
  cancel: 'Cancel task',
}

function BlockerCard({ blocker, busy, onResume, onCancel }) {
  const action = blocker?.required_action || 'resume'
  const label = ACTION_LABEL[action] || 'Resolve and continue'
  return (
    <div className="bg-amber-50 border border-amber-200 rounded p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-amber-900">{blocker.blocker_title || blocker.blocker_type}</div>
          <div className="text-xs text-amber-800">{blocker.blocker_message || ''}</div>
          {blocker.deadline_at ? (
            <div className="text-[11px] text-amber-700 mt-1">Deadline: {new Date(blocker.deadline_at).toLocaleString()}</div>
          ) : null}
          <div className="text-[11px] text-amber-700 mt-1">
            {blocker.user_required ? 'User action required.' : ''}
            {blocker.admin_required ? ' Admin can also resolve.' : ''}
          </div>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 border border-amber-300 text-amber-900 whitespace-nowrap">
          {blocker.blocker_type.replace(/_/g, ' ')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={onResume} disabled={busy}>
          {label}
        </Button>
        <Button size="sm" variant="outline" onClick={onResume} disabled={busy}>
          Resume Hamilton
        </Button>
        <Button size="sm" variant="ghost" className="text-rose-700 hover:bg-rose-50" onClick={onCancel} disabled={busy}>
          Cancel task
        </Button>
      </div>
    </div>
  )
}
