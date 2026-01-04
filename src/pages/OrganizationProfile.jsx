import { useMemo } from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2, BadgeCheck, MapPin, UserCircle, ClipboardList } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { createPageUrl } from "@/utils"
import { getProfile } from "@/api/profiles"

export default function OrganizationProfilePage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const profileId = searchParams.get("id")

  const {
    data: profile,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["profile", profileId],
    queryFn: () => getProfile(profileId),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })

  if (!profileId) {
    return (
      <div className="p-6 md:p-8">
        <div className="mx-auto max-w-4xl">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No profile ID provided. Please select a profile from the Organizations page first.
            </AlertDescription>
          </Alert>
          <div className="mt-4 flex gap-3">
            <Button onClick={() => navigate(createPageUrl("Organizations"))}>← Back to Organizations</Button>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !profile) {
    const message =
      error instanceof Error
        ? error.message
        : "We couldn’t load this profile. It may have been removed or you might not have access."

    return (
      <div className="p-6 md:p-8">
        <div className="mx-auto max-w-4xl space-y-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => navigate(createPageUrl("Organizations"))}>
              ← Back to Organizations
            </Button>
            <Button onClick={() => refetch()}>Try again</Button>
          </div>
        </div>
      </div>
    )
  }

  const sections = Array.isArray(profile.sections) ? profile.sections : []
  const tags = Array.isArray(profile.tags) ? profile.tags : []

  const summary = useMemo(
    () => [
      {
        label: "Profile Type",
        icon: UserCircle,
        value: profile.primary_type ? profile.primary_type.replace(/_/g, " ") : "Not specified",
      },
      {
        label: "Status",
        icon: BadgeCheck,
        value: profile.status ? profile.status.replace(/_/g, " ") : "Not specified",
      },
      {
        label: "Linked Organization",
        icon: MapPin,
        value: profile.organization_name ?? "Not linked to an organization",
      },
      {
        label: "Completed Sections",
        icon: ClipboardList,
        value: `${sections.filter((section) => section?.data && Object.keys(section.data).length).length}/${sections.length}`,
      },
    ],
    [profile.primary_type, profile.status, profile.organization_name, sections],
  )

  const renderValue = (value) => {
    if (value === null || value === undefined || value === "") {
      return <span className="text-slate-400 italic">Not provided</span>
    }

    if (typeof value === "boolean") {
      return <span className={value ? "text-emerald-600 font-medium" : "text-slate-500"}>{value ? "Yes" : "No"}</span>
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return <span className="text-slate-400 italic">None recorded</span>
      return (
        <div className="flex flex-wrap gap-2">
          {value.map((entry, index) => (
            <span key={`${entry}-${index}`} className="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700">
              {String(entry)}
            </span>
          ))}
        </div>
      )
    }

    if (typeof value === "object") {
      return (
        <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
          {JSON.stringify(value, null, 2)}
        </pre>
      )
    }

    return <span className="text-slate-700">{String(value)}</span>
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 md:p-10">
      <div className="mx-auto max-w-5xl space-y-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-slate-900">{profile.display_name ?? "Unnamed profile"}</h1>
            {profile.updated_at ? (
              <p className="text-sm text-slate-500">Last updated {new Date(profile.updated_at).toLocaleString()}</p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => refetch()}>
              Refresh
            </Button>
            <Button variant="ghost" onClick={() => navigate(createPageUrl("Organizations"))}>
              ← Back to Organizations
            </Button>
          </div>
        </div>

        {tags.length ? (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-blue-100 px-3 py-1 text-xs font-medium uppercase tracking-wide text-blue-700"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {summary.map(({ label, value, icon: Icon }) => (
            <Card key={label} className="border border-slate-200 bg-white/80 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-600">
                  <Icon className="h-4 w-4 text-blue-600" />
                  {label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-base font-semibold text-slate-900 capitalize">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="space-y-6">
          {sections.length === 0 ? (
            <Card className="border border-dashed border-slate-300 bg-white/60">
              <CardContent className="py-8 text-center text-sm text-slate-500">
                No structured intake sections have been captured for this profile yet. As information is recorded it will
                appear here grouped by section.
              </CardContent>
            </Card>
          ) : (
            sections.map((section) => {
              const entries = Object.entries(section?.data ?? {})
              if (entries.length === 0) return null

              return (
                <Card key={section.section_key} className="border border-slate-200 bg-white shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg font-semibold text-slate-900 capitalize">
                      {section.section_key.replace(/_/g, " ")}
                    </CardTitle>
                    {section.updated_at ? (
                      <p className="text-xs text-slate-500">
                        Updated {new Date(section.updated_at).toLocaleString()}
                      </p>
                    ) : null}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {entries.map(([field, value]) => (
                      <div key={field} className="grid gap-2 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {field.replace(/_/g, " ")}
                        </span>
                        {renderValue(value)}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}