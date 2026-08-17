import React, { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ExternalLink, FileCheck2, Loader2 } from 'lucide-react'
import {
  auditGroundedDraft,
  finalizeLifecycleDraft,
  getApplicationLifecycle,
  linkApplicationLifecycle,
  recordOutcomeEvidence,
  revokeOutcomeEvidence,
} from '@/api/grantLifecycle'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { downloadAuthenticatedUrl } from '@/utils/authenticatedDownload'

function unwrap(response) {
  return response?.lifecycle || response?.data?.lifecycle || null
}

function StateBanner({ lifecycle }) {
  const state = lifecycle?.state
  const verified = Boolean(
    lifecycle?.submission?.proof?.verified_external
    || lifecycle?.outcome?.verified,
  )
  return (
    <Alert className={verified ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}>
      {verified
        ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        : <AlertTriangle className="h-4 w-4 text-amber-600" />}
      <AlertTitle>{state?.label || 'Lifecycle state unavailable'}</AlertTitle>
      <AlertDescription>
        {state?.terminal
          ? `Verified terminal outcome: ${state.terminal_state}.`
          : 'This is not a verified terminal outcome. Internal status flags are shown separately from external proof.'}
      </AlertDescription>
    </Alert>
  )
}

function RequirementList({ solicitation, coverage }) {
  const coverageByRequirement = new Map((coverage || []).map((row) => [row.requirement_id, row]))
  const requirements = solicitation?.requirements || []
  if (!requirements.length) {
    return <p className="text-sm text-slate-600">No versioned solicitation requirements are linked yet.</p>
  }
  return (
    <div className="space-y-3">
      {requirements.map((requirement) => {
        const row = coverageByRequirement.get(requirement.id)
        return (
          <div key={requirement.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={requirement.mandatory ? 'destructive' : 'secondary'}>
                {requirement.mandatory ? 'Required' : 'Optional'}
              </Badge>
              <Badge variant="outline">{requirement.requirement_type}</Badge>
              <Badge variant="outline">{row?.coverage_status || 'not audited'}</Badge>
            </div>
            <p className="mt-2 font-medium">{requirement.title || requirement.requirement_text}</p>
            {requirement.title && <p className="mt-1 text-sm text-slate-700">{requirement.requirement_text}</p>}
            {(requirement.citations || []).map((citation) => (
              <blockquote key={citation.id} className="mt-2 border-l-2 pl-3 text-xs text-slate-600">
                “{citation.quote_text}” — chunk {Number(citation.chunk_index) + 1}, chars {citation.char_start}–{citation.char_end}
                {citation.source_url && (
                  <a className="ml-2 inline-flex items-center text-blue-700" href={citation.source_url} target="_blank" rel="noreferrer">
                    source <ExternalLink className="ml-1 h-3 w-3" />
                  </a>
                )}
              </blockquote>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function requirementPayload(requirements, fields) {
  return requirements.flatMap((requirement) => {
    const response = fields[requirement.id] || {}
    const excerpt = String(response.excerpt || '').trim()
    if (!excerpt) return []
    const pageCount = Number(response.pageCount)
    return [{
      requirement_id: requirement.id,
      response_excerpt: excerpt,
      response_text: String(response.responseText || '').trim() || excerpt,
      ...(Number.isInteger(pageCount) && pageCount > 0 ? { page_count: pageCount } : {}),
      status: 'addressed',
      applicant_evidence: [],
    }]
  })
}

function GroundingWorkspace({ lifecycle, applicationId, onChanged }) {
  const { toast } = useToast()
  const drafts = lifecycle?.drafts || []
  const requirements = lifecycle?.solicitation?.requirements || []
  const [draftId, setDraftId] = useState('')
  const [fields, setFields] = useState({})
  const [claimFields, setClaimFields] = useState({})
  const [audit, setAudit] = useState(null)
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    if (!draftId && drafts[0]?.id) setDraftId(String(drafts[0].id))
  }, [draftId, drafts])

  const draft = useMemo(
    () => drafts.find((row) => String(row.id) === String(draftId)) || null,
    [draftId, drafts],
  )
  const responses = requirementPayload(requirements, fields)
  const evidenceSources = lifecycle?.grounding_evidence_sources || []
  const claimEvidence = Object.entries(claimFields).flatMap(([claim, field]) => {
    const exactQuote = String(field?.quote || '').trim()
    const source = evidenceSources.find((candidate) =>
      `${candidate.source_type}:${candidate.source_id}` === field?.sourceKey)
    if (!exactQuote || !source) return []
    return [{
      claim,
      evidence: [{
        source_type: source.source_type,
        source_id: source.source_id,
        quote_text: exactQuote,
      }],
    }]
  })

  const payload = () => ({
    draft_id: draft.id,
    draft_text: draft.content,
    requirement_responses: responses,
    claim_evidence: claimEvidence,
  })

  const captureAudit = (error) => {
    const groundedAudit = error?.details?.audit || null
    if (groundedAudit) setAudit(groundedAudit)
    toast({
      variant: 'destructive',
      title: groundedAudit ? 'Grounding blockers remain' : 'Grounding check failed',
      description: groundedAudit
        ? `${groundedAudit.blockers?.length || 0} blocker(s) must be resolved before finalization.`
        : error?.message || 'The draft could not be checked.',
    })
  }

  const runAudit = async () => {
    if (!draft?.content) return
    setBusy('audit')
    try {
      const result = await auditGroundedDraft(applicationId, payload())
      setAudit(result.audit)
      toast({
        title: result.audit?.can_finalize ? 'Draft is grounded' : 'Grounding review complete',
        description: result.audit?.can_finalize
          ? 'Every mandatory requirement and detected applicant claim has evidence.'
          : `${result.audit?.blockers?.length || 0} blocker(s) remain.`,
      })
      await onChanged()
    } catch (error) {
      captureAudit(error)
    } finally {
      setBusy(null)
    }
  }

  const finalizeDraft = async () => {
    if (!draft?.content || !audit?.can_finalize) return
    setBusy('finalize')
    try {
      const result = await finalizeLifecycleDraft(draft.id, {
        content: draft.content,
        requirement_responses: responses,
        claim_evidence: claimEvidence,
      })
      setAudit(result.grounding_audit || audit)
      toast({ title: 'Draft finalized', description: 'The final draft passed the stored requirement and evidence checks.' })
      await onChanged()
    } catch (error) {
      captureAudit(error)
    } finally {
      setBusy(null)
    }
  }

  if (!drafts.length) {
    return <p className="text-sm text-slate-600">Create a proposal draft for this application before running the grounding review.</p>
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="grounding-draft">Draft section</Label>
        <select
          id="grounding-draft"
          className="h-10 w-full rounded-md border bg-white px-3 text-sm"
          value={draftId}
          onChange={(event) => {
            setDraftId(event.target.value)
            setAudit(null)
          }}
        >
          {drafts.map((row) => <option key={row.id} value={row.id}>{row.section_name || 'Untitled section'} · {row.status}</option>)}
        </select>
      </div>

      <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-slate-50 p-3 text-sm">
        {draft?.content || 'This draft has no text yet.'}
      </div>

      {requirements.map((requirement) => {
        const response = fields[requirement.id] || {}
        return (
          <div key={requirement.id} className="space-y-2 rounded-lg border p-3">
            <p className="font-medium">{requirement.title || requirement.requirement_text}</p>
            {requirement.title && <p className="text-sm text-slate-600">{requirement.requirement_text}</p>}
            <Label htmlFor={`excerpt-${requirement.id}`}>Exact passage in this draft</Label>
            <Textarea
              id={`excerpt-${requirement.id}`}
              value={response.excerpt || ''}
              onChange={(event) => setFields((current) => ({
                ...current,
                [requirement.id]: { ...current[requirement.id], excerpt: event.target.value },
              }))}
              placeholder="Paste the exact sentence or passage that answers this requirement."
            />
            <div className="grid gap-3 md:grid-cols-[1fr_10rem]">
              <div>
                <Label htmlFor={`response-${requirement.id}`}>Complete response text (when limits apply)</Label>
                <Textarea
                  id={`response-${requirement.id}`}
                  value={response.responseText || ''}
                  onChange={(event) => setFields((current) => ({
                    ...current,
                    [requirement.id]: { ...current[requirement.id], responseText: event.target.value },
                  }))}
                  placeholder="Optional unless the requirement has word, page, question, budget, or match constraints."
                />
              </div>
              <div>
                <Label htmlFor={`pages-${requirement.id}`}>Page count</Label>
                <Input
                  id={`pages-${requirement.id}`}
                  min="1"
                  type="number"
                  value={response.pageCount || ''}
                  onChange={(event) => setFields((current) => ({
                    ...current,
                    [requirement.id]: { ...current[requirement.id], pageCount: event.target.value },
                  }))}
                />
              </div>
            </div>
          </div>
        )
      })}

      {(audit?.unsupported_claims || []).map(({ claim, reason }, claimIndex) => {
        const field = claimFields[claim] || {}
        const selectedSource = evidenceSources.find((candidate) =>
          `${candidate.source_type}:${candidate.source_id}` === field.sourceKey)
        return (
          <div key={claim} className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="font-medium">Applicant claim needs saved-profile evidence</p>
            <p className="text-sm">{claim}</p>
            <p className="text-xs text-slate-600">{reason}</p>
            {evidenceSources.length > 0 ? (
              <>
                <Label htmlFor={`claim-source-${claimIndex}`}>Saved evidence source</Label>
                <select
                  id={`claim-source-${claimIndex}`}
                  className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                  value={field.sourceKey || ''}
                  onChange={(event) => setClaimFields((current) => ({
                    ...current,
                    [claim]: { ...current[claim], sourceKey: event.target.value },
                  }))}
                >
                  <option value="">Select the exact saved source</option>
                  {evidenceSources.map((source) => (
                    <option key={`${source.source_type}:${source.source_id}`} value={`${source.source_type}:${source.source_id}`}>
                      {source.label} ({source.source_type.replaceAll('_', ' ')})
                    </option>
                  ))}
                </select>
                {selectedSource && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-white p-2 text-xs">
                    {JSON.stringify(selectedSource.value, null, 2)}
                  </pre>
                )}
                <Label htmlFor={`claim-quote-${claimIndex}`}>Exact supporting quote from that source</Label>
                <Textarea
                  id={`claim-quote-${claimIndex}`}
                  value={field.quote || ''}
                  onChange={(event) => setClaimFields((current) => ({
                    ...current,
                    [claim]: { ...current[claim], quote: event.target.value },
                  }))}
                  placeholder="Paste an exact quote from the selected source. The server verifies both the source id and text."
                />
              </>
            ) : (
              <p className="text-sm text-amber-800">Save the supporting fact in the applicant profile before finalizing this claim.</p>
            )}
          </div>
        )
      })}

      {audit && (
        <Alert className={audit.can_finalize ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}>
          {audit.can_finalize ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          <AlertTitle>{audit.can_finalize ? 'Ready to finalize' : 'Grounding blockers remain'}</AlertTitle>
          <AlertDescription>
            {audit.summary?.addressed || 0} of {audit.summary?.requirements_total || 0} requirements addressed.
            {(audit.blockers || []).slice(0, 6).map((blocker, index) => (
              <span key={`${blocker.code}-${index}`} className="mt-1 block">• {blocker.label || blocker.claim || blocker.code}</span>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={runAudit} disabled={!draft?.content || Boolean(busy)}>
          {busy === 'audit' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Run grounding check
        </Button>
        {audit?.can_finalize && draft?.status !== 'final' && (
          <Button onClick={finalizeDraft} disabled={Boolean(busy)}>
            {busy === 'finalize' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Finalize grounded draft
          </Button>
        )}
      </div>
    </div>
  )
}

function OutcomeEvidenceForm({ lifecycle, applicationId, onChanged }) {
  const { toast } = useToast()
  const documents = (lifecycle?.documents?.durable_artifacts || []).filter((row) => row.bytes_retrievable)
  const [documentId, setDocumentId] = useState('')
  const [outcome, setOutcome] = useState('awarded')
  const [receivedAt, setReceivedAt] = useState('')
  const [reference, setReference] = useState('')
  const [revocationReason, setRevocationReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!documentId && documents[0]?.id) setDocumentId(String(documents[0].id))
  }, [documentId, documents])

  if (lifecycle?.outcome?.verified) {
    const revoke = async () => {
      if (revocationReason.trim().length < 3) {
        toast({ variant: 'destructive', title: 'Explain the correction', description: 'Enter why this evidence is mistaken or was rescinded.' })
        return
      }
      setBusy(true)
      try {
        await revokeOutcomeEvidence(applicationId, lifecycle.outcome.id, revocationReason.trim())
        toast({ title: 'Outcome evidence revoked', description: 'The original assertion remains in the audit trail and replacement proof can now be recorded.' })
        setRevocationReason('')
        await onChanged()
      } catch (error) {
        toast({ variant: 'destructive', title: 'Outcome evidence was not revoked', description: error?.message || 'The correction could not be recorded.' })
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className="space-y-3">
        <p className="text-sm text-emerald-700">Verified {lifecycle.outcome.outcome} evidence is on file.</p>
        <p className="text-xs text-slate-600">If the document was linked by mistake or the funder rescinded it, revoke this assertion before adding replacement proof. The audit record is retained.</p>
        <Label htmlFor="outcome-revocation-reason">Reason for correction</Label>
        <Textarea
          id="outcome-revocation-reason"
          value={revocationReason}
          onChange={(event) => setRevocationReason(event.target.value)}
          placeholder="For example: The funder rescinded this notice on August 12."
        />
        <Button variant="destructive" onClick={revoke} disabled={busy || revocationReason.trim().length < 3}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Revoke this outcome evidence
        </Button>
      </div>
    )
  }
  if (!documents.length) {
    return <p className="text-sm text-slate-600">Upload the funder’s response or signed withdrawal notice as an application document, then return here to verify the outcome.</p>
  }

  const submit = async () => {
    const received = new Date(receivedAt)
    if (!documentId || Number.isNaN(received.getTime())) {
      toast({ variant: 'destructive', title: 'Evidence and response time required', description: 'Choose a durable document and enter when the response was received.' })
      return
    }
    setBusy(true)
    try {
      await recordOutcomeEvidence(applicationId, {
        document_id: documentId,
        outcome,
        response_received_at: received.toISOString(),
        confirmation_reference: reference.trim() || null,
      })
      toast({ title: 'Outcome verified', description: 'The outcome is now tied to durable evidence and recorded in the lifecycle ledger.' })
      await onChanged()
    } catch (error) {
      toast({ variant: 'destructive', title: 'Outcome evidence was not recorded', description: error?.message || 'The evidence could not be verified.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="outcome-document">Funder response evidence</Label>
        <select id="outcome-document" className="h-10 w-full rounded-md border bg-white px-3 text-sm" value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
          {documents.map((document) => <option key={document.id} value={document.id}>{document.name}</option>)}
        </select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="verified-outcome">Outcome</Label>
          <select id="verified-outcome" className="h-10 w-full rounded-md border bg-white px-3 text-sm" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
            <option value="awarded">Awarded</option>
            <option value="declined">Declined</option>
            <option value="waitlisted">Waitlisted</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </div>
        <div>
          <Label htmlFor="response-received">Response received</Label>
          <Input id="response-received" type="datetime-local" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="confirmation-reference">Confirmation reference (optional)</Label>
        <Input id="confirmation-reference" value={reference} onChange={(event) => setReference(event.target.value)} />
      </div>
      <Button onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Verify outcome with this evidence
      </Button>
    </div>
  )
}

export default function GrantLifecycle() {
  const { applicationId } = useParams()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [bindingBusy, setBindingBusy] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const query = useQuery({
    queryKey: ['grant-lifecycle', applicationId],
    queryFn: () => getApplicationLifecycle(applicationId),
    enabled: Boolean(applicationId),
  })
  const lifecycle = unwrap(query.data)
  const refreshLifecycle = () => queryClient.invalidateQueries({ queryKey: ['grant-lifecycle', applicationId] })

  const bindLifecycle = async () => {
    if (!lifecycle) return
    setBindingBusy(true)
    try {
      await linkApplicationLifecycle(applicationId, {
        canonical_task_id: lifecycle.workflow?.task?.id || null,
        solicitation_id: lifecycle.solicitation?.id || null,
      })
      toast({ title: 'Lifecycle linked', description: 'Tasks, requirements, drafts, evidence, and outcomes now share one canonical application subject.' })
      await refreshLifecycle()
    } catch (error) {
      toast({ variant: 'destructive', title: 'Lifecycle could not be linked', description: error?.message || 'The canonical subject link failed.' })
    } finally {
      setBindingBusy(false)
    }
  }

  const downloadReceipt = async () => {
    const documentId = lifecycle?.submission?.proof?.proof_document_id
    if (!documentId) return
    setDownloadBusy(true)
    try {
      await downloadAuthenticatedUrl(`/api/documents/${encodeURIComponent(documentId)}/download`, {
        fallbackFileName: 'submission-receipt',
      })
    } catch (error) {
      toast({ variant: 'destructive', title: 'Receipt could not be opened', description: error?.message || 'The authenticated download failed.' })
    } finally {
      setDownloadBusy(false)
    }
  }

  if (query.isLoading) {
    return <div className="flex min-h-[320px] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></div>
  }
  if (query.isError || !lifecycle) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Lifecycle unavailable</AlertTitle>
          <AlertDescription>{query.error?.message || 'Application lifecycle could not be loaded.'}</AlertDescription>
        </Alert>
      </div>
    )
  }

  const changes = lifecycle.solicitation?.amendment_changes || []
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <div>
        <p className="text-sm text-slate-500">Application lifecycle</p>
        <h1 className="text-2xl font-bold">{lifecycle.opportunity?.title || lifecycle.application?.grant_name || 'Grant application'}</h1>
        <p className="text-sm text-slate-600">{lifecycle.opportunity?.sponsor || lifecycle.application?.funder_name || 'Funder not recorded'}</p>
      </div>

      <StateBanner lifecycle={lifecycle} />

      {!lifecycle.subject?.persisted && (
        <Alert>
          <FileCheck2 className="h-4 w-4" />
          <AlertTitle>Finish linking this lifecycle</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>The application is currently using derived links. Save them so requirements, tasks, drafts, evidence, and outcomes retain one explicit subject.</p>
            <Button size="sm" onClick={bindLifecycle} disabled={bindingBusy}>
              {bindingBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save canonical lifecycle link
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Authoritative requirements</CardTitle></CardHeader>
          <CardContent>
            {lifecycle.solicitation && (
              <p className="mb-3 text-sm text-slate-600">
                Version {lifecycle.solicitation.version_number} · {Number(lifecycle.solicitation.extracted_chars || 0).toLocaleString()} source characters · {lifecycle.solicitation.chunk_count} chunks
              </p>
            )}
            <RequirementList solicitation={lifecycle.solicitation} coverage={lifecycle.requirement_coverage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Submission proof</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{lifecycle.submission?.proof?.label || 'Not submitted'}</p>
            {lifecycle.submission?.proof?.proof_document_id && (
              <Button variant="link" className="h-auto p-0 text-blue-700" onClick={downloadReceipt} disabled={downloadBusy}>
                {downloadBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileCheck2 className="mr-1 h-4 w-4" />} Open receipt
              </Button>
            )}
            <p className="text-slate-600">
              Outcome: {lifecycle.outcome?.verified
                ? `${lifecycle.outcome.outcome} (evidence on file)`
                : lifecycle.outcome?.recorded_status
                  ? `${lifecycle.outcome.recorded_status} (unverified)`
                  : 'pending'}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Tasks and deadlines</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(lifecycle.workflow?.steps || []).map((step) => (
              <div key={step.id} className="flex justify-between gap-3 border-b py-2">
                <span>{step.title}</span><Badge variant="outline">{step.status}</Badge>
              </div>
            ))}
            {(lifecycle.workflow?.deadlines || []).map((deadline) => (
              <p key={deadline.id} className="text-slate-600">{deadline.event_type}: {deadline.due_at}</p>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Drafts and documents</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{lifecycle.drafts?.length || 0} draft section(s)</p>
            <p>{lifecycle.documents?.checklist_and_uploads?.length || 0} application document record(s)</p>
            <p>{lifecycle.documents?.durable_artifacts?.filter((doc) => doc.bytes_retrievable).length || 0} durable artifact(s) with retrievable bytes</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Ground and finalize proposal drafts</CardTitle></CardHeader>
        <CardContent>
          <GroundingWorkspace lifecycle={lifecycle} applicationId={applicationId} onChanged={refreshLifecycle} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Verify the application outcome</CardTitle></CardHeader>
        <CardContent>
          <OutcomeEvidenceForm lifecycle={lifecycle} applicationId={applicationId} onChanged={refreshLifecycle} />
        </CardContent>
      </Card>

      {changes.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Latest amendment changes</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {changes.map((change) => (
              <div key={change.id} className="rounded border p-3 text-sm">
                <Badge variant="outline">{change.change_type}</Badge>
                <span className="ml-2 font-medium">{change.canonical_key}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
