import React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { createPageUrl } from "@/utils"
import { base44 } from "@/api/base44Client"
import {
  getProfile,
  upsertProfileSection,
  requestProfileSectionAI,
  uploadProfileAvatar,
  requestProfileAvatarAI,
} from "@/api/profiles"
import ProfileOverview from "@/components/profiles/ProfileOverview"
import UniversityApplicationsSection from "@/components/profiles/UniversityApplicationsSection.jsx"
import ProfileSectionEditor from "@/components/profiles/ProfileSectionEditor"

export default function OrganizationProfilePage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const profileId = searchParams.get("id")
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [editingSection, setEditingSection] = React.useState(null)
  const [savingSectionKey, setSavingSectionKey] = React.useState(null)
  const [aiSectionKey, setAiSectionKey] = React.useState(null)

  const aiSectionMutation = useMutation({
    mutationFn: ({ sectionKey }) => requestProfileSectionAI(profileId, sectionKey),
  })

  const universityAiMutation = useMutation({
    mutationFn: () => requestProfileSectionAI(profileId, "university_applications"),
  })

  const uploadAvatarMutation = useMutation({
    mutationFn: (file) => uploadProfileAvatar(profileId, file),
    onSuccess: () => {
      toast({
        title: "Profile picture updated",
        description: "Your profile photo has been saved.",
      })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Unable to upload profile photo right now.",
      })
    },
  })

  const requestAvatarAIMutation = useMutation({
    mutationFn: () => requestProfileAvatarAI(profileId),
    onSuccess: (job) => {
      toast({
        title: "AI search queued",
        description: job?.id
          ? `We'll look for a profile photo. Job ${job.id.slice(0, 8)}… is running.`
          : "We'll look for a profile photo shortly.",
      })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to locate photo",
        description: error instanceof Error ? error.message : "Try again shortly.",
      })
    },
  })

  const {
    data: profile,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['profile', profileId],
    queryFn: () => getProfile(profileId),
    enabled: !!profileId,
  })

  const { data: grants = [] } = useQuery({
    queryKey: ['grants'],
    queryFn: () => base44.entities.Grant.list('-created_date'),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })

  const profileOrganizationId = profile?.organization_id ?? null

  const relevantGrants = React.useMemo(() => {
    if (!profileOrganizationId) return []
    return grants.filter((grant) => grant.organization_id === profileOrganizationId)
  }, [grants, profileOrganizationId])

  const universityApplicationsSection = React.useMemo(() => {
    const section = profile?.sections?.find(
      (entry) => entry.section_key === "university_applications",
    )
    if (section?.data && Array.isArray(section.data.applications)) {
      return section.data
    }
    return { applications: [] }
  }, [profile])

  const saveUniversityApplicationsMutation = useMutation({
    mutationFn: async (applicationsPayload) => {
      if (!profile?.id) {
        throw new Error("Profile is not loaded yet.")
      }
      return upsertProfileSection(profile.id, "university_applications", {
        applications: applicationsPayload,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile', profileId] })
      refetch()
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to save university applications",
        description: error instanceof Error ? error.message : "Please try again.",
      })
    },
  })

  const extractTopAmount = React.useCallback((value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
    if (!value) return null
    const matches = String(value)
      .replace(/[$]/g, "")
      .match(/[\d,.]+/g)
    if (!matches || matches.length === 0) {
      return null
    }
    const numericValues = matches
      .map((entry) => Number(entry.replace(/,/g, "")))
      .filter((entry) => Number.isFinite(entry))
    if (!numericValues.length) {
      return null
    }
    return Math.max(...numericValues)
  }, [])

  const totalPipelineValue = React.useMemo(() => {
    return relevantGrants.reduce((sum, grant) => {
      const candidates = [
        grant.amount_awarded,
        grant.amount_requested,
        grant.amount_max,
        grant.amount_ceiling,
        grant.amount_description,
      ]
      for (const candidate of candidates) {
        const parsed = extractTopAmount(candidate)
        if (parsed && parsed > 0) {
          return sum + parsed
        }
      }
      return sum
    }, 0)
  }, [relevantGrants, extractTopAmount])

  if (!profileId) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No profile ID provided. Please select a profile from the Profiles page.
            </AlertDescription>
          </Alert>
          <div className="mt-4">
            <Button onClick={() => navigate(createPageUrl("Organizations"))}>← Back to Profiles</Button>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[420px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !profile) {
    const message = error instanceof Error ? error.message : "Profile could not be loaded."
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-4xl mx-auto space-y-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {message}
              <span className="block text-xs text-slate-500 mt-2">
                The comprehensive profile view is under active construction. Check the Base44 reference if you need the latest details immediately.
              </span>
            </AlertDescription>
          </Alert>
          <Button onClick={() => navigate(createPageUrl("Organizations"))} variant="outline">
            ← Back to Profiles
          </Button>
        </div>
      </div>
    )
  }

  const handleSaveSection = async (values) => {
    if (!editingSection) return
    const payload =
      editingSection.key === "organization_details"
        ? {
            ...values,
            annual_budget: values.annual_budget === "" ? null : Number(values.annual_budget),
            staff_count: values.staff_count === "" ? null : Number(values.staff_count),
          }
        : values
    try {
      setSavingSectionKey(editingSection.key)
      await upsertProfileSection(profile.id, editingSection.key, payload)
      queryClient.invalidateQueries({ queryKey: ['profile', profileId] })
      await refetch()
      setEditingSection(null)
    } catch (err) {
      console.error(err)
    } finally {
      setSavingSectionKey(null)
    }
  }

  const handleAskSection = async (sectionKey) => {
    if (!profile || !sectionKey || aiSectionMutation.isPending) return
    const existingData =
      profile.sections?.find((section) => section.section_key === sectionKey)?.data ?? {}

    setAiSectionKey(sectionKey)
    try {
      const response = await aiSectionMutation.mutateAsync({ sectionKey })
      const suggestion = response?.suggestion && typeof response.suggestion === "object" ? response.suggestion : null
      const mergedData = suggestion ? { ...existingData, ...suggestion } : existingData

      setEditingSection({ key: sectionKey, data: mergedData })

      toast({
        title: suggestion ? "AI suggestion ready" : "No AI updates available",
        description: suggestion
          ? "Review the generated draft and adjust before saving."
          : "Opening the editor with existing data so you can make updates manually.",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI suggestion unavailable right now."
      toast({
        variant: "destructive",
        title: "Unable to generate AI suggestion",
        description: message,
      })
      setEditingSection({ key: sectionKey, data: existingData })
    } finally {
      setAiSectionKey(null)
    }
  }

  const handleUploadAvatar = (file) => {
    if (!file) {
      toast({
        variant: "destructive",
        title: "Select a photo",
        description: "Choose an image file to upload.",
      })
      return
    }
    uploadAvatarMutation.mutate(file)
  }

  const handleRequestAvatarAI = () => {
    requestAvatarAIMutation.mutate()
  }

  const handleSaveUniversityApplications = React.useCallback(
    (applicationsPayload) => {
      return saveUniversityApplicationsMutation.mutateAsync(applicationsPayload)
    },
    [saveUniversityApplicationsMutation],
  )

  const handleUniversityAi = React.useCallback(() => {
    return universityAiMutation.mutateAsync()
  }, [universityAiMutation])

  return (
    <div className="p-6 md:p-10">
      <div className="max-w-5xl mx-auto space-y-10">
        <ProfileOverview
          profile={profile}
          onEditSection={(key, data) => setEditingSection({ key, data })}
          savingSectionKey={savingSectionKey}
          onAskSection={handleAskSection}
          aiLoadingKey={aiSectionMutation.isPending ? aiSectionKey : null}
          onUploadAvatar={handleUploadAvatar}
          onRequestAvatarAI={handleRequestAvatarAI}
          isUploadingAvatar={uploadAvatarMutation.isPending}
          isRequestingAvatar={requestAvatarAIMutation.isPending}
          fundsTotal={totalPipelineValue}
          billing={profile?.billing ?? null}
        />
        <UniversityApplicationsSection
          applications={universityApplicationsSection.applications ?? []}
          onSave={handleSaveUniversityApplications}
          saving={saveUniversityApplicationsMutation.isPending}
          onAskAI={handleUniversityAi}
          aiLoading={universityAiMutation.isPending}
        />
      </div>
      <ProfileSectionEditor
        open={Boolean(editingSection)}
        sectionKey={editingSection?.key}
        initialData={editingSection?.data ?? {}}
        isSaving={Boolean(savingSectionKey)}
        onClose={() => !savingSectionKey && setEditingSection(null)}
        onSave={handleSaveSection}
        onAskAI={
          editingSection
            ? async () => {
                const response = await aiSectionMutation.mutateAsync({ sectionKey: editingSection.key })
                return response?.suggestion ?? null
              }
            : undefined
        }
      />
    </div>
  )
}