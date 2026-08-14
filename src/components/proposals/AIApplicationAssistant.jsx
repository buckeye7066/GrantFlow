import React, { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Loader2, Sparkles, CheckCircle2 } from 'lucide-react'
import { autoPopulate, listSections, prepareApplication, saveSection, validate } from '@/api/applicationsApi'

export default function AIApplicationAssistant({ open, onClose, grant, organization }) {
  const queryClient = useQueryClient()
  const [applicationId, setApplicationId] = useState(null)
  const [activeKey, setActiveKey] = useState(null)
  const [content, setContent] = useState('')

  const { data: app, isLoading: isPreparing } = useQuery({
    queryKey: ['applyApplication', grant?.id, organization?.id],
    enabled: Boolean(open && grant?.id && organization?.id),
    queryFn: () => prepareApplication(grant.id, organization.id ?? grant.organization_id),
  })

  useEffect(() => {
    if (app?.id) setApplicationId(app.id)
  }, [app?.id])

  const { data: sections = [], isLoading: isLoadingSections } = useQuery({
    queryKey: ['applicationSections', applicationId],
    enabled: Boolean(open && applicationId),
    queryFn: () => listSections(applicationId),
  })

  useEffect(() => {
    if (!activeKey && sections.length > 0) setActiveKey(String(sections[0].section_key))
  }, [sections, activeKey])

  const active = useMemo(
    () => (sections || []).find((s) => String(s.section_key) === String(activeKey)),
    [sections, activeKey],
  )

  useEffect(() => {
    setContent(active?.content ?? '')
  }, [active?.section_key, active?.content])

  const autoPopulateMutation = useMutation({
    mutationFn: () => autoPopulate(applicationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applicationSections', applicationId] })
      queryClient.invalidateQueries({ queryKey: ['applicationChecklist', applicationId] })
      queryClient.invalidateQueries({ queryKey: ['application', applicationId] })
    },
  })

  const saveMutation = useMutation({
    mutationFn: () => saveSection(applicationId, String(activeKey), { title: active?.title ?? null, content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applicationSections', applicationId] })
    },
  })

  const validateMutation = useMutation({
    mutationFn: () => validate(applicationId),
  })

  const filled = useMemo(() => (sections || []).filter((s) => String(s.content || '').trim()).length, [sections])
  const progress = sections.length > 0 ? Math.round((filled / sections.length) * 100) : 0

  const busy = isPreparing || isLoadingSections

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl h-[90vh] flex flex-col p-0">
        <DialogHeader className="p-6 border-b flex-shrink-0">
          <DialogTitle className="flex items-center justify-between gap-3 text-2xl">
            <span>AI Application Assistant</span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={!applicationId || autoPopulateMutation.isPending} onClick={() => autoPopulateMutation.mutate()}>
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
              <Button
                className="bg-emerald-600 hover:bg-emerald-700"
                disabled={!applicationId || validateMutation.isPending}
                onClick={() => validateMutation.mutate()}
              >
                {validateMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Validating…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    Validate
                  </>
                )}
              </Button>
            </div>
          </DialogTitle>
          <div className="mt-4">
            <div className="flex justify-between text-sm text-slate-600 mb-2">
              <span>Progress</span>
              <span>{progress}% filled</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden grid grid-cols-3 gap-4 p-6">
          <Card className="col-span-1 flex flex-col overflow-hidden">
            <CardHeader className="pb-3 flex-shrink-0">
              <CardTitle className="text-base">Application Sections</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0">
              <ScrollArea className="h-full">
                <div className="p-4 space-y-2">
                  {(sections || []).map((s) => (
                    <button
                      key={s.id || s.section_key}
                      onClick={() => setActiveKey(String(s.section_key))}
                      className={`w-full text-left p-3 rounded-lg border transition-all ${
                        String(s.section_key) === String(activeKey)
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-slate-200 hover:border-blue-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">{s.title || s.section_key}</span>
                        {String(s.content || '').trim() ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : null}
                      </div>
                      <p className="text-xs text-slate-500 mt-1">{s.section_key}</p>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="col-span-2 flex flex-col overflow-hidden">
            <CardHeader className="pb-3 border-b flex-shrink-0">
              <CardTitle className="flex items-center justify-between">
                <span>{active?.title || active?.section_key || 'Section'}</span>
                <Button disabled={!applicationId || !activeKey || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                  {saveMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    'Save'
                  )}
                </Button>
              </CardTitle>
            </CardHeader>
            <ScrollArea className="flex-1">
              <CardContent className="p-4 space-y-3">
                {busy && !sections?.length ? (
                  <div className="flex items-center justify-center h-48">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                  </div>
                ) : (
                  <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-[420px] font-mono text-sm" />
                )}
              </CardContent>
            </ScrollArea>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  )
}

