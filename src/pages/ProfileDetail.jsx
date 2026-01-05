import React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, Loader2, Palette } from "lucide-react"
import {
  getProfile,
  requestProfileSectionAI,
  upsertProfileSection,
  uploadProfileAvatar,
  requestProfileAvatarAI,
} from "@/api/profiles"
import { ingestDocument } from "@/api/documents"
import ProfileOverview from "@/components/profiles/ProfileOverview"
import ProfileSectionEditor from "@/components/profiles/ProfileSectionEditor"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { createPageUrl } from "@/utils"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx"

export default function ProfileDetail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const profileId = searchParams.get("id")
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { state: dashboardPrefs, dispatch: preferencesDispatch } = useDashboardPreferences()
  const [appearanceOpen, setAppearanceOpen] = React.useState(false)
  const themeOptions = React.useMemo(
    () => [
      { value: "blue", label: "Blue Horizon", gradient: "bg-gradient-to-br from-blue-500 to-blue-600" },
      { value: "emerald", label: "Emerald Grove", gradient: "bg-gradient-to-br from-emerald-500 to-emerald-600" },
      { value: "violet", label: "Violet Focus", gradient: "bg-gradient-to-br from-violet-500 to-violet-600" },
      { value: "amber", label: "Amber Dawn", gradient: "bg-gradient-to-br from-amber-500 to-amber-600" },
    ],
    [],
  )
  const layoutOptions = React.useMemo(
    () => [
      { value: "expanded", label: "Expanded · 2 columns" },
      { value: "compact", label: "Compact · 3 columns" },
    ],
    [],
  )

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

  const uploadDocumentMutation = useMutation({
    mutationFn: ({ file }) => {
      const formData = new FormData()
      formData.append("profile_id", profileId)
      formData.append("document", file)
      formData.append("name", file.name)
      return ingestDocument(formData)
    },
    onSuccess: () => {
      toast({
        title: "Document uploaded",
        description: "We'll parse the contents and sync matches shortly.",
      })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to upload this document."
      toast({
        title: "Upload failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  const handleThemeChange = React.useCallback(
    (theme) => {
      preferencesDispatch({ type: "SET_COLOR_THEME", theme })
    },
    [preferencesDispatch],
  )

  const handleLayoutChange = React.useCallback(
    (layout) => {
      preferencesDispatch({ type: "SET_LAYOUT", layout })
      preferencesDispatch({
        type: "SET_LAYOUT_COLUMNS",
        columns: layout === "compact" ? 3 : 2,
      })
    },
    [preferencesDispatch],
  )

  const handleUploadDocument = React.useCallback(
    (file) => {
      if (!file) return
      uploadDocumentMutation.mutate({ file })
    },
    [uploadDocumentMutation],
  )

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
            <Button variant="outline" onClick={() => setAppearanceOpen(true)}>
              <Palette className="w-4 h-4 mr-2" />
              Appearance
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
          onUploadDocument={handleUploadDocument}
          isUploadingDocument={uploadDocumentMutation.isPending}
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

      <Dialog open={appearanceOpen} onOpenChange={setAppearanceOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Customize profile view</DialogTitle>
            <DialogDescription>
              Adjust the accent colors and section layout used across your GrantFlow workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Color theme</Label>
              <RadioGroup
                value={dashboardPrefs.colorTheme}
                onValueChange={handleThemeChange}
                className="grid gap-3 sm:grid-cols-2"
              >
                {themeOptions.map((option) => (
                  <Label
                    key={option.value}
                    htmlFor={`theme-${option.value}`}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm transition ${
                      dashboardPrefs.colorTheme === option.value
                        ? "border-blue-500 ring-2 ring-blue-200"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <RadioGroupItem value={option.value} id={`theme-${option.value}`} />
                    <div className="flex items-center gap-3">
                      <span className={`h-8 w-8 rounded-full ${option.gradient}`} />
                      <span className="text-sm font-medium text-slate-700">{option.label}</span>
                    </div>
                  </Label>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Section layout
              </Label>
              <RadioGroup
                value={dashboardPrefs.layoutStyle}
                onValueChange={handleLayoutChange}
                className="grid gap-2"
              >
                {layoutOptions.map((option) => (
                  <Label
                    key={option.value}
                    htmlFor={`layout-${option.value}`}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm transition ${
                      dashboardPrefs.layoutStyle === option.value
                        ? "border-blue-500 ring-2 ring-blue-200"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <RadioGroupItem value={option.value} id={`layout-${option.value}`} />
                    <span className="text-sm font-medium text-slate-700">{option.label}</span>
                  </Label>
                ))}
              </RadioGroup>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
