import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, Plus, Send, CheckCircle, AlertTriangle, Sparkles, Download } from 'lucide-react'
import SubmissionAssistant from './SubmissionAssistant'
import { useDebounce } from '../hooks/useDebounce'
import { useToast } from '@/components/ui/use-toast'
import {
  autoPopulate,
  exportPackage,
  listSections,
  prepareApplication,
  saveSection,
  validate,
} from '@/api/applicationsApi'
import { downloadAuthenticatedUrl } from '@/utils/authenticatedDownload'

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

function nextSectionKey(name, existingKeys) {
  const base = slugify(name) || 'section'
  let candidate = base
  let i = 2
  while (existingKeys.has(candidate)) {
    candidate = `${base}_${i}`
    i += 1
  }
  return candidate
}

export default function ProposalEditor({ grant, organization }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [applicationId, setApplicationId] = useState(null)
  const [activeSectionKey, setActiveSectionKey] = useState(null)
  const [newSectionName, setNewSectionName] = useState('')
  const [draftContent, setDraftContent] = useState('')
  // Track the section key that corresponds to the current draftContent so the
  // debounced auto-save always writes to the correct section even after a rapid switch.
  const draftTargetSectionKeyRef = useRef(null)
  const debouncedDraftContent = useDebounce(draftContent, 1000)
  const [showSubmissionAssistant, setShowSubmissionAssistant] = useState(false)
  const [validationResult, setValidationResult] = useState(null)
  // Track the section key+content at debounce-initiation time to prevent
  // stale saves writing old content to the wrong section on rapid switching.
  const pendingSaveRef = useRef(null)

  const { data: application, isLoading: isPreparing } = useQuery({
    queryKey: ['applyApplication', grant?.id, organization?.id],
    enabled: Boolean(grant?.id && organization?.id),
    queryFn: () => prepareApplication(grant.id, organization.id ?? grant.organization_id),
  })

  useEffect(() => {
    if (application?.id) setApplicationId(application.id)
  }, [application?.id])

  const { data: sections = [], isLoading: isLoadingSections } = useQuery({
    queryKey: ['applicationSections', applicationId],
    enabled: Boolean(applicationId),
    queryFn: () => listSections(applicationId),
  })

  const sectionKeySet = useMemo(() => new Set((sections || []).map((s) => String(s.section_key))), [sections])

  useEffect(() => {
    const handler = (event) => {
      const sectionKey = event?.detail?.sectionKey
      if (!sectionKey) return
      setActiveSectionKey(String(sectionKey))
    }
    window.addEventListener('applyEngine:focusSection', handler)
    return () => window.removeEventListener('applyEngine:focusSection', handler)
  }, [])

  useEffect(() => {
    if (!activeSectionKey && sections.length > 0) {
      setActiveSectionKey(String(sections[0].section_key))
    }
  }, [sections, activeSectionKey])

  const activeSection = useMemo(
    () => (sections || []).find((s) => String(s.section_key) === String(activeSectionKey)),
    [sections, activeSectionKey],
  )

  useEffect(() => {
    // Capture the section key synchronously so the debounced save knows which
    // section the content belongs to (prevents stale-closure write to wrong section).
    draftTargetSectionKeyRef.current = activeSection?.section_key ?? null
    setDraftContent(activeSection?.content ?? '')
  }, [activeSection?.section_key, activeSection?.content])

  const upsertSectionMutation = useMutation({
    mutationFn: ({ sectionKey, title, content }) => {
      // Guard: if the application hasn't loaded yet, fail loudly instead of
      // POSTing a null id (which 404s and silently dropped the user's edit).
      if (!applicationId) throw new Error('Application is still loading — please wait a moment and try again.')
      return saveSection(applicationId, sectionKey, { title, content })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applicationSections', applicationId] })
    },
    onError: (error) => {
      toast({ variant: 'destructive', title: 'Save failed', description: error?.message || 'Your changes could not be saved.' })
    },
  })

  // Capture the pending save info when content changes (at debounce-initiation time).
  useEffect(() => {
    if (!applicationId || !activeSection) return
    pendingSaveRef.current = {
      sectionKey: String(activeSection.section_key),
      title: activeSection.title ?? null,
      content: draftContent,
    }
  }, [draftContent, applicationId, activeSection?.section_key, activeSection?.title])

  // Cancel any pending debounced save when the active section changes.
  useEffect(() => {
    pendingSaveRef.current = null
  }, [activeSectionKey])

  useEffect(() => {
    if (!applicationId) return
    if (!activeSection) return
    // Guard: skip if the debounced content was typed for a different section
    // (rapid section-switch can cause the debounce to fire after the active section changed).
    const savedFor = draftTargetSectionKeyRef.current
    if (String(savedFor ?? '') !== String(activeSection.section_key)) return
    if (debouncedDraftContent === (activeSection?.content ?? '')) return
    // Use the section key+content that was captured when the debounce started,
    // not the current activeSection (which may have changed during the delay).
    const pending = pendingSaveRef.current
    if (!pending) return
    if (pending.sectionKey !== String(activeSection.section_key)) return
    // Guard: only save if the debounced content matches the captured content.
    // A mismatch means the section switched mid-debounce — skip to avoid stale writes.
    if (pending.content !== debouncedDraftContent) return
    upsertSectionMutation.mutate({
      sectionKey: pending.sectionKey,
      title: pending.title,
      content: pending.content,
    })
  }, [debouncedDraftContent, applicationId, activeSection?.section_key, activeSection?.content, activeSection?.title])

  const autoPopulateMutation = useMutation({
    mutationFn: () => autoPopulate(applicationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applicationSections', applicationId] })
    },
  })

  const validateMutation = useMutation({
    mutationFn: () => validate(applicationId),
    onSuccess: (result) => {
      setValidationResult(result)
    },
  })

  const exportMutation = useMutation({
    mutationFn: (format) => exportPackage(applicationId, format),
    onSuccess: (result) => {
      const url = result?.artifact?.download_url
      if (url) {
        downloadAuthenticatedUrl(url, { fallbackFileName: `application_${applicationId || 'export'}.docx` }).catch((err) => {
          console.error('[ProposalEditor] export download failed', err)
          toast({ variant: 'destructive', title: 'Export failed', description: 'The export file could not be downloaded. Please try again.' })
        })
      } else {
        toast({ variant: 'destructive', title: 'Export unavailable', description: 'The server did not return a download URL. Please try again.' })
      }
    },
    onError: (err) => {
      console.error('[ProposalEditor] export failed', err)
      toast({ variant: 'destructive', title: 'Export failed', description: err?.message || 'An unexpected error occurred during export.' })
    },
  })

  const handleAddSection = (e) => {
    e.preventDefault()
    if (!applicationId) return
    const name = String(newSectionName || '').trim()
    if (!name) return
    const key = nextSectionKey(name, sectionKeySet)
    upsertSectionMutation.mutate(
      { sectionKey: key, title: name, content: '' },
      {
        onSuccess: () => {
          setNewSectionName('')
          setActiveSectionKey(key)
        },
      },
    )
  }

  const isBusy = isPreparing || isLoadingSections

  if (isBusy) {
    return (
      <div className="flex justify-center items-center p-8">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col md:flex-row gap-6 bg-slate-50 p-4 rounded-lg border">
        <aside className="w-full md:w-1/4 lg:w-1/5">
          <div className="sticky top-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Sections</h3>
              <Button
                size="sm"
                variant="outline"
                disabled={!applicationId || autoPopulateMutation.isPending}
                onClick={() => autoPopulateMutation.mutate()}
              >
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

            <ul className="space-y-1">
              {(sections || []).map((section) => (
                <li key={section.id || section.section_key}>
                  <button
                    onClick={() => setActiveSectionKey(String(section.section_key))}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      String(activeSectionKey) === String(section.section_key)
                        ? 'bg-blue-600 text-white font-semibold'
                        : 'hover:bg-slate-200'
                    }`}
                  >
                    {section.title || section.section_key}
                  </button>
                </li>
              ))}
            </ul>

            <form onSubmit={handleAddSection} className="flex gap-2">
              <Input value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)} placeholder="New section…" />
              <Button type="submit" size="icon" disabled={!newSectionName.trim() || upsertSectionMutation.isPending}>
                {upsertSectionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              </Button>
            </form>

            <div className="space-y-2">
              <Button
                onClick={() => validateMutation.mutate()}
                disabled={!applicationId || validateMutation.isPending}
                className="w-full bg-emerald-600 hover:bg-emerald-700"
              >
                {validateMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Validating…
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Validate
                  </>
                )}
              </Button>

              <Button
                onClick={() => exportMutation.mutate('docx')}
                disabled={!applicationId || exportMutation.isPending}
                variant="outline"
                className="w-full"
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
                onClick={() => setShowSubmissionAssistant(true)}
                disabled={!applicationId}
                className="w-full bg-blue-600 hover:bg-blue-700"
              >
                <Send className="w-4 h-4 mr-2" />
                Submit / Mark Submitted
              </Button>
            </div>
          </div>
        </aside>

        <main className="flex-1 bg-white p-6 rounded-lg shadow-md">
          {validationResult?.ok ? (
            <Alert className={validationResult.ready ? 'mb-4 bg-emerald-50 border-emerald-200' : 'mb-4 bg-amber-50 border-amber-200'}>
              <AlertTitle className="flex items-center gap-2">
                {validationResult.ready ? (
                  <CheckCircle className="w-5 h-5 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-600" />
                )}
                Validation {validationResult.ready ? 'Ready' : 'Needs work'}
              </AlertTitle>
              <AlertDescription className="text-sm mt-2">
                {validationResult.ready ? (
                  'All checklist items are complete and sections are filled.'
                ) : (
                  <div className="space-y-3">
                    <p>Fix the items below, then click Validate again.</p>

                    {validationResult?.missing?.no_sections ? (
                      <div>
                        <p className="font-medium">No sections created</p>
                        <p className="text-xs text-amber-800">
                          Use <span className="font-semibold">Auto-populate</span> or add a section to begin drafting.
                        </p>
                      </div>
                    ) : null}

                    {Array.isArray(validationResult?.missing?.empty_sections) && validationResult.missing.empty_sections.length > 0 ? (
                      <div>
                        <p className="font-medium">Empty sections</p>
                        <ul className="mt-1 space-y-1 list-disc ml-5">
                          {validationResult.missing.empty_sections.map((s) => (
                            <li key={s.section_key}>
                              <button
                                type="button"
                                className="underline underline-offset-2 hover:no-underline"
                                onClick={() => setActiveSectionKey(String(s.section_key))}
                              >
                                {s.title || s.section_key}
                              </button>
                              <span className="text-xs text-amber-800"> — add at least a few sentences</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {Array.isArray(validationResult?.missing?.checklist) && validationResult.missing.checklist.length > 0 ? (
                      <div>
                        <p className="font-medium">Incomplete checklist items</p>
                        <ul className="mt-1 space-y-1 list-disc ml-5">
                          {validationResult.missing.checklist.map((i) => (
                            <li key={i.key}>
                              <span className="font-medium">{i.label || i.key}</span>
                              <span className="text-xs text-amber-800"> — status: {i.status || 'pending'}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-xs text-amber-800 mt-1">Use “Submit / Mark Submitted” to review checklist + exports.</p>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button size="sm" variant="outline" onClick={() => setShowSubmissionAssistant(true)} disabled={!applicationId}>
                        View details
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => autoPopulateMutation.mutate()}
                        disabled={!applicationId || autoPopulateMutation.isPending}
                      >
                        Auto-populate
                      </Button>
                    </div>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          {activeSection ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold text-slate-900">{activeSection.title || activeSection.section_key}</h2>
              </div>
              <Textarea
                value={draftContent}
                onChange={(e) => {
                  // Capture which section this content belongs to at the time of typing.
                  draftTargetSectionKeyRef.current = activeSection?.section_key ?? null
                  setDraftContent(e.target.value)
                }}
                rows={18}
                className="font-mono text-sm"
                placeholder="Draft your section here…"
              />
            </>
          ) : (
            <div className="text-center py-12 text-slate-500">
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No sections yet</h3>
              <p>Use “Auto-populate” or add a section to start drafting.</p>
            </div>
          )}
        </main>
      </div>

      {showSubmissionAssistant && (
        <SubmissionAssistant
          open={showSubmissionAssistant}
          onClose={() => setShowSubmissionAssistant(false)}
          grant={grant}
          organization={organization}
          applicationId={applicationId}
        />
      )}
    </>
  )
}
