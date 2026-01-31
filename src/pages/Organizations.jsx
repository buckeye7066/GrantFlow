import React, { useMemo, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertCircle, Loader2 } from "lucide-react"
import OrganizationCard from "@/components/organizations/OrganizationCard"
import OrganizationFilters from "@/components/organizations/OrganizationFilters"
import OrganizationActions from "@/components/organizations/OrganizationActions"
import OrganizationEmptyState from "@/components/organizations/OrganizationEmptyState"
import ComprehensiveApplicationForm from "@/components/organizations/ComprehensiveApplicationForm"
import UploadApplicationForm from "@/components/organizations/UploadApplicationForm"
import OrganizationForm from "@/components/organizations/OrganizationForm"
import QuickAddDialog from "@/components/organizations/QuickAddDialog"
import UploadFormDialog from "@/components/organizations/UploadFormDialog"
import { useToast } from "@/components/ui/use-toast"
import { listProfiles } from "@/api/profiles"
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
  }
}

export default function Organizations() {
  const [searchTerm, setSearchTerm] = useState("")
  const [typeFilter, setTypeFilter] = useState("all")
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [uploadFormOpen, setUploadFormOpen] = useState(false)
  const [comprehensiveOpen, setComprehensiveOpen] = useState(false)
  const [comprehensiveSubmitting, setComprehensiveSubmitting] = useState(false)
  const { toast } = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.user)
  const isAdmin = user?.is_admin ?? false
  const log = React.useMemo(() => createLogger("OrganizationsPage"), [])

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
      const matchesSearch =
        org.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        org.applicant_type?.toLowerCase().includes(searchTerm.toLowerCase())

      const matchesType = typeFilter === "all" || org.applicant_type === typeFilter

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
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
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

      queryClient.invalidateQueries({ queryKey: ['profiles'] })

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
      const result = await apiFetch('/api/profiles', {
        method: 'POST',
        body: JSON.stringify({
          display_name: formData.display_name,
          primary_type: formData.primary_type,
        }),
      })
      
      // Validate that we got a profile ID back
      if (!result || !result.id) {
        throw new Error('Profile creation failed: No profile ID returned')
      }
      
      // If avatar file is provided, upload it
      if (formData.avatarFile && result.id) {
        const avatarFormData = new FormData()
        avatarFormData.append('avatar', formData.avatarFile)
        
        await fetch(`/api/profiles/${result.id}/avatar`, {
          method: 'POST',
          body: avatarFormData,
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('grantflow:access-token')}`,
          },
        })
      }
      
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      
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
        throw new Error('Document upload succeeded but no profile ID was returned')
      }
      
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      
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

  const showComingSoon = (message) => {
    toast({
      title: "Coming soon",
      description: message,
    })
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
            <h1 className="text-3xl font-bold text-slate-900">Profiles</h1>
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
                  onEdit={() => navigate(createPageUrl("OrganizationProfile", { id: org.id }))}
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
    </section>
  )
}
