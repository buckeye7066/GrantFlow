import React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, Loader2 } from "lucide-react"
import {
  getProfile,
  requestProfileSectionAI,
  upsertProfileSection,
  uploadProfileAvatar,
  requestProfileAvatarAI,
} from "@/api/profiles"
import ProfileOverview from "@/components/profiles/ProfileOverview"
import ProfileSectionEditor from "@/components/profiles/ProfileSectionEditor"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { createPageUrl } from "@/utils"

export default function ProfileDetail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const profileId = searchParams.get("id")
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const {
    data: profile,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["profile", profileId],
    queryFn: () => getProfile(profileId),
    enabled: Boolean(profileId),
  })

  const [editingSection, setEditingSection] = React.useState(null)
  const [savingSectionKey, setSavingSectionKey] = React.useState(null)
  const [aiLoadingKey, setAiLoadingKey] = React.useState(null)

  const upsertSectionMutation = useMutation({
    mutationFn: ({ sectionKey, values }) => upsertProfileSection(profileId, sectionKey, values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      toast({
        title: "Section saved",
        description: "Your updates are synced with the comprehensive application schema.",
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to save this section right now."
      toast({
        title: "Save failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  const aiSuggestionMutation = useMutation({
    mutationFn: (sectionKey) => requestProfileSectionAI(profileId, sectionKey),
  })

  const uploadAvatarMutation = useMutation({
    mutationFn: ({ file }) => uploadProfileAvatar(profileId, file),
    onSuccess: () => {
      toast({
        title: "Profile photo updated",
        description: "The avatar has been uploaded successfully.",
      })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "We couldn't upload that photo."
      toast({
        title: "Upload failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  const requestAvatarAIMutation = useMutation({
    mutationFn: () => requestProfileAvatarAI(profileId),
    onSuccess: () => {
      toast({
        title: "AI search queued",
        description: "We'll add a suggested avatar to this profile if one is located.",
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to start the AI avatar search."
      toast({
        title: "Request failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  const handleOpenSection = React.useCallback((sectionKey, data = {}) => {
    setEditingSection({
      key: sectionKey,
      data: data ?? {},
    })
  }, [])

  const handleCloseEditor = React.useCallback(() => {
    if (savingSectionKey) return
    setEditingSection(null)
  }, [savingSectionKey])

  const handleSaveSection = React.useCallback(
    async (values) => {
      if (!editingSection) return
      const { key } = editingSection
      try {
        setSavingSectionKey(key)
        await upsertSectionMutation.mutateAsync({ sectionKey: key, values })
        setEditingSection(null)
      } catch (err) {
        // Error toast handled in mutation onError
      } finally {
        setSavingSectionKey(null)
      }
    },
    [editingSection, upsertSectionMutation],
  )

  const handleAskSection = React.useCallback(
    async (sectionKey) => {
      if (!profile) return
      setAiLoadingKey(sectionKey)
      try {
        const existing =
          profile.sections?.find((section) => section.section_key === sectionKey)?.data ?? {}
        const response = await aiSuggestionMutation.mutateAsync(sectionKey)
        const suggestion =
          response?.suggestion && typeof response.suggestion === "object" ? response.suggestion : {}

        if (!suggestion || Object.keys(suggestion).length === 0) {
          toast({
            title: "No updates suggested",
            description: "The AI assistant did not find new details for this section.",
          })
          return
        }

        setEditingSection({
          key: sectionKey,
          data: { ...existing, ...suggestion },
        })
        toast({
          title: "AI suggestion ready",
          description: "Review the proposed updates and save any changes you approve.",
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to fetch AI suggestion."
        toast({
          title: "AI request failed",
          description: message,
          variant: "destructive",
        })
      } finally {
        setAiLoadingKey(null)
      }
    },
    [profile, aiSuggestionMutation, toast],
  )

  const handleAskFromEditor = React.useCallback(async () => {
    if (!editingSection) return null
    try {
      const response = await aiSuggestionMutation.mutateAsync(editingSection.key)
      return response?.suggestion ?? null
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not fetch an AI suggestion."
      throw new Error(message)
    }
  }, [editingSection, aiSuggestionMutation])

  const handleUploadAvatar = React.useCallback(
    (file) => {
      if (!file) return
      uploadAvatarMutation.mutate({ file })
    },
    [uploadAvatarMutation],
  )

  const handleRequestAvatarAI = React.useCallback(() => {
    requestAvatarAIMutation.mutate()
  }, [requestAvatarAIMutation])

  if (!profileId) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-4xl mx-auto space-y-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No profile selected. Choose a profile from the Profiles page to view its details.
            </AlertDescription>
          </Alert>
          <Button onClick={() => navigate(createPageUrl("MyProfiles"))}>← Back to Profiles</Button>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (isError || !profile) {
    const message = error instanceof Error ? error.message : "The profile could not be loaded right now."
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-4xl mx-auto space-y-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => navigate(-1)}>
              ← Go Back
            </Button>
            <Button onClick={() => navigate(createPageUrl("MyProfiles"))}>View all profiles</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 md:p-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Profile</p>
            <h1 className="text-3xl font-bold text-slate-900">{profile.display_name}</h1>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => navigate(createPageUrl("MyProfiles"))}>
              ← Back to Profiles
            </Button>
            {profile.organization_id && (
              <Button onClick={() => navigate(createPageUrl("OrganizationProfile", { id: profile.organization_id }))}>
                View Linked Organization
              </Button>
            )}
          </div>
        </div>

        <ProfileOverview
          profile={profile}
          billing={profile.billing ?? null}
          onEditSection={handleOpenSection}
          onAskSection={handleAskSection}
          savingSectionKey={savingSectionKey}
          aiLoadingKey={aiLoadingKey}
          onUploadAvatar={handleUploadAvatar}
          onRequestAvatarAI={handleRequestAvatarAI}
          isUploadingAvatar={uploadAvatarMutation.isPending}
          isRequestingAvatar={requestAvatarAIMutation.isPending}
          fundsTotal={profile.pipeline_funds_total ?? 0}
        />
      </div>

      <ProfileSectionEditor
        open={Boolean(editingSection)}
        sectionKey={editingSection?.key}
        initialData={editingSection?.data ?? {}}
        onClose={handleCloseEditor}
        onSave={handleSaveSection}
        isSaving={Boolean(savingSectionKey)}
        onAskAI={handleAskFromEditor}
      />
    </div>
  )
}
