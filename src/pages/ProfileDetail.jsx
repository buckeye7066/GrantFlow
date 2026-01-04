import React from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, Loader2 } from "lucide-react"
import { getProfile } from "@/api/profiles"
import ProfileOverview from "@/components/profiles/ProfileOverview"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { createPageUrl } from "@/utils"

export default function ProfileDetail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const profileId = searchParams.get("id")

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

        <ProfileOverview profile={profile} billing={profile.billing ?? null} />
      </div>
    </div>
  )
}
