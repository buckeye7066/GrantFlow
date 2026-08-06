import React, { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { CheckCircle, Download, FileText, Loader2, Send, Sparkles, AlertTriangle } from 'lucide-react'
import {
  autoPopulate,
  exportPackage,
  getApplication,
  listChecklist,
  listSections,
  setChecklistItem,
  submit,
  validate,
} from '@/api/applicationsApi'
import { downloadAuthenticatedUrl } from '@/utils/authenticatedDownload'
import { createLogger } from '@/utils/logger'

const log = createLogger('SubmissionAssistant')

export default function SubmissionAssistant({ open, onClose, grant, organization, applicationId }) {
  const queryClient = useQueryClient()

  const [submissionMethod, setSubmissionMethod] = useState('download')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [recipientFax, setRecipientFax] = useState('')
  const [recipientAddress, setRecipientAddress] = useState('')
  const [notes, setNotes] = useState('')
  // Hard-confirm step: "Mark submitted" with an incomplete checklist first
  // shows the incomplete items and requires an explicit acknowledgment
  // (walkthrough 2026-08-03: it was one silent click at "Checklist: 0/6 done").
  const [confirmingIncomplete, setConfirmingIncomplete] = useState(false)

  const { data: application } = useQuery({
    queryKey: ['application', applicationId],
    enabled: Boolean(open && applicationId),
    queryFn: () => getApplication(applicationId),
  })

  const { data: sections = [] } = useQuery({
    queryKey: ['applicationSections', applicationId],
    enabled: Boolean(open && applicationId),
    queryFn: () => listSections(applicationId),
  })

  const { data: checklist = [] } = useQuery({
    queryKey: ['applicationChecklist', applicationId],
    enabled: Boolean(open && applicationId),
    queryFn: () => listChecklist(applicationId),
  })

  const validateMutation = useMutation({
    mutationFn: () => validate(applicationId),
  })

  const exportMutation = useMutation({
    mutationFn: (format) => exportPackage(applicationId, format),
    onSuccess: (result) => {
      const url = result?.artifact?.download_url
      if (url) {
        downloadAuthenticatedUrl(url, { fallbackFileName: `application_${applicationId || 'export'}.docx` }).catch((err) => {
          console.error('[SubmissionAssistant] export download failed', err)
          // NOTE: surface this to the user via a toast/alert in a follow-up;
          // at minimum we log so the failure is observable.
        })
      } else {
        console.warn('[SubmissionAssistant] exportPackage returned no download_url', result)
      }
    },
    onError: (err) => {
      console.error('[SubmissionAssistant] exportPackage API call failed', err)
    },
  })

  const submitMutation = useMutation({
    mutationFn: ({ method, metadata, confirmIncomplete }) =>
      submit(applicationId, method, metadata, { confirmIncomplete: Boolean(confirmIncomplete) }),
    onSuccess: () => {
      setConfirmingIncomplete(false)
      queryClient.invalidateQueries({ queryKey: ['grant', grant?.id] })
      queryClient.invalidateQueries({ queryKey: ['grants'] })
      queryClient.invalidateQueries({ queryKey: ['application', applicationId] })
      onClose?.()
    },
    onError: (err) => {
      // The server guard (409 CHECKLIST_INCOMPLETE) is the net for callers
      // that skipped the client-side confirm — route it into the same
      // hard-confirm panel instead of failing silently.
      if (err?.errorCode === 'CHECKLIST_INCOMPLETE' || err?.status === 409) {
        setConfirmingIncomplete(true)
        return
      }
      console.error('[SubmissionAssistant] submit failed', err)
    },
  })

  const checklistToggleMutation = useMutation({
    mutationFn: ({ key, status }) => setChecklistItem(applicationId, key, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applicationChecklist', applicationId] })
    },
  })

  const autoPopulateMutation = useMutation({
    mutationFn: () => autoPopulate(applicationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applicationSections', applicationId] })
      queryClient.invalidateQueries({ queryKey: ['applicationChecklist', applicationId] })
      queryClient.invalidateQueries({ queryKey: ['application', applicationId] })
    },
  })

  const validation = validateMutation.data ?? null
  const ready = Boolean(validation?.ready)
  const missingChecklist = Array.isArray(validation?.missing?.checklist) ? validation.missing.checklist : []
  const emptySections = Array.isArray(validation?.missing?.empty_sections) ? validation.missing.empty_sections : []
  const noSections = Boolean(validation?.missing?.no_sections)

  const focusSection = (sectionKey) => {
    if (!sectionKey) return
    // Lightweight + reversible cross-panel navigation (no API changes).
    log.debug('focus section', sectionKey)
    window.dispatchEvent(new CustomEvent('applyEngine:focusSection', { detail: { sectionKey: String(sectionKey) } }))
    onClose?.()
  }

  const checklistDone = useMemo(
    () => (checklist || []).filter((i) => String(i.status || '').toLowerCase() === 'done').length,
    [checklist],
  )

  const incompleteChecklist = useMemo(
    () => (checklist || []).filter((i) => String(i.status || '').toLowerCase() !== 'done'),
    [checklist],
  )

  const canSubmit =
    Boolean(applicationId) &&
    Boolean(submissionMethod) &&
    (() => {
      if (submissionMethod === 'download' || submissionMethod === 'portal') return true
      if (submissionMethod === 'email') return Boolean(recipientEmail)
      if (submissionMethod === 'fax') return Boolean(recipientFax)
      if (submissionMethod === 'mail') return Boolean(recipientAddress)
      return false
    })()

  const buildSubmitPayload = (confirmIncomplete) => ({
    method: submissionMethod,
    metadata: {
      recipient_email: recipientEmail || null,
      recipient_fax: recipientFax || null,
      recipient_address: recipientAddress || null,
      notes: notes || null,
      org_name: organization?.name ?? null,
    },
    confirmIncomplete,
  })

  const handleMarkSubmitted = () => {
    if (incompleteChecklist.length > 0) {
      // Hard-confirm first: name the incomplete items instead of silently
      // recording a "submitted" status past a 0/6 checklist.
      setConfirmingIncomplete(true)
      return
    }
    submitMutation.mutate(buildSubmitPayload(false))
  }

  const busy = validateMutation.isPending || exportMutation.isPending || submitMutation.isPending || autoPopulateMutation.isPending

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-5 h-5 text-blue-600" />
            Submission / Apply Engine
          </DialogTitle>
          <DialogDescription>
            Prepare → validate → export → mark submitted for {grant?.title || 'this grant'}
          </DialogDescription>
          <p className="text-xs text-slate-500 mt-1">
            "Mark submitted" records in GrantFlow that <span className="font-medium">you submitted this application
            yourself</span> — it is internal status only and transmits nothing to the funder. Hamilton can prepare,
            fill, and save a portal draft; final portal review, login or 2FA, signatures, Submit, and confirmation
            remain your visible handoff.
          </p>
        </DialogHeader>

        <div className="space-y-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-slate-700">
              <div>
                <span className="font-semibold">Application:</span> {application?.id ? String(application.id).slice(0, 8) : '—'}
              </div>
              <div className="text-xs text-slate-500">
                Status: <span className="font-mono">{application?.status ?? 'draft'}</span>
              </div>
            </div>
            <Button variant="outline" size="sm" disabled={!applicationId || autoPopulateMutation.isPending} onClick={() => autoPopulateMutation.mutate()}>
              {autoPopulateMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Seeding…
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                  Auto-populate
                    </>
                  )}
                </Button>
          </div>

          <Alert className={ready ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}>
            <AlertTitle className="flex items-center gap-2">
              {ready ? <CheckCircle className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-amber-600" />}
              Readiness
            </AlertTitle>
            <AlertDescription className="text-sm mt-2">
              <div className="flex items-center gap-2 mb-2">
                <Badge className={ready ? 'bg-emerald-600' : 'bg-amber-600'}>
                  Checklist: {checklistDone}/{(checklist || []).length} done
                </Badge>
                <Badge variant="secondary">Sections: {(sections || []).length}</Badge>
              </div>
              {validation ? (
                ready ? (
                  'Ready to submit.'
                ) : (
                  <div className="space-y-3">
                    <p>Not ready yet — fix the items below.</p>

                    {noSections ? (
                      <div>
                        <p className="font-medium">No sections created</p>
                        <p className="text-xs text-amber-800">Use Auto-populate, then fill in each section.</p>
                      </div>
                    ) : null}

                    {emptySections.length > 0 ? (
                      <div>
                        <p className="font-medium">Empty sections</p>
                        <ul className="mt-1 space-y-1 list-disc ml-5">
                          {emptySections.slice(0, 10).map((s) => (
                            <li key={s.section_key}>
                              <button
                                type="button"
                                className="underline underline-offset-2 hover:no-underline"
                                onClick={() => focusSection(s.section_key)}
                              >
                                {s.title || s.section_key}
                              </button>
                              <span className="text-xs text-amber-800"> — add content</span>
                            </li>
                          ))}
                        </ul>
                        {emptySections.length > 10 ? (
                          <p className="text-xs text-amber-800 mt-1">+{emptySections.length - 10} more</p>
                        ) : null}
                      </div>
                    ) : null}

                    {missingChecklist.length > 0 ? (
                      <div>
                        <p className="font-medium">Incomplete checklist items</p>
                        <ul className="mt-1 space-y-1 list-disc ml-5">
                          {missingChecklist.slice(0, 10).map((i) => (
                            <li key={i.key}>
                              <span className="font-medium">{i.label || i.key}</span>
                              <span className="text-xs text-amber-800"> — status: {i.status || 'pending'}</span>
                            </li>
                          ))}
                        </ul>
                        {missingChecklist.length > 10 ? (
                          <p className="text-xs text-amber-800 mt-1">+{missingChecklist.length - 10} more</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              ) : (
                'Run Validate to compute readiness.'
              )}
              </AlertDescription>
            </Alert>

          {(checklist || []).length > 0 ? (
            <div>
              <Label className="text-base font-semibold mb-2 block">Checklist</Label>
              <ul className="space-y-1">
                {(checklist || []).map((item) => {
                  const done = String(item.status || '').toLowerCase() === 'done'
                  return (
                    <li key={item.key} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        id={`checklist-${item.key}`}
                        className="mt-0.5"
                        checked={done}
                        disabled={checklistToggleMutation.isPending}
                        onChange={() =>
                          checklistToggleMutation.mutate({ key: item.key, status: done ? 'pending' : 'done' })
                        }
                      />
                      <label htmlFor={`checklist-${item.key}`} className={done ? 'text-slate-500 line-through' : ''}>
                        {item.label || item.key}
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          <div>
            <Label className="text-base font-semibold mb-3 block">Submission Method</Label>
            <RadioGroup value={submissionMethod} onValueChange={setSubmissionMethod}>
              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="download" id="download" />
                <Label htmlFor="download" className="cursor-pointer flex-1">
                  <div className="flex items-center gap-2">
                    <Download className="w-4 h-4 text-slate-700" />
                    <span className="font-medium">Download</span>
                  </div>
                  <p className="text-xs text-slate-600">Export a package and submit it yourself.</p>
                </Label>
              </div>
              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="email" id="email" />
                <Label htmlFor="email" className="cursor-pointer flex-1">
                  <div className="flex items-center gap-2">
                    <Send className="w-4 h-4 text-blue-700" />
                    <span className="font-medium">Email</span>
                  </div>
                  <p className="text-xs text-slate-600">Track email submission metadata (we don’t send email in this step).</p>
                </Label>
              </div>
              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="fax" id="fax" />
                <Label htmlFor="fax" className="cursor-pointer flex-1">
                  <div className="flex items-center gap-2">
                    <Send className="w-4 h-4 text-purple-700" />
                    <span className="font-medium">Fax</span>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="mail" id="mail" />
                <Label htmlFor="mail" className="cursor-pointer flex-1">
                  <div className="flex items-center gap-2">
                    <Send className="w-4 h-4 text-green-700" />
                    <span className="font-medium">Mail</span>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="portal" id="portal" />
                <Label htmlFor="portal" className="cursor-pointer flex-1">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-700" />
                    <span className="font-medium">Portal</span>
          </div>
                  <p className="text-xs text-slate-600">
                    {application?.portal_url ? (
                      <>
                        Portal URL on file: <span className="font-mono">{String(application.portal_url).slice(0, 48)}…</span>
                      </>
                    ) : (
                      'No verified portal URL on file — unverified — confirm with funder.'
                    )}
                  </p>
                </Label>
              </div>
            </RadioGroup>
              </div>

          {submissionMethod !== 'download' ? (
            <div className="space-y-3 p-4 bg-slate-50 rounded-lg border">
              <p className="text-sm font-semibold">Submission metadata</p>
              {submissionMethod === 'email' ? (
                <div>
                  <Label htmlFor="recipientEmail">Recipient email</Label>
                  <Input id="recipientEmail" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} />
                </div>
              ) : null}
              {submissionMethod === 'fax' ? (
                <div>
                  <Label htmlFor="recipientFax">Fax number</Label>
                  <Input id="recipientFax" value={recipientFax} onChange={(e) => setRecipientFax(e.target.value)} />
                </div>
              ) : null}
              {submissionMethod === 'mail' ? (
              <div>
                  <Label htmlFor="recipientAddress">Mailing address</Label>
                  <Textarea id="recipientAddress" value={recipientAddress} onChange={(e) => setRecipientAddress(e.target.value)} rows={3} />
              </div>
              ) : null}
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
              </div>
            </div>
          ) : null}

          {confirmingIncomplete ? (
            <Alert className="bg-red-50 border-red-200">
              <AlertTitle className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                Checklist is not complete — really record as submitted?
              </AlertTitle>
              <AlertDescription className="text-sm mt-2 space-y-2">
                <p>
                  These {incompleteChecklist.length} checklist item{incompleteChecklist.length === 1 ? ' is' : 's are'} not
                  done:
                </p>
                <ul className="list-disc ml-5 space-y-0.5">
                  {incompleteChecklist.slice(0, 10).map((i) => (
                    <li key={i.key}>{i.label || i.key}</li>
                  ))}
                  {incompleteChecklist.length > 10 ? <li>+{incompleteChecklist.length - 10} more</li> : null}
                </ul>
                <p>
                  This records <span className="font-semibold">internal status only</span> — it does not transmit
                  anything to the funder. Only continue if you already submitted this application to the funder
                  yourself.
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={() => setConfirmingIncomplete(false)} disabled={submitMutation.isPending}>
                    Go back
                  </Button>
                  <Button
                    size="sm"
                    className="bg-red-600 hover:bg-red-700"
                    onClick={() => submitMutation.mutate(buildSubmitPayload(true))}
                    disabled={submitMutation.isPending}
                  >
                    {submitMutation.isPending ? 'Saving…' : 'I already submitted it myself — record as submitted'}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Close
            </Button>
            <Button variant="outline" onClick={() => validateMutation.mutate()} disabled={!applicationId || validateMutation.isPending}>
              {validateMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Validating…
                </>
              ) : (
                'Validate'
              )}
          </Button>
          <Button 
              variant="outline"
              onClick={() => exportMutation.mutate('docx')}
              disabled={!applicationId || exportMutation.isPending}
            >
              {exportMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Exporting…
              </>
              ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                  Export DOCX
                </>
              )}
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={handleMarkSubmitted}
              disabled={!canSubmit || submitMutation.isPending || confirmingIncomplete}
              title="Records internal status only — transmits nothing to the funder"
            >
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving…
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                  Mark submitted (record only)
              </>
            )}
          </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
