/**
 * TailoredApplicationPanel — the funder-SPECIFIC application narrative Hamilton
 * wrote for one opportunity, reviewed inline on the pipeline/portal card.
 *
 * Owner intent: each opportunity gets its own tailored narrative. The owner
 * reviews it per card:
 *   - APPROVE the draft as-is (checkbox/button), or
 *   - EDIT the text (editing == approved-as-edited → status 'edited').
 * If the funder asks for information not in the profile, a blocking QUESTION is
 * shown and approval is disabled until it's answered (each question deep-links
 * to the exact profile section to fill). Approval means the draft is ready for
 * the owner's visible portal handoff; this panel never implies that a real
 * final Submit is executed automatically.
 *
 * Graceful pre-backend behavior: the endpoint is shipped by a sibling backend
 * agent. If the GET 404s (not deployed yet) the panel hides itself entirely so
 * the card never breaks. Lazy by default (fetches only when expanded) so the
 * pipeline Kanban — which renders hundreds of cards — doesn't fan out a request
 * per card on mount.
 */

import React, { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Sparkles, Loader2, CheckCircle2, FileEdit, RefreshCw, ChevronDown, ChevronRight,
  AlertTriangle, ArrowRight, ShieldCheck, Clock,
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showErrorToast, showSuccessToast } from '@/components/shared/toastHelpers'
import { SECTION_METADATA } from '@/config/sectionMetadata'
import { SECTION_TAB_MAP, EDITABLE_SECTIONS } from '@/config/missingInfoTargets'
import { createPageUrl } from '@/utils'
import * as hamiltonApi from '@/api/hamilton'

