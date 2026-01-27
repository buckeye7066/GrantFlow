import React, { useEffect, useMemo, useState } from 'react'
import ReactQuill from 'react-quill'
import 'react-quill/dist/quill.snow.css'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, Plus, Send, CheckCircle, AlertTriangle, Sparkles, Download } from 'lucide-react'
import SubmissionAssistant from './SubmissionAssistant'
import { useDebounce } from '../hooks/useDebounce'
import {
  autoPopulate,
  exportPackage,
  listSections,
  prepareApplication,
  saveSection,
  validate,
} from '@/api/applicationsApi'

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

  const [applicationId, setApplicationId] = useState(null)
  const [activeSectionKey, setActiveSectionKey] = useState(null)
  const [newSectionName, setNewSectionName] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const debouncedDraftContent = useDebounce(draftContent, 1000)
  const [showSubmissionAssistant, setShowSubmissionAssistant] = useState(false)
  const [validationResult, setValidationResult] = useState(null)

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
    if (!activeSectionKey && sections.length > 0) {
      setActiveSectionKey(String(sections[0].section_key))
    }
  }, [sections, activeSectionKey])

  const activeSection = useMemo(
    () => (sections || []).find((s) => String(s.section_key) === String(activeSectionKey)),
    [sections, activeSectionKey],
  )

  useEffect(() => {
    setDraftContent(activeSection?.content ?? '')
  }, [activeSection?.section_key])

  const upsertSectionMutation = useMutation({
    mutationFn: ({ sectionKey, title, content }) => saveSection(applicationId, sectionKey, { title, content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applicationSections', applicationId] })
    },
  })

  useEffect(() => {
    if (!applicationId) return
    if (!activeSection) return
    if (debouncedDraftContent === (activeSection?.content ?? '')) return
    upsertSectionMutation.mutate({
      sectionKey: String(activeSection.section_key),
      title: activeSection.title ?? null,
      content: debouncedDraftContent,
    })
  }, [debouncedDraftContent, applicationId, activeSection])

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
        window.location.assign(url)
      }
    },
  })

  const handleAddSection = (e) => {
    e.preventDefault()
    if (!applicationId) return
    const name = String(newSectionName || '').trim()
    if (!name) return
    const key = nextSectionKey(name, sectionKeySet)
    upsertSectionMutation.mutate({ sectionKey: key, title: name, content: '' })
    setNewSectionName('')
    setActiveSectionKey(key)
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
                {validationResult.ready
                  ? 'All checklist items are complete and sections are filled.'
                  : 'Some checklist items are incomplete or sections are empty. See the Submission Assistant for details.'}
              </AlertDescription>
            </Alert>
          ) : null}

          {activeSection ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold text-slate-900">{activeSection.title || activeSection.section_key}</h2>
              </div>
              <ReactQuill theme="snow" value={draftContent} onChange={setDraftContent} className="h-96 mb-12" />
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
