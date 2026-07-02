import React, { Suspense, useEffect, useMemo, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertCircle, Loader2 } from "lucide-react"
import OrganizationCard from "@/components/organizations/OrganizationCard"
import OrganizationFilters from "@/components/organizations/OrganizationFilters"
import OrganizationActions from "@/components/organizations/OrganizationActions"
import OrganizationEmptyState from "@/components/organizations/OrganizationEmptyState"
import { lazyWithRetry } from "@/utils/lazyWithRetry"
// lazyWithRetry (not raw React.lazy): opening these dialogs during/after a
// deploy must auto-recover from a stale chunk instead of crashing the route.
const ComprehensiveApplicationForm = lazyWithRetry(() => import("@/components/organizations/ComprehensiveApplicationForm"), 'Org:ComprehensiveApplicationForm')
const UploadApplicationForm = lazyWithRetry(() => import("@/components/organizations/UploadApplicationForm"), 'Org:UploadApplicationForm')
const OrganizationForm = lazyWithRetry(() => import("@/components/organizations/OrganizationForm"), 'Org:OrganizationForm')
const QuickAddDialog = lazyWithRetry(() => import("@/components/organizations/QuickAddDialog"), 'Org:QuickAddDialog')
const UploadFormDialog = lazyWithRetry(() => import("@/components/organizations/UploadFormDialog"), 'Org:UploadFormDialog')
const AutomatedSearchConfig = lazyWithRetry(() => import("@/components/organizations/AutomatedSearchConfig"), 'Org:AutomatedSearchConfig')
import { useToast } from "@/components/ui/use-toast"
import { listProfiles, uploadProfileAvatar } from "@/api/profiles"
import { canonicalizeProfileTypeId } from "@/services/profileTypes"
import { createPageUrl } from "@/utils"
import { useAuthStore } from "@/stores/authStore"
import { apiFetch } from "@/api/client"
import { createLogger } from "@/utils/logger"

function mapProfileToOrganization(profile) {
  return {
    id: profile.id,
    name: profile.display_name,
    applicant_type: profile.primary_type,
    profile_image_url: profile.avatar_url ?? null,
    mission: profile.mission,
    tags: profile.tags ?? [],
    // Preserve deep profile sections so downstream components and search
    // can inspect sub-type detail without a second fetch (Goals 5, 6).
    location: profile.location ?? null,
    needs: profile.needs ?? [],
    military: profile.military ?? null,
    education: profile.education ?? null,
    family: profile.family ?? null,
    health: profile.health ?? null,
    emergency: profile.emergency ?? null,
    business: profile.business ?? null,
    housing: profile.housing ?? null,
  }
}

