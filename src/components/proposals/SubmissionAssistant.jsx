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
  submit,
  validate,
} from '@/api/applicationsApi'

export default function SubmissionAssistant({ open, onClose, grant, organization, applicationId }) {
  const queryClient = useQueryClient()

  const [submissionMethod, setSubmissionMethod] = useState('download')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [recipientFax, setRecipientFax] = useState('')
  const [recipientAddress, setRecipientAddress] = useState('')
  const [notes, setNotes] = useState('')

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
      if (url) window.location.assign(url)
    },
  })

  const submitMutation = useMutation({
    mutationFn: ({ method, metadata }) => submit(applicationId, method, metadata),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grant', grant?.id] })
      queryClient.invalidateQueries({ queryKey: ['grants'] })
      queryClient.invalidateQueries({ queryKey: ['application', applicationId] })
      onClose?.()
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

  const checklistDone = useMemo(
    () => (checklist || []).filter((i) => String(i.status || '').toLowerCase() === 'done').length,
    [checklist],
  )

  const canSubmit =
    Boolean(applicationId) &&
    Boolean(submissionMethod) &&
    (submissionMethod === 'download' || recipientEmail || recipientFax || recipientAddress || notes)

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
                  'Not ready yet — run Validate to see what’s missing.'
                )
              ) : (
                'Run Validate to compute readiness.'
              )}
            </AlertDescription>
          </Alert>

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
                      'No portal URL on file (use Auto-populate).'
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
              onClick={() =>
                submitMutation.mutate({
                  method: submissionMethod,
                  metadata: {
                    recipient_email: recipientEmail || null,
                    recipient_fax: recipientFax || null,
                    recipient_address: recipientAddress || null,
                    notes: notes || null,
                    org_name: organization?.name ?? null,
                  },
                })
              }
              disabled={!canSubmit || submitMutation.isPending}
            >
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Mark submitted
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