// essay_key → human label, from the canonical essays section metadata.
const ESSAY_LABELS = Object.fromEntries(
  (SECTION_METADATA.essays?.fields ?? []).map((f) => [f.name, f.label]),
)
function fieldLabel(key) {
  return ESSAY_LABELS[key] || String(key || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Build a ProfileDetail deep-link for a missing-info question that names a
// profile section (and optionally a field). Returns null when the question has
// no profile home (e.g. a funder-specific item that lives nowhere on the
// profile) so the caller renders it as a static row instead.
function questionDeepLink(profileId, question) {
  if (!profileId) return null
  const section = question?.section_key || null
  const field = question?.field || null
  if (!section) return null
  const tab = SECTION_TAB_MAP[section] || 'profile'
  const editable = EDITABLE_SECTIONS.has(section)
  return createPageUrl('ProfileDetail', {
    id: profileId,
    tab,
    section: editable ? section : undefined,
    field: editable ? field || undefined : undefined,
  })
}

function StatusBadge({ status }) {
  const label = hamiltonApi.tailoredStatusLabel(status)
  const cls =
    status === 'approved'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
      : status === 'edited'
        ? 'bg-blue-100 text-blue-800 border-blue-300'
        : 'bg-amber-100 text-amber-800 border-amber-300'
  return (
    <Badge variant="outline" className={`text-xs ${cls}`}>
      {label}
    </Badge>
  )
}

export default function TailoredApplicationPanel({ profileId, grantId, grantTitle = '', autoLoad = false }) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const [open, setOpen] = useState(Boolean(autoLoad))
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState({})
  const [busy, setBusy] = useState(false)

  const queryKey = ['tailored-application', profileId, grantId]
  const { data, isLoading, isError, error } = useQuery({
    queryKey,
    queryFn: () => hamiltonApi.getTailoredApplication(profileId, grantId),
    enabled: Boolean(open && profileId && grantId),
    retry: false,
    staleTime: 60_000,
  })

  // Seed edit drafts from the saved fields whenever they change.
  useEffect(() => {
    const f = data?.fields && typeof data.fields === 'object' ? data.fields : {}
    setDrafts({ ...f })
  }, [data])

  // Graceful pre-backend fallback: the endpoint isn't deployed yet (404) — hide
  // the whole panel so the card never breaks. Any other hard error also hides
  // (there's nothing to review), matching "never break the card".
  if (open && isError) {
    return null
  }

  const status = data?.status || 'pending'
  const fields = data?.fields && typeof data.fields === 'object' ? data.fields : {}
  const fieldKeys = Object.keys(fields)
  const missingQuestions = Array.isArray(data?.missing_questions) ? data.missing_questions : []
  const funderRequirements = Array.isArray(data?.funder_requirements) ? data.funder_requirements : []
  const hasBlockingQuestions = missingQuestions.length > 0
  const isApproved = status === 'approved' || status === 'edited'

  const refresh = () => qc.invalidateQueries({ queryKey })

  async function handleApprove() {
    if (hasBlockingQuestions) return
    setBusy(true)
    try {
      await hamiltonApi.approveTailoredApplication(profileId, grantId)
      await refresh()
      showSuccessToast(toast, 'Draft approved', 'Final portal review and Submit remain your visible handoff.')
    } catch (err) {
      showErrorToast(toast, 'Could not approve', err?.message || 'Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveEdit() {
    setBusy(true)
    try {
      await hamiltonApi.editTailoredApplication(profileId, grantId, drafts)
      await refresh()
      setEditing(false)
      showSuccessToast(toast, 'Edits saved', 'Your edited version is approved.')
    } catch (err) {
      showErrorToast(toast, 'Could not save edits', err?.message || 'Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRegenerate() {
    setBusy(true)
    try {
      await hamiltonApi.regenerateTailoredApplication(profileId, grantId)
      await refresh()
      setEditing(false)
      showSuccessToast(toast, 'Re-drafting', 'Hamilton is rewriting this application.')
    } catch (err) {
      showErrorToast(toast, 'Could not regenerate', err?.message || 'Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function submissionHandoffState() {
    if (hasBlockingQuestions) {
      return {
        icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />,
        cls: 'text-amber-700',
        text: 'Answer the funder’s questions above before the draft is ready for your portal handoff.',
      }
    }
    if (isApproved) {
      return {
        icon: <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />,
        cls: 'text-emerald-700',
        text: 'Approved draft — review it in the portal, complete required human steps, and submit it yourself.',
      }
    }
    return {
      icon: <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" />,
      cls: 'text-slate-600',
      text: 'Draft ready for review. Final portal Submit remains a human handoff.',
    }
  }

  // ── Collapsed (lazy) header — no fetch until the owner opens it ────────────
  if (!open) {
    return (
      <div className="mt-2 pt-2 border-t border-slate-100" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-xs font-medium text-purple-700 hover:text-purple-900"
        >
          <ChevronRight className="w-3.5 h-3.5" />
          <Sparkles className="w-3.5 h-3.5" />
          Tailored application
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid="tailored-application-panel"
      className="mt-2 pt-2 border-t border-slate-100 space-y-3"
      onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex items-center gap-1.5 text-xs font-semibold text-purple-800 hover:text-purple-900"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          <Sparkles className="w-3.5 h-3.5" />
          Tailored application
        </button>
        {!isLoading && data ? <StatusBadge status={status} /> : null}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading Hamilton’s draft…
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-500">
            The application Hamilton tailored for this funder{grantTitle ? ` (${grantTitle})` : ''}. Review it, then approve
            or edit — editing counts as your approval.
          </p>

          {/* Funder requirements this narrative was written against (context). */}
          {funderRequirements.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
              <p className="text-[11px] font-semibold text-slate-600 mb-1">This funder asks for:</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {funderRequirements.map((req, idx) => (
                  <li key={idx} className="text-[11px] text-slate-600">
                    {typeof req === 'string' ? req : req?.requirement || req?.label || JSON.stringify(req)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* MISSING-INFO questions — block approval until answered, each
              deep-linking to the exact profile section when known. */}
          {hasBlockingQuestions && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 space-y-2">
              <div className="flex items-center gap-1.5 text-amber-800">
                <AlertTriangle className="w-3.5 h-3.5" />
                <p className="text-xs font-semibold">This funder needs a bit more from you</p>
              </div>
              <ul className="space-y-1.5">
                {missingQuestions.map((q, idx) => {
                  const href = questionDeepLink(profileId, q)
                  const text = q?.question || q?.requirement || 'Additional information required'
                  return (
                    <li key={idx} className="text-xs text-amber-900">
                      <span className="block">{text}</span>
                      {href ? (
                        <Link
                          to={href}
                          className="inline-flex items-center gap-1 mt-0.5 text-[11px] font-medium text-blue-700 hover:text-blue-800"
                        >
                          Add it to your profile
                          <ArrowRight className="w-3 h-3" />
                        </Link>
                      ) : (
                        <span className="text-[11px] text-amber-700">Add this to your profile before submitting.</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* The tailored narrative — read-only when approved, editable in edit mode. */}
          <div className="space-y-2">
            {fieldKeys.length === 0 ? (
              <p className="text-xs italic text-slate-400">Hamilton hasn’t drafted this application yet.</p>
            ) : (
              fieldKeys.map((key) => (
                <div key={key} className="space-y-1">
                  <Label className="text-[11px] text-slate-600" htmlFor={`tailored-${grantId}-${key}`}>
                    {fieldLabel(key)}
                  </Label>
                  {editing ? (
                    <Textarea
                      id={`tailored-${grantId}-${key}`}
                      rows={4}
                      disabled={busy}
                      value={drafts[key] ?? ''}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                    />
                  ) : (
                    <p className="text-xs text-slate-700 whitespace-pre-wrap rounded-md border border-slate-100 bg-white p-2">
                      {fields[key] || <span className="italic text-slate-400">Empty</span>}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Approve / Edit / Regenerate controls. */}
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <Button type="button" size="sm" className="text-xs h-7" disabled={busy} onClick={handleSaveEdit}>
                  {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                  Save & approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-xs h-7"
                  disabled={busy}
                  onClick={() => { setEditing(false); setDrafts({ ...fields }) }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="text-xs h-7"
                  disabled={busy || hasBlockingQuestions || isApproved}
                  title={
                    hasBlockingQuestions
                      ? 'Answer the funder’s questions above before approving'
                      : isApproved
                        ? 'Already approved'
                        : 'Approve this application as written'
                  }
                  onClick={handleApprove}
                >
                  {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                  {isApproved ? 'Approved' : 'Approve'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-xs h-7"
                  disabled={busy || fieldKeys.length === 0}
                  onClick={() => { setDrafts({ ...fields }); setEditing(true) }}
                >
                  <FileEdit className="w-3 h-3 mr-1" />
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-xs h-7 text-slate-500"
                  disabled={busy}
                  onClick={handleRegenerate}
                >
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Regenerate
                </Button>
              </>
            )}
          </div>

          {/* Real-portal final submission remains a visible human handoff. */}
          {(() => {
            const s = submissionHandoffState()
            return (
              <div className={`flex items-center gap-1.5 text-xs ${s.cls}`}>
                {s.icon}
                <span>{s.text}</span>
              </div>
            )
          })()}
        </>
      )}
    </div>
  )
}
