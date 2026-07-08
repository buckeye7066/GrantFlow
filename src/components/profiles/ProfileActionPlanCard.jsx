import React, { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CheckCircle2,
  ClipboardList,
  FileSearch,
  HelpCircle,
  Loader2,
  MessageCircle,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react"

import { getProfileProjectReadinessPlan, prepareProfileProjectReadinessPlan } from "@/api/profiles"
import { parseAllProfileDocuments } from "@/api/documents"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useToast } from "@/components/ui/use-toast"
import { openAnyaPanel } from "@/lib/anyaPanel"
import { buildAnyaPrefill } from "@/components/profiles/anyaInterviewPrefill"

function countKnown(checklist) {
  return checklist.filter((item) => item?.status === "known").length
}

function buildAnyaSessionMetadata(plan, profileId) {
  return {
    source: "profile_action_plan",
    intent: "project_readiness_interview",
    profile_id: profileId,
    plan_id: plan?.plan_id ?? null,
    checklist_count: plan?.checklist?.length ?? 0,
    interview_question_count: plan?.interview_questions?.length ?? 0,
    parsed_document_count: plan?.document_evidence?.length ?? 0,
  }
}

function ActionTooltip({ label, children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export default function ProfileActionPlanCard({ profileId, profileName }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const planQuery = useQuery({
    queryKey: ["profile-project-readiness-plan", profileId],
    queryFn: () => getProfileProjectReadinessPlan(profileId),
    enabled: Boolean(profileId),
    staleTime: 60_000,
  })

  const plan = planQuery.data?.plan ?? null
  const checklist = plan?.checklist ?? []
  const questions = plan?.interview_questions ?? []
  const known = countKnown(checklist)
  const needsAnswers = Math.max(0, checklist.length - known)
  const documentCount = plan?.document_evidence?.length ?? 0

  const firstQuestions = useMemo(() => questions.slice(0, 3), [questions])

  const prepareMutation = useMutation({
    mutationFn: () => prepareProfileProjectReadinessPlan(profileId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile-project-readiness-plan", profileId] })
      toast({
        title: "Hamilton saved the action plan",
        description: data?.document?.name ? `${data.document.name} is now attached to this profile.` : "The checklist packet is attached to this profile.",
      })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Hamilton could not save it",
        description: error?.message || "Try again after refreshing the profile.",
      })
    },
  })

  const parseDocsMutation = useMutation({
    mutationFn: () => parseAllProfileDocuments(profileId, { handwriting: true, enable_ai: true }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile-project-readiness-plan", profileId] })
      toast({
        title: "Document evidence queued",
        description: `${data?.queued_count ?? 0} file${(data?.queued_count ?? 0) === 1 ? "" : "s"} queued for parsing.`,
      })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Could not refresh document evidence",
        description: error?.message || "The profile files were not queued.",
      })
    },
  })

  const openInterview = () => {
    if (!plan) {
      toast({ title: "Still building the plan", description: "Give Anya one moment to read the profile." })
      return
    }
    openAnyaPanel({
      profileId,
      title: `${plan?.title ?? "Project readiness"} interview`,
      metadata: buildAnyaSessionMetadata(plan, profileId),
      prefillMessage: buildAnyaPrefill(plan, profileName),
      // The prefill is Anya's PRIVATE interview script (question queue, known
      // facts). The user must only ever see Anya's greeting and one question at
      // a time — never the script itself.
      prefillHidden: true,
    })
  }

  const isLoading = planQuery.isLoading
  const isBusy = prepareMutation.isPending || parseDocsMutation.isPending

  return (
    <section className="rounded-3xl border border-blue-200 bg-white/90 p-5 shadow-sm md:p-6">
      <TooltipProvider delayDuration={150}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm">
              <ClipboardList className="h-6 w-6" />
            </span>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-slate-900">
                  {plan?.title ?? "Project action plan"}
                </h2>
                <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
                  Anya + Hamilton
                </Badge>
              </div>
              <p className="max-w-3xl text-sm leading-relaxed text-slate-600">
                Good job. Now that you have gotten this far, Anya can ask only the missing questions,
                including official documents to upload when they are needed, then Hamilton can save a
                checklist and how-to packet from the profile and uploaded files.
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {known} known
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-medium text-amber-700">
                  <HelpCircle className="h-3.5 w-3.5" />
                  {needsAnswers} to ask
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-medium text-slate-600">
                  <FileSearch className="h-3.5 w-3.5" />
                  {documentCount} parsed files
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
            <ActionTooltip label="Open Anya's chat panel with this profile-specific interview already loaded.">
              <Button
                type="button"
                className="h-11 justify-center gap-2 bg-blue-600 px-4 text-white hover:bg-blue-700"
                onClick={openInterview}
                disabled={isLoading}
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
                Start Anya interview
              </Button>
            </ActionTooltip>
            <ActionTooltip label="Queue PDFs, Word files, screenshots, official forms, IDs, and notes for profile parsing before the plan is refreshed.">
              <Button
                type="button"
                variant="outline"
                className="h-11 justify-center gap-2 border-slate-300 bg-white"
                onClick={() => parseDocsMutation.mutate()}
                disabled={isBusy}
              >
                {parseDocsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh document evidence
              </Button>
            </ActionTooltip>
            <ActionTooltip label="Save Hamilton's checklist and how-to packet as a profile document.">
              <Button
                type="button"
                variant="outline"
                className="h-11 justify-center gap-2 border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                onClick={() => prepareMutation.mutate()}
                disabled={isBusy || isLoading}
              >
                {prepareMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save for Hamilton
              </Button>
            </ActionTooltip>
          </div>
        </div>

        {firstQuestions.length ? (
          <div className="mt-5 grid gap-2 md:grid-cols-3">
            {firstQuestions.map((question) => (
              <div key={question.id} className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                  Anya will ask
                </div>
                <p className="text-sm leading-snug text-slate-800">{question.prompt}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            Anya has enough to start. Hamilton can save the first checklist now.
          </div>
        )}
      </TooltipProvider>
    </section>
  )
}