export default function Organizations() {
  const [searchTerm, setSearchTerm] = useState("")
  const [typeFilter, setTypeFilter] = useState("all")
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [uploadFormOpen, setUploadFormOpen] = useState(false)
  const [comprehensiveOpen, setComprehensiveOpen] = useState(false)
  const [comprehensiveSubmitting, setComprehensiveSubmitting] = useState(false)
  const [autoSearchOrg, setAutoSearchOrg] = useState(null)
  const { toast } = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.user)
  const isAdmin = user?.is_admin ?? false
  const log = React.useMemo(() => createLogger("OrganizationsPage"), [])

  // Open the Quick Add create flow directly when arrived here via "Create
  // Profile" on My Profiles (navigate adds ?quickAdd=1).
  const [searchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get("quickAdd") === "1") setQuickAddOpen(true)
  }, [searchParams])

  const {
    data: profiles = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['profiles', isAdmin],
    queryFn: async () => {
      log.debug('fetching profiles', { isAdmin: Boolean(isAdmin) })
      const result = await listProfiles(isAdmin ? { admin: true } : {})
      log.debug('profiles fetched', { count: Array.isArray(result) ? result.length : null })
      return result
    },
  })

  const organizations = useMemo(
    () => profiles.map(mapProfileToOrganization),
    [profiles],
  )

  const filteredOrgs = useMemo(() => {
    return organizations.filter((org) => {
      const lowerSearch = searchTerm.toLowerCase()
const matchesSearch =
        org.name.toLowerCase().includes(lowerSearch) ||
        (org.applicant_type?.toLowerCase().includes(lowerSearch) ?? false) ||
        (org.mission?.toLowerCase().includes(lowerSearch) ?? false) ||
        (Array.isArray(org.tags) && org.tags.some((t) => t.toLowerCase().includes(lowerSearch))) ||
        (Array.isArray(org.needs) && org.needs.some((n) => n.toLowerCase().includes(lowerSearch)))

      const matchesType =
        typeFilter === "all" ||
        canonicalizeProfileTypeId(org.applicant_type) === canonicalizeProfileTypeId(typeFilter) ||
        org.applicant_type === typeFilter

      return matchesSearch && matchesType
    })
  }, [organizations, searchTerm, typeFilter])

  const createProfileMutation = useMutation({
    mutationFn: async (profileData) => {
      return apiFetch('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(profileData),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' })
      useAuthStore.getState().refreshProfiles({ reason: 'profile-created', force: true })
      toast({
        title: "Profile created",
        description: "The new profile has been created successfully.",
      })
    },
    onError: (error) => {
      toast({
        title: "Failed to create profile",
        description: error.message,
        variant: "destructive",
      })
    },
  })

  const handleNewApplication = () => {
    setComprehensiveOpen(true)
  }

  const handleComprehensiveSubmit = async (applicationData) => {
    setComprehensiveSubmitting(true)
    try {
      const result = await apiFetch('/api/organizations', {
        method: 'POST',
        body: JSON.stringify(applicationData ?? {}),
      })

      const profileId = result?.profile_id ?? null

      queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' })
      useAuthStore.getState().refreshProfiles({ reason: 'profile-created-comprehensive', force: true })

      toast({
        title: 'Profile created',
        description: 'Your comprehensive application has been saved as a new profile.',
      })

      setComprehensiveOpen(false)

      if (profileId) {
        navigate(createPageUrl("OrganizationProfile", { id: profileId }))
      } else {
        // Non-fatal: profile sync failed, but org row was created.
        toast({
          title: 'Saved, but profile link missing',
          description:
            'Your application was saved, but we could not open the profile automatically. Please refresh and look for it in the list.',
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Failed to create profile',
        description: error?.message || 'An error occurred while saving the application.',
        variant: 'destructive',
      })
    } finally {
      setComprehensiveSubmitting(false)
    }
  }

  const handleQuickAdd = async (formData) => {
    try {
      // Create profile first
      // Spread all collected form fields so the profile retains location,
      // needs, and sub-type detail required for full-depth matching (Goals 5, 6).
      const { avatarFile: _avatarFile, ...profileFields } = formData
      const result = await apiFetch('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(profileFields),
      })
      
      // Validate that we got a profile ID back
      if (!result || !result.id) {
        throw new Error('Profile creation failed: No profile ID returned')
      }
      
      // If avatar file is provided, upload it via the canonical helper.
      // The helper applies assertRealProfileId, so a sentinel id (or any
      // other non-routable value) throws here instead of issuing a 404.
      if (formData.avatarFile && result.id) {
        try {
          await uploadProfileAvatar(result.id, formData.avatarFile)
        } catch (avatarErr) {
          // Non-fatal: profile was created; log and surface a warning but do not throw.
          log.warn('Avatar upload failed', { profileId: result.id, error: avatarErr?.message })
          toast({
            title: 'Profile created',
            description: 'Profile was saved but the avatar could not be uploaded. You can add it later from the profile page.',
            variant: 'default',
          })
        }
      }
      
      queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' })
      useAuthStore.getState().refreshProfiles({ reason: 'profile-created-quick', force: true })

      toast({
        title: "Profile created",
        description: `Successfully created profile for ${formData.display_name}`,
      })
      
      // Navigate to the new profile
      navigate(createPageUrl("OrganizationProfile", { id: result.id }))
    } catch (error) {
      toast({
        title: "Error",
        description: error.message || "Failed to create profile. Please try again.",
        variant: "destructive",
      })
      throw error
    }
  }

  const handleUploadForm = async (file) => {
    try {
      const formData = new FormData()
      formData.append('document', file)
      formData.append('enable_ai', 'true')
      formData.append('skip_parsing', 'false')
      formData.append('type', 'source_material')
      formData.append('ocr', 'true')
      formData.append('handwriting', 'true')
      formData.append('source', 'profile_create_upload')
      const inferredName = file.name?.replace(/\.[^/.]+$/, '') ?? ''
      if (inferredName) {
        formData.append('display_name', inferredName)
      }
      
      const response = await fetch('/api/documents/ingest', {
        method: 'POST',
        body: formData,
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('grantflow:access-token')}`,
        },
      })
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to parse error response' }))
        throw new Error(errorData.error || `Upload failed with status ${response.status}`)
      }
      
      const result = await response.json()
      
      // Validate that we got a profile ID back
      if (!result || !result.profile_id) {
        log.error('Document upload succeeded but no profile_id returned', { result })
        throw new Error('Document upload succeeded but no profile ID was returned')
      }
      
      queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' })
      useAuthStore.getState().refreshProfiles({ reason: 'profile-created-upload', force: true })

      toast({
        title: "Form uploaded",
        description: "Your form has been processed and a profile has been created.",
      })
      
      // Navigate to the new profile
      navigate(createPageUrl("OrganizationProfile", { id: result.profile_id }))
    } catch (error) {
      toast({
        title: "Error",
        description: error.message || "Failed to upload form. Please try again.",
        variant: "destructive",
      })
      throw error
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred"
    return (
      <div className="p-6 md:p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load profiles. Please try refreshing the page.
            {errorMessage && <span className="block mt-2 text-sm">{errorMessage}</span>}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const hasFilters = searchTerm !== "" || typeFilter !== "all"

  return (
    <section className="p-6 md:p-8" aria-label="Profiles list">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Organizations</h1>
            <p className="text-slate-600 mt-2">
              Manage organizations, students, and individuals seeking funding.
            </p>
          </div>
          <OrganizationActions
            onQuickAdd={() => setQuickAddOpen(true)}
            onUpload={() => setUploadFormOpen(true)}
            onNewApplication={handleNewApplication}
          />
        </header>

        <OrganizationFilters
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          typeFilter={typeFilter}
          onTypeChange={setTypeFilter}
        />

        {filteredOrgs.length === 0 ? (
          <OrganizationEmptyState
            hasFilters={hasFilters}
            onCreateFirst={() => setQuickAddOpen(true)}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredOrgs.map((org) => (
                <OrganizationCard
                  key={org.id}
                  organization={org}
                  onEdit={() => navigate(createPageUrl("ProfileDetail", { id: org.id }))}
                  onAutomatedSearch={(selected) => setAutoSearchOrg(selected)}
                  onDelete={() => {
                    // Navigate to profile page where delete functionality exists
                    navigate(createPageUrl("OrganizationProfile", { id: org.id }))
                  }}
                  onInvoice={() => {
                    // Navigate to billing page with profile context
                    navigate(createPageUrl("Billing", { profile_id: org.id }))
                  }}
                  onClick={() => navigate(createPageUrl("OrganizationProfile", { id: org.id }))}
                />
              ))}
            </div>
            <footer className="mt-6 text-center text-sm text-slate-500">
              Showing {filteredOrgs.length} of {organizations.length} profiles
            </footer>
          </>
        )}
      </div>

      <Suspense fallback={null}>
        <QuickAddDialog
          open={quickAddOpen}
          onOpenChange={setQuickAddOpen}
          onSubmit={handleQuickAdd}
        />

        <UploadFormDialog
          open={uploadFormOpen}
          onOpenChange={setUploadFormOpen}
          onUpload={handleUploadForm}
        />

        {autoSearchOrg && (
          <AutomatedSearchConfig
            organization={autoSearchOrg}
            open={Boolean(autoSearchOrg)}
            onClose={() => setAutoSearchOrg(null)}
          />
        )}

        <Dialog open={comprehensiveOpen} onOpenChange={setComprehensiveOpen}>
          <DialogContent className="max-w-5xl w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>New Comprehensive Application</DialogTitle>
            </DialogHeader>
            <ComprehensiveApplicationForm
              onSubmit={handleComprehensiveSubmit}
              onCancel={() => setComprehensiveOpen(false)}
              isSubmitting={comprehensiveSubmitting}
            />
          </DialogContent>
        </Dialog>
      </Suspense>
    </section>
  )
}
