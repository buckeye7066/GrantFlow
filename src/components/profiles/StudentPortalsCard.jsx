import React, { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Award,
  CheckCircle2,
  Clock,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unlink2,
  X,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"

import { apiFetch } from "@/api/client"
import { createCrawlerJob } from "@/api/crawlers"
import { assertRealProfileId } from "@/api/profileIdGuards"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import HamiltonPortalsPanel from "@/components/hamilton/HamiltonPortalsPanel"

const PORTAL_CHECK_REFRESH_DELAY_MS = 3000

const DEFAULT_TSAC_AWARDS_PLACEHOLDER = `[
  {
    "title": "Tennessee HOPE Scholarship",
    "amount": 3500,
    "status": "offered",
    "academic_year": "2026-2027"
  },
  {
    "title": "Tennessee Student Assistance Award",
    "amount": 2000,
    "status": "pending review",
    "academic_year": "2026-2027"
  }
]`

function normalizeState(value) {
  const v = String(value || "").trim().toUpperCase()
  return v.length === 2 ? v : ""
}

function extractAwardAmount(resultsJson) {
  if (!resultsJson) return ""
  try {
    const parsed = JSON.parse(resultsJson)
    return parsed.awardAmountRaw ? ` — ${parsed.awardAmountRaw}` : ""
  } catch {
    return ""
  }
}

function PortalButton({ href, label }) {
  if (!href) return null
  return (
    <Button asChild variant="outline" size="sm" className="justify-start">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink className="mr-2 h-4 w-4" />
        {label}
      </a>
    </Button>
  )
}

function PortalSection({ title, items }) {
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((p) => (
          <PortalButton key={p.label} href={p.href} label={p.label} />
        ))}
      </div>
    </div>
  )
}

