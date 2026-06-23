import React, { useRef, useEffect } from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { syncTargetCollegesToApplications } from "@/utils/targetCollegesSync"
import { AlertCircle, Loader2, Palette, Printer } from "lucide-react"
import {
  getProfile,
  requestProfileSectionAI,
  upsertProfileSection,
  uploadProfileAvatar,
  requestProfileAvatarFromWebsite,
  updateProfile,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx"
import { useSettingsStore } from "@/stores/settingsStore"
import { useAuthStore } from "@/stores/authStore"
import ProfileFilesPanel from "@/components/profiles/ProfileFilesPanel.jsx"
import ProfileAppliedFundingPrint from "@/components/profiles/ProfileAppliedFundingPrint.jsx"
import ProfileInfoPrint from "@/components/profiles/ProfileInfoPrint.jsx"
import PrintableProfileTodo from "@/components/profiles/PrintableProfileTodo.jsx"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import UniversityApplicationsSection from "@/components/profiles/UniversityApplicationsSection.jsx"
import StudentPortalsCard from "@/components/profiles/StudentPortalsCard.jsx"
import SavedLoginsCard from "@/components/profiles/SavedLoginsCard.jsx"
import PortalSessionsCard from "@/components/hamilton/PortalSessionsCard.jsx"
import PortalSyncCard from "@/components/hamilton/PortalSyncCard.jsx"
import ProfilePortalsCard from "@/components/hamilton/ProfilePortalsCard.jsx"
import ProfileFundingSourcesCard from "@/components/funding/ProfileFundingSourcesCard.jsx"
import OrgMembersCard from "@/components/profiles/OrgMembersCard.jsx"
import PortalAccessScheduleCard from "@/components/profiles/PortalAccessScheduleCard.jsx"
import CommittedCollegeWorkspace from "@/components/profiles/CommittedCollegeWorkspace.jsx"
import SchoolPortalLinkPanel from "@/components/profiles/SchoolPortalLinkPanel.jsx"
import HealthResourcesCard from "@/components/profiles/HealthResourcesCard.jsx"
import { SECTION_METADATA } from "@/config/sectionMetadata"
import { runProfileAvatarLookup } from "@/services/profileAvatarAI"
import { calculateProfileCompletion } from "@/utils/profileCompletion"
import { deriveEmploymentStatusForSave, guardProfileSectionSuggestion } from "@/utils/profileSuggestionGuards"
import { formatFieldLabel } from "@/utils/fieldDisplay"
import { EDITABLE_SECTIONS } from "@/config/missingInfoTargets"

export default function ProfileDetail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const profileId = searchParams.get("id")
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.user)
  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const isAdmin = Boolean(user?.is_admin || user?.id === "admin")
  const { state: dashboardPrefs, dispatch: preferencesDispatch } = useDashboardPreferences()
  const preferences = useSettingsStore((state) => state.preferences)
  const updatePreference = useSettingsStore((state) => state.updatePreference)
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
  const canDeleteDocuments = Boolean(
    isAdmin ||
      (profile?.user_id && user?.id && String(profile.user_id) === String(user.id)) ||
      (activeProfileId && profileId && String(activeProfileId) === String(profileId)),
  )

  const upsertSectionMutation = useMutation({
    mutationFn: ({ sectionKey, values }) => upsertProfileSection(profileId, sectionKey, values),
    onSuccess: (response, variables) => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profiles"] })
      const rejected = Array.isArray(response?.rejected) ? response.rejected : []
      toast({
        title: rejected.length > 0 ? "Section saved with skipped fields" : "Section saved",
        description:
          rejected.length > 0
            ? rejected
                .slice(0, 3)
                .map((item) => `Skipped ${formatFieldLabel(variables?.sectionKey, item.key)}: ${item.reason.replace(/_/g, " ")}`)
                .join("; ")
            : "Your updates are synced with the comprehensive application schema.",
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
      // Update both local and backend preferences
      preferencesDispatch({ type: "SET_COLOR_THEME", theme })
      updatePreference("accent_color", theme)
      
      toast({
        title: "Theme updated",
        description: "Your color theme preference has been saved.",
      })
    },
    [preferencesDispatch, updatePreference, toast],
  )

  const handleLayoutChange = React.useCallback(
    (layout) => {
      // Update both local and backend preferences
      preferencesDispatch({ type: "SET_LAYOUT", layout })
      preferencesDispatch({
        type: "SET_LAYOUT_COLUMNS",
        columns: layout === "compact" ? 3 : 2,
      })
      updatePreference("dashboard_layout", layout === "compact" ? "grid" : "list")
      updatePreference("card_density", layout === "compact" ? "compact" : "comfortable")
      
      toast({
        title: "Layout updated",
        description: "Your layout preference has been saved.",
      })
    },
    [preferencesDispatch, updatePreference, toast],
  )

  const handleUploadDocument = React.useCallback(
    (file) => {
      if (!file) return
      uploadDocumentMutation.mutate({ file })
    },
    [uploadDocumentMutation],
  )

  const requestAvatarAIMutation = useMutation({
    mutationFn: async () => {
      const basic =
        profile?.sections?.find((section) => section.section_key === "basic_information")?.data ?? {}
      const websiteHint = basic?.website || profile?.website || null
      return runProfileAvatarLookup(profileId, { websiteHint })
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      if (result?.ok) {
        toast({
          title: "Picture found",
          description: "We saved a profile photo from the website or generated one with AI.",
        })
      } else {
        toast({
          title: "Picture not found",
          description: "We could not locate a usable photo. Try uploading one manually.",
          variant: "destructive",
        })
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to complete the AI avatar search."
      toast({
        title: "Request failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  // ORG profiles: pull the avatar straight from the org's own website logo.
  // Deterministic + durable (stored as BYTEA). On failure we surface a clear
  // reason so the user can fall back to AI generation or manual upload.
  const requestAvatarFromWebsiteMutation = useMutation({
    mutationFn: async () => {
      const basic =
        profile?.sections?.find((section) => section.section_key === "basic_information")?.data ?? {}
      const website = basic?.website || profile?.website || null
      return requestProfileAvatarFromWebsite(profileId, { website })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      toast({
        title: "Logo applied",
        description: "We pulled the logo from the organization's website.",
      })
    },
    onError: (err) => {
      const reason = err?.details?.reason || err?.errorCode || null
      const description =
        reason === "no_website"
          ? "No website is on file. Add one in Basic Information, or upload a photo."
          : err?.details?.message ||
            (err instanceof Error ? err.message : "We could not find a usable logo on that website.")
      toast({
        title: "No logo found",
        description,
        variant: "destructive",
      })
    },
  })

  const renameProfileMutation = useMutation({
    mutationFn: (displayName) => updateProfile(profileId, { display_name: displayName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profiles"] })
      toast({
        title: "Profile name updated",
        description: "The new name is saved and synced to Basic Information.",
      })
    },
    onError: (err) => {
      toast({
        title: "Rename failed",
        description: err instanceof Error ? err.message : "Unable to update the profile name right now.",
        variant: "destructive",
      })
    },
  })

  const handleRenameProfile = React.useCallback(
    async (displayName) => {
      await renameProfileMutation.mutateAsync(displayName)
    },
    [renameProfileMutation],
  )

  const handleOpenSection = React.useCallback((sectionKey, data = {}, focusField = null) => {
    let sectionData = data ?? {}
    if (sectionKey === "basic_information" && profile?.display_name) {
      const existingName = String(sectionData.full_name || "").trim()
      if (!existingName) {
        sectionData = { ...sectionData, full_name: profile.display_name }
      }
    }
    setEditingSection({
      key: sectionKey,
      data: sectionData,
      focusField: focusField || null,
    })
  }, [profile?.display_name])

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
        const guarded = guardProfileSectionSuggestion(editingSection.data ?? {}, values, { sectionKey: key, profile })
        const guardedValues = deriveEmploymentStatusForSave(key, guarded.data, profile)
        if (guarded.rejected.length > 0) {
          toast({
            title: "Skipped unsupported fields",
            description: guarded.rejected
              .slice(0, 3)
              .map((item) => `Skipped ${formatFieldLabel(key, item.key)}: ${item.reason.replace(/_/g, " ")}`)
              .join("; "),
          })
        }
        await upsertSectionMutation.mutateAsync({ sectionKey: key, values: guardedValues })
        setEditingSection(null)
      } catch (err) {
        // Error toast handled in mutation onError
      } finally {
        setSavingSectionKey(null)
      }
    },
    [editingSection, profile, upsertSectionMutation],
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

        const guarded = guardProfileSectionSuggestion(existing, suggestion, { sectionKey, profile })

        setEditingSection({
          key: sectionKey,
          data: guarded.data,
        })
        toast({
          title: "AI suggestion ready",
          description:
            guarded.rejected.length > 0
              ? "Review the proposed updates. Some AI toggles were held back or routed because the evidence was household-level."
              : "Review the proposed updates and save any changes you approve.",
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

  const handleAskFromEditor = React.useCallback(async (currentValues = {}) => {
    if (!editingSection) return null
    try {
      const response = await aiSuggestionMutation.mutateAsync(editingSection.key)
      const suggestion = response?.suggestion ?? null
      if (!suggestion || typeof suggestion !== "object") return null
      const guarded = guardProfileSectionSuggestion(currentValues, suggestion, {
        sectionKey: editingSection.key,
        profile,
      })
      if (guarded.rejected.length > 0) {
        toast({
          title: "Skipped unsupported AI fields",
          description: guarded.rejected
            .slice(0, 3)
            .map((item) => `Skipped ${formatFieldLabel(editingSection.key, item.key)}: ${item.reason.replace(/_/g, " ")}`)
            .join("; "),
        })
      }
      return guarded.data
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not fetch an AI suggestion."
      throw new Error(message)
    }
  }, [editingSection, aiSuggestionMutation, profile, toast])

  const handleInlineSaveField = React.useCallback(
    async (sectionKey, fieldKey, nextValue) => {
      if (!profileId) return
      if (!profile) return
      if (!sectionKey || !fieldKey) return

      const existing =
        profile.sections?.find((section) => section.section_key === sectionKey)?.data ?? {}

      const nextData = deriveEmploymentStatusForSave(sectionKey, {
        ...(existing ?? {}),
        [fieldKey]: nextValue,
      }, profile)

      try {
        setSavingSectionKey(sectionKey)
        await upsertSectionMutation.mutateAsync({ sectionKey, values: nextData })
      } finally {
        setSavingSectionKey(null)
      }
    },
    [profileId, profile, upsertSectionMutation],
  )

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

  const handleUseWebsiteLogo = React.useCallback(() => {
    requestAvatarFromWebsiteMutation.mutate()
  }, [requestAvatarFromWebsiteMutation])


  // IMPORTANT: All hooks must be called before any conditional returns (React rules of hooks).
  const [activeTab, setActiveTab] = React.useState("profile")
  // Deep-link support: ?tab=&section=&field= (emitted by MissingInfoChecklist /
  // HamiltonTaskDrawer / Profile Action Plan) lands the user on the right tab
  // and pops the matching section editor focused on the field to fill.
  const deepLinkHandled = useRef(null)
  const tabParam = searchParams.get("tab")
  const sectionParam = searchParams.get("section")
  const fieldParam = searchParams.get("field")
  React.useEffect(() => {
    if (!profile) return
    const token = `${tabParam || ""}|${sectionParam || ""}|${fieldParam || ""}`
    if (token === "|" || deepLinkHandled.current === token) return
    deepLinkHandled.current = token
    if (tabParam) setActiveTab(tabParam)
    // Only pop the section editor for sections that actually have one — for
    // documents / universities we just land on the tab.
    if (sectionParam && EDITABLE_SECTIONS.has(sectionParam)) {
      const existing =
        profile.sections?.find((section) => section.section_key === sectionParam)?.data ?? {}
      handleOpenSection(sectionParam, existing, fieldParam)
    }
  }, [profile, tabParam, sectionParam, fieldParam, handleOpenSection])
  const hasSyncedTargetColleges = useRef(false)
  const lastSyncedProfileId = useRef(null)
  const failedTargetCollegeSyncProfiles = useRef(new Set())

  // Derived state — computed here (before early returns) using optional chaining so they are
  // safe when `profile` is still undefined (loading / error states).
  const canDocumentAI = isAdmin || Boolean(profile?.billing?.tier?.enable_document_ai)

  const primaryType = String(profile?.primary_type || "").toLowerCase()
  const basicInfo =
    profile?.sections?.find((section) => section.section_key === "basic_information")?.data ?? {}
  const profileTypeLabel = String(basicInfo?.profile_type || "").toLowerCase()

  const eduSection = profile?.sections?.find((s) => s.section_key === "education")?.data
  const highestLevel = String(eduSection?.highest_level || "").toLowerCase()
  const targetColleges = eduSection?.target_colleges
  const hasTargetColleges = Array.isArray(targetColleges)
    ? targetColleges.length > 0
    : typeof targetColleges === "string" && targetColleges.trim().length > 0

  const isStudentProfile =
    ["high_school_student", "college_student", "graduate_student"].includes(primaryType) ||
    profileTypeLabel.includes("student") ||
    highestLevel.includes("student") ||
    hasTargetColleges

  // Org-vs-individual: individuals (people, students, single medical/veteran/etc.)
  // keep the existing AI/upload flow. Everything else (nonprofit, church, school,
  // government, business...) is treated as an organization and is offered the
  // "Use website logo" option. We default UNKNOWN/blank types to individual so we
  // never surface an org-only control on a personal profile.
  const INDIVIDUAL_PRIMARY_TYPES = new Set([
    "individual",
    "individual_need",
    "family",
    "medical_need",
    "medical_assistance",
    "medical",
    "senior",
    "veteran",
    "disabled_adult",
    "student",
    "high_school_student",
    "college_student",
    "graduate_student",
  ])
  const isOrgProfile =
    !isStudentProfile &&
    primaryType.length > 0 &&
    !INDIVIDUAL_PRIMARY_TYPES.has(primaryType) &&
    !profileTypeLabel.includes("individual")
  const profileWebsite = String(basicInfo?.website || profile?.website || "").trim()
  const hasWebsiteOnFile = profileWebsite.length > 0

  const healthMedical =
    profile?.sections?.find((section) => section.section_key === "health_medical")?.data ?? {}

  const hasHealthSignals =
    Boolean(healthMedical?.chronic_illness) ||
    Boolean(healthMedical?.dialysis_patient) ||
    Boolean(healthMedical?.organ_transplant) ||
    Boolean(healthMedical?.hiv_aids) ||
    Boolean(healthMedical?.tbi_survivor) ||
    Boolean(healthMedical?.amputee) ||
    Boolean(healthMedical?.neurodivergent) ||
    Boolean(healthMedical?.mental_health_condition) ||
    Boolean(healthMedical?.wheelchair_user) ||
    Boolean(healthMedical?.visual_impairment) ||
    Boolean(healthMedical?.hearing_impairment) ||
    (Array.isArray(healthMedical?.disability_type) && healthMedical.disability_type.length > 0) ||
    (Array.isArray(healthMedical?.support_needs) && healthMedical.support_needs.length > 0) ||
    (Array.isArray(healthMedical?.conditions) && healthMedical.conditions.length > 0) ||
    Boolean(String(healthMedical?.notes || "").trim())

  // Personal/individual medical resources (copay assistance, clinical-trial
  // matching to "conditions in YOUR medical profile") only make sense for a
  // PERSON. An organization/nonprofit can have a disability flag captured on its
  // record (e.g. "serves people with disabilities"), but that must NOT surface
  // personal patient-assistance content as if the org itself were the patient.
  // So the Health tab is gated to non-org profiles even when health signals exist.
  const isHealthProfile =
    !isOrgProfile &&
    (primaryType.includes("health") ||
      primaryType.includes("patient") ||
      profileTypeLabel.includes("health") ||
      profileTypeLabel.includes("medical") ||
      hasHealthSignals)

  const studentState =
    basicInfo?.address?.state ??
    basicInfo?.state ??
    profile?.state ??
    ""

  const studentGender =
    basicInfo?.gender ??
    basicInfo?.sex ??
    profile?.gender ??
    ""

  const universitySectionData =
    profile?.sections?.find((section) => section.section_key === "university_applications")?.data ?? {}
  const universityApplications = Array.isArray(universitySectionData?.applications)
    ? universitySectionData.applications
    : []

  const handleSaveUniversityApplications = React.useCallback(
    async (nextApplications) => {
      try {
        setSavingSectionKey("university_applications")
        await upsertSectionMutation.mutateAsync({
          sectionKey: "university_applications",
          values: { applications: nextApplications },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to save university applications."
        toast({
          title: "Save failed",
          description: message,
          variant: "destructive",
        })
      } finally {
        setSavingSectionKey(null)
      }
    },
    [upsertSectionMutation, toast],
  )

  const handleAskUniversityApplications = React.useCallback(
    async () => {
      setAiLoadingKey("university_applications")
      try {
        return await aiSuggestionMutation.mutateAsync("university_applications")
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to fetch AI suggestion."
        toast({
          title: "AI request failed",
          description: message,
          variant: "destructive",
        })
        return null
      } finally {
        setAiLoadingKey(null)
      }
    },
    [aiSuggestionMutation, toast],
  )

  const profileCompletion = React.useMemo(() => calculateProfileCompletion(profile), [profile])
  const totalSections = profileCompletion.totalSections
  const completedSections = profileCompletion.completedSections
  const completionPct = profileCompletion.completionPct
  const nextEmptySection = profileCompletion.nextIncompleteSectionKey
  const nextEmptySectionTitle = nextEmptySection ? (SECTION_METADATA[nextEmptySection]?.title ?? nextEmptySection) : null

  // One-time sync: target_colleges -> university_applications (avoids duplicates, no infinite loop)
  useEffect(() => {
    if (!profileId || !profile) return
    if (failedTargetCollegeSyncProfiles.current.has(profileId)) return
    const pt = String(profile.primary_type || "").toLowerCase()
    const bi = profile.sections?.find((s) => s.section_key === "basic_information")?.data ?? {}
    const ptl = String(bi?.profile_type || "").toLowerCase()
    const eduData = profile.sections?.find((s) => s.section_key === "education")?.data
    const hl = String(eduData?.highest_level || "").toLowerCase()
    const tc = eduData?.target_colleges
    const hasTc = Array.isArray(tc) ? tc.length > 0 : typeof tc === "string" && tc.trim().length > 0
    const isStudent = ["high_school_student", "college_student", "graduate_student"].includes(pt)
      || ptl.includes("student")
      || hl.includes("student")
      || hasTc
    if (!isStudent) return
    const usd = profile.sections?.find((s) => s.section_key === "university_applications")?.data ?? {}
    const uniApps = Array.isArray(usd?.applications) ? usd.applications : []
    if (lastSyncedProfileId.current !== profileId) {
      hasSyncedTargetColleges.current = false
      lastSyncedProfileId.current = profileId
    }
    if (hasSyncedTargetColleges.current) return
    hasSyncedTargetColleges.current = true
    const educationData = profile.sections?.find((s) => s.section_key === "education")?.data ?? {}
    const { applications, addedCount } = syncTargetCollegesToApplications(educationData, uniApps)
    if (addedCount === 0) return
    upsertSectionMutation
      .mutateAsync({
        sectionKey: "university_applications",
        values: { applications },
      })
      .catch((err) => {
        failedTargetCollegeSyncProfiles.current.add(profileId)
        const msg = err instanceof Error ? err.message : "Sync failed"
        console.error("[ProfileDetail] target_colleges sync save failed:", msg)
        toast({
          variant: "destructive",
          title: "Target colleges sync failed",
          description: msg,
        })
      })
  }, [profileId, profile, upsertSectionMutation, toast])

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
            {/*
              Print Profile Packet — opens /PrintProfilePacket?profile_id=<id>
              in a new tab. The packet renders profile summary, pipeline by
              stage, items that need human review (with the application_steps
              the pipeline_automation worker prepared), and a simple next-steps
              checklist. Backed by GET /api/profiles/:id/report-packet.
            */}
            <Button
              variant="outline"
              onClick={() =>
                window.open(
                  createPageUrl("PrintProfilePacket", { profile_id: profileId }),
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              <Printer className="w-4 h-4 mr-2" />
              Print Profile Packet
            </Button>
            {profile.organization_id && (
              <Button onClick={() => navigate(createPageUrl("OrganizationProfile", { id: profile.organization_id }))}>
                View Linked Organization
              </Button>
            )}
          </div>
        </div>

        {/* Profile completeness progress bar */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-slate-700">
              {completedSections} of {totalSections} sections complete ({completionPct}%)
            </span>
            {completionPct === 100 && (
              <span className="text-emerald-600 font-medium text-xs">Profile complete</span>
            )}
          </div>
          <div className="w-full bg-gray-200 rounded h-2">
            <div
              className="h-2 rounded transition-all duration-300"
              style={{
                width: `${completionPct}%`,
                backgroundColor: completionPct >= 80 ? '#10b981' : completionPct >= 50 ? '#3b82f6' : '#f59e0b',
              }}
            />
          </div>
          {nextEmptySectionTitle && (
            <p className="text-xs text-slate-500">
              Fill in{' '}
              <button
                type="button"
                className="underline text-blue-600 hover:text-blue-800"
                onClick={() => handleOpenSection(nextEmptySection)}
              >
                {nextEmptySectionTitle}
              </button>{' '}
              to unlock more matches.
            </p>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList
            // Responsive tabs: NEVER overlap. Scroll horizontally on narrow widths.
            className="w-full justify-start gap-2 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <TabsTrigger className="shrink-0 min-w-max px-3" value="profile">Profile Information</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="pipeline">Pipeline</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="item-funding">Item Funding</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="deadlines">Grant Deadline</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="monitoring">Grant Monitoring</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="proposals">Proposals & Files</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="documents">Documents</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="action-plan">Action Plan</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="billing">Billing</TabsTrigger>
            <TabsTrigger className="shrink-0 min-w-max px-3" value="personalization">Personalization</TabsTrigger>
            {isStudentProfile ? <TabsTrigger className="shrink-0 min-w-max px-3" value="universities">Universities</TabsTrigger> : null}
            {isHealthProfile ? <TabsTrigger className="shrink-0 min-w-max px-3" value="health">Health</TabsTrigger> : null}
          </TabsList>

          <TabsContent value="profile" className="mt-6 space-y-6">
            <SchoolPortalLinkPanel profileId={profileId} />
            <ProfileOverview
              profile={profile}
              billing={profile.billing ?? null}
              onEditSection={handleOpenSection}
              onSaveField={handleInlineSaveField}
              onAskSection={handleAskSection}
              savingSectionKey={savingSectionKey}
              aiLoadingKey={aiLoadingKey}
              onUploadAvatar={handleUploadAvatar}
              onRequestAvatarAI={handleRequestAvatarAI}
              onUseWebsiteLogo={isOrgProfile ? handleUseWebsiteLogo : undefined}
              isOrgProfile={isOrgProfile}
              hasWebsiteOnFile={hasWebsiteOnFile}
              isUploadingAvatar={uploadAvatarMutation.isPending}
              isRequestingAvatar={requestAvatarAIMutation.isPending}
              isFetchingWebsiteLogo={requestAvatarFromWebsiteMutation.isPending}
              onUploadDocument={handleUploadDocument}
              isUploadingDocument={uploadDocumentMutation.isPending}
              fundsTotal={profile.pipeline_funds_total ?? 0}
              onNavigateToUniversities={isStudentProfile ? () => setActiveTab("universities") : undefined}
              onNavigateToPortals={() => {
                // The per-profile Portals dashboard (ProfilePortalsCard, Hamilton
                // sign-in + autopilot) lives in the Pipeline tab under #portal-logins.
                // Switch tabs, then scroll once the pipeline content has mounted.
                setActiveTab("pipeline")
                setTimeout(() => {
                  document
                    .getElementById("portal-logins")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }, 80)
              }}
              onRenameProfile={handleRenameProfile}
              isRenamingProfile={renameProfileMutation.isPending}
            />
          </TabsContent>

          <TabsContent value="pipeline" className="mt-6 space-y-6">
            {/* Portal access for Hamilton — pulled to the TOP of the tab and
                given a labelled anchor so the "Portal Logins" button on the
                Master Pipeline page (focus=portal-logins) can deep-link the
                user straight here. Previously these cards sat below the
                "Go to Pipeline" box and were easy to miss. */}
            <div id="portal-logins" className="scroll-mt-24 space-y-6">
              {/* The Portals dashboard IS the page: every portal that applies to
                  this profile (schools, funders, plus the right applications and
                  benefits for its type + state) is auto-listed. Green = ready,
                  red = click to log in once. No explainer clutter — the card
                  speaks for itself. Power-user manual entry lives under Advanced. */}
              <ProfileFundingSourcesCard profileId={profileId} />
              <ProfilePortalsCard profileId={profileId} profileName={profile?.display_name || ""} />
              {/* The manual portal-host/URL entry forms are de-emphasized: kept
                  for power users under a disclosure, since the dashboard above is
                  now the primary way to set up portals. */}
              <details className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                <summary className="cursor-pointer text-sm font-medium text-slate-700">
                  Advanced — add a portal manually
                </summary>
                <div className="mt-4 space-y-6">
                  {/* Saved portal logins — available for every profile type, since
                      Hamilton uses them to sign in to any grant/application portal she
                      automates from the pipeline. */}
                  <SavedLoginsCard profileId={profileId} />
                  {/* Saved portal SESSIONS (captured logins) — the self-serve "log in
                      from your phone or computer" capture flow + disclaimer. */}
                  <PortalSessionsCard profileId={profileId} />
                  {/* Two-way portal data sync — pull real data (test scores, aid
                      awards) into GrantFlow and push GrantFlow funding/awards back
                      into the portal, using the saved session above. Shows real
                      per-host run status. */}
                  <PortalSyncCard profileId={profileId} />
                </div>
              </details>
              <PortalAccessScheduleCard profileId={profileId} />
            </div>
            <div className="rounded-lg border bg-white p-6">
              <h3 className="text-lg font-semibold mb-4">Pipeline View</h3>
              <p className="text-slate-600 mb-4">
                View and manage grants in your pipeline for this profile.
              </p>
              <Button onClick={() => navigate(createPageUrl("Pipeline", { profile_id: profileId }))}>
                Go to Pipeline
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="item-funding" className="mt-6">
            <div className="rounded-lg border bg-white p-6">
              <h3 className="text-lg font-semibold mb-4">Item Funding</h3>
              <p className="text-slate-600 mb-4">
                Search for specific item funding opportunities.
              </p>
              <Button onClick={() => navigate(createPageUrl("ItemFunding", { profile_id: profileId }))}>
                Go to Item Funding
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="deadlines" className="mt-6">
            <div className="rounded-lg border bg-white p-6">
              <h3 className="text-lg font-semibold mb-4">Grant Deadlines</h3>
              <p className="text-slate-600 mb-4">
                Track upcoming grant deadlines for this profile.
              </p>
              <Button onClick={() => navigate(createPageUrl("GrantDeadline", { profile_id: profileId }))}>
                Go to Grant Deadlines
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="monitoring" className="mt-6">
            <div className="rounded-lg border bg-white p-6">
              <h3 className="text-lg font-semibold mb-4">Grant Monitoring</h3>
              <p className="text-slate-600 mb-4">
                Monitor awarded grants and compliance requirements.
              </p>
              <Button onClick={() => navigate(createPageUrl("GrantMonitoring", { organization_id: profile.organization_id }))}>
                Go to Grant Monitoring
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="proposals" className="mt-6">
            <div className="space-y-6">
              <div className="rounded-lg border bg-white p-6">
                <h3 className="text-lg font-semibold mb-2">Proposals</h3>
                <p className="text-slate-600 mb-4">Manage grant proposals linked to this profile's organization.</p>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => navigate(createPageUrl("Proposals", { organization_id: profile.organization_id }))}>
                    View Proposals
                  </Button>
                  <Button variant="outline" onClick={() => navigate(createPageUrl("Documents", { profile_id: profileId }))}>
                    View Document Library
                  </Button>
                </div>
              </div>

              <ProfileFilesPanel
                profileId={profileId}
                profileName={profile.display_name}
                canDocumentAI={canDocumentAI}
                canDeleteDocuments={canDeleteDocuments}
              />
            </div>
          </TabsContent>

          <TabsContent value="documents" className="mt-6">
            <div className="space-y-6">
              <ProfileFilesPanel
                profileId={profileId}
                profileName={profile.display_name}
                canDocumentAI={canDocumentAI}
                canDeleteDocuments={canDeleteDocuments}
              />
              <ProfileInfoPrint profile={profile} />
              <ProfileAppliedFundingPrint organizationId={profile.organization_id} profileName={profile.display_name} />
            </div>
          </TabsContent>

          <TabsContent value="action-plan" className="mt-6">
            <PrintableProfileTodo profileId={profileId} profileName={profile.display_name} />
          </TabsContent>

          <TabsContent value="billing" className="mt-6 space-y-6">
            <OrgMembersCard profileId={profileId} />
            <div className="rounded-lg border bg-white p-6">
              <h3 className="text-lg font-semibold mb-4">Billing</h3>
              {profile.billing ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">Current Plan: {profile.billing.plan || 'Standard'}</p>
                      <p className="text-sm text-slate-600">
                        {profile.billing.is_pro_bono ? 'Pro Bono Account' : `$${profile.billing.monthly_rate || 0}/month`}
                      </p>
                    </div>
                    <Button onClick={() => navigate(createPageUrl("Billing", { organization_id: profile.organization_id }))}>
                      View Full Billing
                    </Button>
                  </div>
                  {profile.billing.is_pro_bono && (
                    <Alert>
                      <AlertDescription>
                        This is a pro bono account. Invoices will show $0 for tax record purposes.
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="mt-4">
                    <h4 className="font-medium mb-2">Recent Invoice</h4>
                    <p className="text-sm text-slate-600">
                      Amount: ${profile.billing.is_pro_bono ? '0.00' : (profile.billing.last_invoice_amount || '0.00')}
                    </p>
                    <p className="text-sm text-slate-600">
                      Date: {profile.billing.last_invoice_date || 'N/A'}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-slate-600">No billing information available for this profile.</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="personalization" className="mt-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Theme & readability</CardTitle>
                  <CardDescription>Adjust color + font size. These apply immediately across the app.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label>Accent color</Label>
                    <div className="grid grid-cols-4 gap-3">
                      {[
                        { name: "blue", hex: "#3b82f6" },
                        { name: "purple", hex: "#a855f7" },
                        { name: "green", hex: "#22c55e" },
                        { name: "orange", hex: "#f97316" },
                        { name: "rose", hex: "#f43f5e" },
                        { name: "cyan", hex: "#06b6d4" },
                        { name: "amber", hex: "#f59e0b" },
                        { name: "pink", hex: "#ec4899" },
                      ].map((color) => (
                        <button
                          key={color.name}
                          type="button"
                          onClick={() => updatePreference("accent_color", color.name)}
                          className={`h-11 rounded-lg border-2 transition-transform hover:scale-[1.02] ${
                            preferences?.accent_color === color.name
                              ? "border-slate-900 ring-2 ring-slate-900"
                              : "border-slate-200"
                          }`}
                          style={{ backgroundColor: color.hex }}
                          aria-label={`Select ${color.name} accent color`}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Font size</Label>
                    <Select
                      value={preferences?.font_size ?? ''}
                      onValueChange={(value) => updatePreference("font_size", value)}
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue placeholder="Select font size" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="small">Small</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="large">Large</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Comfort</CardTitle>
                  <CardDescription>Reduce motion, increase contrast, and tune density.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label>Card density</Label>
                    <Select
                      value={preferences?.card_density ?? ''}
                      onValueChange={(value) => updatePreference("card_density", value)}
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue placeholder="Select density" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="compact">Compact</SelectItem>
                        <SelectItem value="comfortable">Comfortable</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <Label>Reduce motion</Label>
                      <p className="text-sm text-slate-500">Less animation and movement.</p>
                    </div>
                    <Switch
                      checked={Boolean(preferences?.reduce_motion)}
                      onCheckedChange={(checked) => updatePreference("reduce_motion", checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <Label>High contrast</Label>
                      <p className="text-sm text-slate-500">Sharper contrast for readability.</p>
                    </div>
                    <Switch
                      checked={Boolean(preferences?.high_contrast)}
                      onCheckedChange={(checked) => updatePreference("high_contrast", checked)}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="mt-6 rounded-lg border bg-white p-4">
              <p className="text-sm text-slate-600">
                Tip: these settings are the same ones used on the main <strong>Settings</strong> page—this tab is just
                a quicker place to tweak them while you’re working inside a profile.
              </p>
            </div>
          </TabsContent>

          {isStudentProfile ? (
            <TabsContent value="universities" className="mt-6">
              <div className="space-y-6">
                <SchoolPortalLinkPanel profileId={profileId} />
                <StudentPortalsCard state={studentState} profileId={profileId} applications={universityApplications} />
                <CommittedCollegeWorkspace profileId={profileId} applications={universityApplications} />
              <UniversityApplicationsSection
                applications={universityApplications}
                onSave={handleSaveUniversityApplications}
                saving={savingSectionKey === "university_applications"}
                onAskAI={handleAskUniversityApplications}
                aiLoading={aiLoadingKey === "university_applications"}
                studentGender={studentGender}
                profileId={profileId}
              />
              </div>
            </TabsContent>
          ) : null}

          {isHealthProfile ? (
            <TabsContent value="health" className="mt-6">
              <div className="space-y-6">
                <HealthResourcesCard
                  isOrganization={isOrgProfile}
                  state={studentState}
                  conditions={healthMedical?.conditions}
                  supportNeeds={healthMedical?.support_needs}
                  consentForStudies={Boolean(healthMedical?.consent_for_studies)}
                  onEditHealth={() => handleOpenSection("health_medical", healthMedical)}
                  consentSaving={
                    upsertSectionMutation.isPending &&
                    upsertSectionMutation.variables?.sectionKey === "health_medical"
                  }
                  onToggleStudyConsent={(next) =>
                    upsertSectionMutation.mutate({
                      sectionKey: "health_medical",
                      values: { ...healthMedical, consent_for_studies: next },
                    })
                  }
                />
              </div>
            </TabsContent>
          ) : null}
        </Tabs>
      </div>

      <ProfileSectionEditor
        open={Boolean(editingSection)}
        sectionKey={editingSection?.key}
        initialData={editingSection?.data ?? {}}
        focusField={editingSection?.focusField}
        profileId={profileId}
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
