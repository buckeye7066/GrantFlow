import React, { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Info, Loader2 } from "lucide-react"
import OrganizationCard from "@/components/organizations/OrganizationCard"
import OrganizationFilters from "@/components/organizations/OrganizationFilters"
import OrganizationActions from "@/components/organizations/OrganizationActions"
import OrganizationEmptyState from "@/components/organizations/OrganizationEmptyState"
import { useToast } from "@/components/ui/use-toast"
import { listProfiles } from "@/api/profiles"
import { createPageUrl } from "@/utils"

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
  const { toast } = useToast()
  const navigate = useNavigate()

  const {
    data: profiles = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['profiles'],
    queryFn: listProfiles,
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

  const showComingSoon = (message) => {
    toast({
      title: "Coming soon",
      description: message,
      action: (
        <div className="flex items-center gap-2 text-xs text-blue-600">
          <Info className="w-3 h-3" />
          <span>Tracked in the profiles parity plan.</span>
        </div>
      ),
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
              Manage organizations, students, and individuals seeking funding. Detailed editing tools are in progress as we bring the Base44 workflow into this stack.
            </p>
          </div>
          <OrganizationActions
            onQuickAdd={() => showComingSoon("Quick Add is being rebuilt to use the new comprehensive profile schema.")}
            onUpload={() => showComingSoon("Form upload & parsing is coming back once the document pipeline is wired to the new profiles API.")}
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
            onCreateFirst={() => showComingSoon("The comprehensive application form will be available soon.")}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredOrgs.map((org) => (
                <OrganizationCard
                  key={org.id}
                  organization={org}
                  onEdit={() => showComingSoon("Profile editing is on the roadmap as we migrate to the new schema.")}
                  onDelete={() => showComingSoon("Deletion will return after audit logging is in place.")}
                  onInvoice={() => showComingSoon("Billing integration is being reattached to profiles.")}
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
    </section>
  )
}