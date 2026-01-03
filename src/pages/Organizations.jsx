import React, { useMemo, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useQuery, useQueryClient } from "@tanstack/react-query"
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
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [showNewApplication, setShowNewApplication] = useState(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [uploadFormOpen, setUploadFormOpen] = useState(false)
  const { toast } = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.user)
  const isAdmin = user?.is_admin ?? false

  console.log('[Organizations] User:', user, 'isAdmin:', isAdmin)

  const {
    data: profiles = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['profiles', isAdmin],
    queryFn: async () => {
      console.log('[Organizations] Fetching profiles, isAdmin:', isAdmin)
      const result = await listProfiles(isAdmin ? { admin: true } : {})
      console.log('[Organizations] Profiles fetched:', result?.length, 'profiles')
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
      setShowQuickAdd(false)
      setShowNewApplication(false)
    },
    onError: (error) => {
      toast({
        title: "Failed to create profile",
        description: error.message,
        variant: "destructive",
      })
    },
  })

  const handleQuickAdd = () => {
    setShowQuickAdd(true)
  }

  const handleUpload = () => {
    setShowUpload(true)
  }

  const handleNewApplication = () => {
    setShowNewApplication(true)
  }

  const handleQuickAddSubmit = (data) => {
    createProfileMutation.mutate({
      display_name: data.name,
      primary_type: data.applicant_type,
      status: 'active',
      tags: data.tags || [],
    })
  }

  const handleNewApplicationSubmit = (data) => {
    // Note: This creates a basic profile. Full comprehensive form data
    // should be saved to profile sections via the profile sections API
    // in a future enhancement. For now, we create a minimal profile entry.
    createProfileMutation.mutate({
      display_name: data.name,
      primary_type: data.applicant_type,
      status: 'active',
      tags: [],
      // TODO: Store additional form data in profile_sections table
    })
  }

  const handleUploadSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['profiles'] })
    setShowUpload(false)
  const handleQuickAdd = async (formData) => {
    try {
      const result = await apiFetch('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(formData),
      })
      
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
      
      const response = await fetch('/api/documents/ingest', {
        method: 'POST',
        body: formData,
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('grantflow:access-token')}`,
        },
      })
      
      if (!response.ok) {
        throw new Error('Upload failed')
      }
      
      const result = await response.json()
      
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      
      toast({
        title: "Form uploaded",
        description: "Your form has been processed and a profile has been created.",
      })
      
      // Navigate to the new profile if one was created
      if (result.profile_id) {
        navigate(createPageUrl("OrganizationProfile", { id: result.profile_id }))
      }
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
      title: "Form uploaded",
      description: "The form has been uploaded and will be processed shortly.",
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
            onQuickAdd={handleQuickAdd}
            onUpload={handleUpload}
            onNewApplication={handleNewApplication}
            onQuickAdd={() => setQuickAddOpen(true)}
            onUpload={() => setUploadFormOpen(true)}
            onNewApplication={() => showComingSoon("The full comprehensive application builder is under active development.")}
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
            onCreateFirst={handleNewApplication}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredOrgs.map((org) => (
                <OrganizationCard
                  key={org.id}
                  organization={org}
                  onEdit={() => navigate(createPageUrl("OrganizationProfile", { id: org.id }))}
                  onDelete={() => toast({ title: "Coming soon", description: "Delete functionality coming soon." })}
                  onInvoice={() => toast({ title: "Coming soon", description: "Billing integration coming soon." })}
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

      <Dialog open={showQuickAdd} onOpenChange={setShowQuickAdd}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Quick Add Profile</DialogTitle>
          </DialogHeader>
          <OrganizationForm
            onSubmit={handleQuickAddSubmit}
            onCancel={() => setShowQuickAdd(false)}
            isSubmitting={createProfileMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={showUpload} onOpenChange={setShowUpload}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload Completed Form</DialogTitle>
          </DialogHeader>
          <UploadApplicationForm
            onSuccess={handleUploadSuccess}
            onCancel={() => setShowUpload(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={showNewApplication} onOpenChange={setShowNewApplication}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Application</DialogTitle>
          </DialogHeader>
          <ComprehensiveApplicationForm
            onSubmit={handleNewApplicationSubmit}
            onCancel={() => setShowNewApplication(false)}
            isSubmitting={createProfileMutation.isPending}
          />
        </DialogContent>
      </Dialog>
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
    </section>
  )
}