function DetectedAwardCard({
  result,
  onMerge,
  selectedApplicationId,
  onSelectApplication,
  applicationOptions,
}) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  const hasExplicitApplication = Boolean(result.application_id || result.merged_application_id)
  const needsSelection = !hasExplicitApplication && applicationOptions.length > 1
  const targetApplicationId = result.application_id || selectedApplicationId || applicationOptions[0]?.id || ""
  const mergeDisabled = !result.merged_to_profile && applicationOptions.length === 0
  return (
    <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <Award className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-emerald-900">{result.portal_name}</p>
        {result.awards_detected > 0 && (
          <p className="text-xs text-emerald-700">
            {result.award_name || "Award signal detected"}
            {result.award_amount_raw ? ` — ${result.award_amount_raw}` : extractAwardAmount(result.results_json)}
          </p>
        )}
        {result.merged_to_profile ? (
          <p className="text-xs text-emerald-700">
            Merged into {result.merged_application_name || "your profile"}.
          </p>
        ) : null}
        {!result.merged_to_profile && applicationOptions.length === 0 ? (
          <p className="text-xs text-amber-700">
            Add a university application first so this scholarship can be merged into the profile.
          </p>
        ) : null}
        <p className="text-xs text-emerald-600">
          Verify the portal inside the pilot import flow below before merging it into the profile.
        </p>
        <p className="text-xs text-emerald-600">
          {result.checked_at ? formatDistanceToNow(new Date(result.checked_at), { addSuffix: true }) : ""}
        </p>
        {needsSelection ? (
          <div className="mt-2">
            <select
              className="h-8 w-full rounded-md border border-emerald-200 bg-white px-2 text-xs text-slate-700"
              value={targetApplicationId}
              onChange={(event) => onSelectApplication(result, event.target.value)}
            >
              <option value="">Choose a school</option>
              {applicationOptions.map((application) => (
                <option key={application.id} value={application.id}>
                  {application.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {result.merged_to_profile ? (
          <Badge variant="secondary" className="bg-emerald-200 text-emerald-900">
            Merged
          </Badge>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-emerald-700 hover:bg-emerald-100"
            title="Merge award"
            disabled={mergeDisabled || (needsSelection && !targetApplicationId)}
            onClick={async () => {
              const merged = await onMerge(result, targetApplicationId)
              if (merged) setDismissed(true)
            }}
          >
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
            Merge
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-slate-500 hover:bg-slate-100"
          title="Dismiss"
          onClick={() => setDismissed(true)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function formatAwardMeta(award) {
  return [
    award.amount_display || "",
    award.status || "",
    award.academic_year || "",
    award.school_name || "",
  ]
    .filter(Boolean)
    .join(" · ")
}

export default function StudentPortalsCard({ state, profileId, applications: profileApplications = [] }) {
  const st = normalizeState(state)
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [checking, setChecking] = useState(false)
  const [selectedApplicationIds, setSelectedApplicationIds] = useState({})
  const [connectOpen, setConnectOpen] = useState(false)
  const [providerId, setProviderId] = useState("tsac")
  const [applicationId, setApplicationId] = useState("")
  const [schoolName, setSchoolName] = useState("")
  const [connectionLabel, setConnectionLabel] = useState("")
  const [portalUrl, setPortalUrl] = useState("https://www.tn.gov/collegepays.html")
  const [awardsPayload, setAwardsPayload] = useState("")
  const [selectedAwardIds, setSelectedAwardIds] = useState({})
  const [mergeTargets, setMergeTargets] = useState({})

  const invalidatePortalQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["portal-check-status", profileId] })
    queryClient.invalidateQueries({ queryKey: ["school-portal-workspace", profileId] })
    queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
  }

  const { data: portalStatus } = useQuery({
    queryKey: ["portal-check-status", profileId],
    queryFn: () =>
      apiFetch(`/api/crawlers/portal-check-results/${profileId}`).then((r) => r.results ?? []),
    enabled: Boolean(profileId),
    staleTime: 60_000,
  })

  const { data: schoolPortalWorkspace } = useQuery({
    queryKey: ["school-portal-workspace", profileId],
    queryFn: () => apiFetch(`/api/profiles/${profileId}/school-portals`),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })

  const applications = schoolPortalWorkspace?.applications ?? (Array.isArray(profileApplications) ? profileApplications : [])
  const connections = schoolPortalWorkspace?.connections ?? []
  const applicationOptions = useMemo(
    () =>
      applications
        .filter((application) => application?.id && (application?.name || application?.school_name))
        .map((application) => ({
          id: application.id,
          name: application.name || application.school_name,
        })),
    [applications],
  )
  const mergedAwards =
    schoolPortalWorkspace?.merged_awards ??
    applications.flatMap((application) =>
      (Array.isArray(application?.imported_portal_awards) ? application.imported_portal_awards : []).map((award) => ({
        ...award,
        application_name: application?.name || application?.school_name || "University",
      })),
    )
  const providers = schoolPortalWorkspace?.providers ?? []

  useEffect(() => {
    if (!connectOpen) return
    if (!applicationId && applications.length === 1) {
      setApplicationId(applications[0].id)
      setSchoolName((current) => current || applications[0].school_name || applications[0].name || "")
    }
  }, [applicationId, applications, connectOpen])

  const createConnectionMutation = useMutation({
    mutationFn: async () => {
      assertRealProfileId(profileId, "StudentPortalsCard.createConnection")
      return apiFetch(`/api/profiles/${profileId}/school-portals/connections`, {
        method: "POST",
        body: JSON.stringify({
          provider_id: providerId,
          application_id: applicationId || null,
          school_name: schoolName || null,
          connection_label: connectionLabel || null,
          portal_url: portalUrl || null,
          awards_payload: awardsPayload,
        }),
      })
    },
    onSuccess: () => {
      toast({
        title: "Portal connected",
        description: "Pilot awards were loaded and are ready for review.",
      })
      setConnectOpen(false)
      setAwardsPayload("")
      setConnectionLabel("")
      invalidatePortalQueries()
    },
    onError: (error) => {
      toast({
        title: "Connect failed",
        description: error?.message || "Unable to load school portal awards.",
        variant: "destructive",
      })
    },
  })

  const mergeMutation = useMutation({
    mutationFn: async ({ connectionId, awardIds, targetApplicationId }) => {
      assertRealProfileId(profileId, "StudentPortalsCard.mergeAwards")
      return apiFetch(`/api/profiles/${profileId}/school-portals/merge`, {
        method: "POST",
        body: JSON.stringify({
          connection_id: connectionId,
          award_ids: awardIds,
          application_id: targetApplicationId || null,
        }),
      })
    },
    onSuccess: (_data, variables) => {
      setSelectedAwardIds((current) => ({ ...current, [variables.connectionId]: [] }))
      toast({
        title: "Awards merged",
        description: "Selected portal scholarships were added to the profile.",
      })
      invalidatePortalQueries()
    },
    onError: (error) => {
      toast({
        title: "Merge failed",
        description: error?.message || "Unable to merge the selected awards.",
        variant: "destructive",
      })
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: async (connectionId) => {
      assertRealProfileId(profileId, "StudentPortalsCard.disconnectConnection")
      return apiFetch(`/api/profiles/${profileId}/school-portals/connections/${connectionId}`, {
        method: "DELETE",
      })
    },
    onSuccess: () => {
      toast({
        title: "Portal disconnected",
        description: "The provider connection was removed. Previously merged awards stay on the profile until you remove them.",
      })
      invalidatePortalQueries()
    },
    onError: (error) => {
      toast({
        title: "Disconnect failed",
        description: error?.message || "Unable to disconnect this provider.",
        variant: "destructive",
      })
    },
  })

  const removeMergedAwardMutation = useMutation({
    mutationFn: async (awardId) => {
      assertRealProfileId(profileId, "StudentPortalsCard.removeMergedAward")
      return apiFetch(`/api/profiles/${profileId}/school-portals/awards/${awardId}`, {
        method: "DELETE",
      })
    },
    onSuccess: () => {
      toast({
        title: "Merged award removed",
        description: "The imported scholarship was removed from the profile and aid pipeline.",
      })
      invalidatePortalQueries()
    },
    onError: (error) => {
      toast({
        title: "Remove failed",
        description: error?.message || "Unable to remove the merged award.",
        variant: "destructive",
      })
    },
  })

  const lastChecked =
    portalStatus && portalStatus.length > 0
      ? new Date(
          portalStatus.reduce((latest, r) =>
            r.checked_at > (latest?.checked_at ?? "") ? r : latest,
          ).checked_at,
        )
      : null

  const detectedAwards = (portalStatus ?? []).filter((r) => r.awards_detected > 0)

  const handleCheckNow = async () => {
    if (!profileId || checking) return
    setChecking(true)
    try {
      await createCrawlerJob({
        type: "portal_check",
        profile_id: profileId,
        parameters: { check_type: "manual", max_portals: 20 },
      })
      toast({
        title: "Portal check queued",
        description: "Checking public portal pages for new award signals…",
      })
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["portal-check-status", profileId] })
      }, PORTAL_CHECK_REFRESH_DELAY_MS)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["portal-check-status", profileId] })
      }, 10_000)
    } catch (err) {
      toast({
        title: "Portal check failed",
        description: err?.message || "Unable to start portal check.",
        variant: "destructive",
      })
    } finally {
      setChecking(false)
    }
  }

  const handleMergeAward = async (result, targetApplicationId) => {
    try {
      assertRealProfileId(profileId, "StudentPortalsCard.handleMergeAward")
      const applicationId = result.application_id || targetApplicationId || applicationOptions[0]?.id || null
      if (!applicationId) {
        toast({
          title: "Choose a school first",
          description: "Select the university that should receive this portal scholarship.",
          variant: "destructive",
        })
        return false
      }
      await apiFetch(`/api/profiles/${profileId}/portal-awards/merge`, {
        method: "POST",
        body: JSON.stringify({
          application_id: applicationId,
          portal_name: result.portal_name,
          portal_url: result.portal_url ?? null,
          award_name: result.award_name ?? result.portal_name,
          award_amount: result.award_amount ?? null,
          award_amount_raw: result.award_amount_raw ?? null,
          detected_at: result.detected_at ?? result.checked_at ?? new Date().toISOString(),
        }),
      })
      invalidatePortalQueries()
      toast({
        title: "Scholarship merged",
        description: `${result.portal_name} was merged into your university funding profile.`,
      })
      return true
    } catch (err) {
      toast({
        title: "Merge failed",
        description: err?.message || "Unable to merge this award into the profile.",
        variant: "destructive",
      })
      return false
    }
  }
  const admissionsAndAid = [
    { label: "FAFSA (Federal Student Aid)", href: "https://studentaid.gov/h/apply-for-aid/fafsa" },
    { label: "FSA ID login", href: "https://studentaid.gov/fsa-id/sign-in/landing" },
    { label: "CSS Profile (College Board)", href: "https://cssprofile.collegeboard.org/" },
    { label: "Scholarship search (BigFuture)", href: "https://bigfuture.collegeboard.org/pay-for-college/scholarship-search" },
    { label: "Scholarship search (Fastweb)", href: "https://www.fastweb.com/" },
    { label: "Common App", href: "https://www.commonapp.org/" },
  ]

  const standardizedTesting = [
    { label: "ACT registration", href: "https://my.act.org/" },
    { label: "SAT (College Board)", href: "https://my.collegeboard.org/" },
    { label: "GRE (ETS)", href: "https://www.ets.org/gre.html" },
    { label: "GMAT (mba.com)", href: "https://www.mba.com/exams/gmat" },
    { label: "LSAT (LSAC)", href: "https://www.lsac.org/lsat" },
    { label: "MCAT (AAMC)", href: "https://mcat.aamc.org/" },
    { label: "TOEFL (ETS)", href: "https://www.ets.org/toefl.html" },
    { label: "IELTS", href: "https://ielts.org/" },
  ]

  const licensureAndCertification = [
    { label: "NCLEX (NCSBN)", href: "https://www.nclex.com/" },
    { label: "NCLEX scheduling (Pearson VUE)", href: "https://home.pearsonvue.com/nclex" },
    { label: "NREMT (EMT/Paramedic)", href: "https://www.nremt.org/" },
    { label: "TEAS (ATI)", href: "https://atitesting.com/teas" },
    { label: "HESI A2 (Elsevier)", href: "https://evolve.elsevier.com/education/" },
  ]

  if (st === "TN") {
    admissionsAndAid.unshift(
      { label: "TN Student Assistance Corporation (TSAC)", href: "https://www.tn.gov/collegepays.html" },
      { label: "Tennessee Promise", href: "https://www.tn.gov/collegepays/mon-college-pay/tennessee-promise-scholarship.html" },
      { label: "HOPE Scholarship", href: "https://www.tn.gov/collegepays/mon-college-pay/tn-education-lottery-programs/hope-scholarship.html" },
    )
  }

  const selectedCounts = useMemo(
    () =>
      Object.fromEntries(
        connections.map((connection) => [connection.id, (selectedAwardIds[connection.id] ?? []).length]),
      ),
    [connections, selectedAwardIds],
  )

  const toggleAwardSelection = (connectionId, awardId, checked) => {
    setSelectedAwardIds((current) => {
      const next = new Set(current[connectionId] ?? [])
      if (checked) next.add(awardId)
      else next.delete(awardId)
      return { ...current, [connectionId]: [...next] }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Student portals</CardTitle>
            {detectedAwards.length > 0 && (
              <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 text-xs">
                {detectedAwards.length} award{detectedAwards.length !== 1 ? "s" : ""} detected
              </Badge>
            )}
          </div>
          {profileId ? (
            <div className="flex items-center gap-2">
              {lastChecked && (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Clock className="h-3.5 w-3.5" />
                  {formatDistanceToNow(lastChecked, { addSuffix: true })}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConnectOpen(true)}
                className="h-7 gap-1 px-2 text-xs"
              >
                <Link2 className="h-3.5 w-3.5" />
                Connect portal
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCheckNow}
                disabled={checking}
                className="h-7 gap-1 px-2 text-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
                {checking ? "Checking…" : "Check Now"}
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <Alert className="border-blue-200 bg-blue-50">
          <ShieldCheck className="h-4 w-4 text-blue-700" />
          <AlertDescription className="text-blue-950">
            <span className="font-semibold">School portal imports are pilot/manual-import only right now.</span>{" "}
            GrantFlow does not perform live TSAC sign-in in this release. Paste provider award JSON that you exported or copied from the portal, then review and merge only the records you trust. Raw passwords are never requested or stored.
          </AlertDescription>
        </Alert>

        {applications.length === 0 && (
          <Alert>
            <AlertDescription>
              Add a university below before merging imported portal scholarships so GrantFlow knows which school profile should receive them.
            </AlertDescription>
          </Alert>
        )}

        {connections.length > 0 && (
          <div className="space-y-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Connected provider imports
            </div>
            {connections.map((connection) => {
              const selectedForConnection = selectedAwardIds[connection.id] ?? []
              const mergeTarget =
                mergeTargets[connection.id] ?? connection.default_application_id ?? (applications.length === 1 ? applications[0].id : "")
              return (
                <div key={connection.id} className="rounded-lg border border-slate-200 p-4 space-y-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-900">
                          {connection.provider_name}
                          {connection.connection_label ? ` — ${connection.connection_label}` : ""}
                        </p>
                        <Badge variant="outline" className="text-[11px] uppercase tracking-wide">
                          {connection.integration_mode.replaceAll("_", " ")}
                        </Badge>
                      </div>
                      <p className="text-xs text-slate-600">
                        {connection.school_name || "School not specified"}
                        {connection.portal_url ? ` · ${connection.portal_url}` : ""}
                      </p>
                      {connection.last_synced_at && (
                        <p className="text-xs text-slate-500">
                          Loaded {formatDistanceToNow(new Date(connection.last_synced_at), { addSuffix: true })}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="justify-start text-slate-600"
                      onClick={() => disconnectMutation.mutate(connection.id)}
                      disabled={disconnectMutation.isPending}
                    >
                      <Unlink2 className="mr-2 h-4 w-4" />
                      Disconnect
                    </Button>
                  </div>

                  {connection.limitations?.length > 0 && (
                    <p className="text-xs text-amber-700">
                      {connection.limitations[0]}
                    </p>
                  )}

                  <div className="flex flex-col gap-3 md:flex-row md:items-center">
                    <div className="min-w-[220px] space-y-1">
                      <Label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Merge into university
                      </Label>
                      <Select
                        value={mergeTarget}
                        onValueChange={(value) => setMergeTargets((current) => ({ ...current, [connection.id]: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a school" />
                        </SelectTrigger>
                        <SelectContent>
                          {applications.map((application) => (
                            <SelectItem key={application.id} value={application.id}>
                              {application.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      onClick={() =>
                        mergeMutation.mutate({
                          connectionId: connection.id,
                          awardIds: selectedForConnection,
                          targetApplicationId: mergeTarget,
                        })
                      }
                      disabled={selectedForConnection.length === 0 || mergeMutation.isPending}
                      className="md:mt-5"
                    >
                      {mergeMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Merging…
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          Merge {selectedCounts[connection.id] || 0} award
                          {(selectedCounts[connection.id] || 0) === 1 ? "" : "s"}
                        </>
                      )}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    {connection.available_awards?.map((award) => {
                      const isSelected = selectedForConnection.includes(award.id)
                      return (
                        <div
                          key={award.id}
                          className={`flex items-start gap-3 rounded-md border p-3 ${
                            award.already_merged ? "border-emerald-200 bg-emerald-50" : "border-slate-200"
                          }`}
                        >
                          <Checkbox
                            checked={isSelected}
                            disabled={award.already_merged}
                            onCheckedChange={(checked) => toggleAwardSelection(connection.id, award.id, checked === true)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium text-slate-900">{award.title}</p>
                              {award.already_merged && (
                                <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Merged</Badge>
                              )}
                            </div>
                            <p className="text-xs text-slate-600">{formatAwardMeta(award) || "No provider metadata"}</p>
                            {award.description && <p className="mt-1 text-xs text-slate-500">{award.description}</p>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {mergedAwards.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Merged/imported scholarships
            </div>
            <div className="space-y-2">
              {mergedAwards.map((award) => (
                <div key={`${award.application_id}-${award.id}`} className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
                  <Award className="mt-0.5 h-4 w-4 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-slate-900">{award.title}</p>
                      <Badge variant="outline">{award.provider_name}</Badge>
                    </div>
                    <p className="text-xs text-slate-600">
                      {award.application_name || "Profile"} · {formatAwardMeta(award) || "Imported portal award"}
                    </p>
                    <p className="text-xs text-slate-500">
                      Source: {award.source_metadata?.portal_url || award.portal_url || award.source_url || "Portal import"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeMergedAwardMutation.mutate(award.id)}
                    disabled={removeMergedAwardMutation.isPending}
                    className="text-slate-500"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {detectedAwards.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
              Detected public portal signals
            </p>
            {detectedAwards.map((result) => (
              <DetectedAwardCard
                key={result.id ?? result.portal_url ?? result.portal_name}
                result={result}
                onMerge={handleMergeAward}
                selectedApplicationId={selectedApplicationIds[result.id ?? result.portal_url ?? result.portal_name] ?? ""}
                onSelectApplication={(awardResult, nextApplicationId) =>
                  setSelectedApplicationIds((current) => ({
                    ...current,
                    [awardResult.id ?? awardResult.portal_url ?? awardResult.portal_name]: nextApplicationId,
                  }))
                }
                applicationOptions={applicationOptions}
              />
            ))}
          </div>
        )}
        <div className="space-y-5">
          <PortalSection title="Admissions + financial aid" items={admissionsAndAid} />
          <PortalSection title="Standardized testing" items={standardizedTesting} />
          <PortalSection title="Licensure + certification" items={licensureAndCertification} />
        </div>
        <p className="text-xs text-slate-500">
          Tip: keep these logins handy. Add each university&apos;s direct application, portal, and fee/payment links inside the
          university cards below.
        </p>
        {/* Yana — student-portal records & funding-opportunity portal links. */}
        <HamiltonPortalsPanel profileId={profileId} />
      </CardContent>

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connect a school portal</DialogTitle>
            <DialogDescription>
              Pilot/manual-import only. Paste scholarship/funding records copied from the provider portal to load them into GrantFlow for review.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select
                  value={providerId}
                  onValueChange={(value) => {
                    setProviderId(value)
                    if (value === "tsac") setPortalUrl("https://www.tn.gov/collegepays.html")
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.length > 0
                      ? providers.map((provider) => (
                          <SelectItem key={provider.id} value={provider.id}>
                            {provider.name}
                          </SelectItem>
                        ))
                      : (
                        <SelectItem value="tsac">Tennessee Student Assistance Corporation (TSAC)</SelectItem>
                      )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Default university</Label>
                <Select value={applicationId} onValueChange={setApplicationId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a school (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {applications.map((application) => (
                      <SelectItem key={application.id} value={application.id}>
                        {application.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="school-portal-school-name">School name</Label>
                <Input
                  id="school-portal-school-name"
                  value={schoolName}
                  onChange={(event) => setSchoolName(event.target.value)}
                  placeholder="Middle Tennessee State University"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="school-portal-label">Portal/account label</Label>
                <Input
                  id="school-portal-label"
                  value={connectionLabel}
                  onChange={(event) => setConnectionLabel(event.target.value)}
                  placeholder="TSAC student portal"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="school-portal-url">Portal URL</Label>
              <Input
                id="school-portal-url"
                value={portalUrl}
                onChange={(event) => setPortalUrl(event.target.value)}
                placeholder="https://www.tn.gov/collegepays.html"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="school-portal-awards">Award JSON</Label>
              <Textarea
                id="school-portal-awards"
                rows={12}
                value={awardsPayload}
                onChange={(event) => setAwardsPayload(event.target.value)}
                placeholder={DEFAULT_TSAC_AWARDS_PLACEHOLDER}
              />
              <p className="text-xs text-slate-500">
                Paste an array of award objects with fields like <code>title</code>, <code>amount</code>, <code>status</code>, and <code>academic_year</code>. This pilot import does not request or store raw portal passwords.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setConnectOpen(false)} disabled={createConnectionMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => createConnectionMutation.mutate()}
              disabled={!awardsPayload.trim() || createConnectionMutation.isPending}
            >
              {createConnectionMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading awards…
                </>
              ) : (
                "Connect & load awards"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
