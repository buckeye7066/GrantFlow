import React, { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, RefreshCw, Clock, Award, CheckCircle2, X } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { createCrawlerJob } from "@/api/crawlers"
import { apiFetch } from "@/api/client"
import { assertRealProfileId } from "@/api/profileIdGuards"
import { useToast } from "@/components/ui/use-toast"
import { formatDistanceToNow } from "date-fns"

// Delay before refreshing portal check results after queuing a new job,
// to give the server time to process and store initial results.
const PORTAL_CHECK_REFRESH_DELAY_MS = 3000

function normalizeState(value) {
  const v = String(value || "").trim().toUpperCase()
  return v.length === 2 ? v : ""
}

function extractAwardAmount(resultsJson) {
  if (!resultsJson) return ""
  try {
    const parsed = JSON.parse(resultsJson)
    return parsed.awardAmountRaw ? ` \u2014 ${parsed.awardAmountRaw}` : ""
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
        <p className="text-sm font-medium text-emerald-900 truncate">{result.portal_name}</p>
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
          {result.checked_at
            ? formatDistanceToNow(new Date(result.checked_at), { addSuffix: true })
            : ""}
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

export default function StudentPortalsCard({ state, profileId, applications = [] }) {
  const st = normalizeState(state)
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [checking, setChecking] = useState(false)
  const [selectedApplicationIds, setSelectedApplicationIds] = useState({})

  const applicationOptions = useMemo(
    () =>
      (Array.isArray(applications) ? applications : [])
        .filter((application) => application?.id && (application?.name || application?.school_name))
        .map((application) => ({
          id: application.id,
          name: application.name || application.school_name,
        })),
    [applications],
  )

  const mergedAwards = useMemo(
    () =>
      (Array.isArray(applications) ? applications : []).flatMap((application) =>
        (Array.isArray(application?.imported_portal_awards) ? application.imported_portal_awards : []).map((award) => ({
          ...award,
          application_name: application?.name || application?.school_name || "University",
        })),
      ),
    [applications],
  )

  const { data: portalStatus } = useQuery({
    queryKey: ["portal-check-status", profileId],
    queryFn: () =>
      apiFetch(`/api/crawlers/portal-check-results/${profileId}`).then((r) => r.results ?? []),
    enabled: Boolean(profileId),
    staleTime: 60_000,
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
        description: "Checking financial aid portals for new award updates\u2026",
      })
      // Invalidate once at 3 s, then again at 10 s as a fallback for slow jobs
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
      assertRealProfileId(profileId, 'StudentPortalsCard.handleMergeAward')
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
      queryClient.invalidateQueries({ queryKey: ["portal-check-status", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
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

  // Light state-specific enrichment (Anastasia reference is TN).
  if (st === "TN") {
    admissionsAndAid.unshift(
      { label: "TN Student Assistance Corporation (TSAC)", href: "https://www.tn.gov/collegepays.html" },
      { label: "Tennessee Promise", href: "https://www.tn.gov/collegepays/mon-college-pay/tennessee-promise-scholarship.html" },
      { label: "HOPE Scholarship", href: "https://www.tn.gov/collegepays/mon-college-pay/tn-education-lottery-programs/hope-scholarship.html" },
    )
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
                onClick={handleCheckNow}
                disabled={checking}
                className="h-7 gap-1 px-2 text-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
                {checking ? "Checking\u2026" : "Check Now"}
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {detectedAwards.length > 0 && (
          <div className="mb-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
              Detected awards
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
        {mergedAwards.length > 0 ? (
          <div className="mb-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">
              Merged scholarships
            </p>
            <div className="space-y-2">
              {mergedAwards.slice(0, 6).map((award) => (
                <div
                  key={award.id}
                  className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">
                      {award.award_name || award.portal_name}
                    </span>
                    <Badge variant="outline">{award.application_name}</Badge>
                  </div>
                  <div className="mt-1 text-slate-600">
                    {[award.award_amount_raw, award.portal_name].filter(Boolean).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="space-y-5">
          <PortalSection title="Admissions + financial aid" items={admissionsAndAid} />
          <PortalSection title="Standardized testing" items={standardizedTesting} />
          <PortalSection title="Licensure + certification" items={licensureAndCertification} />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Tip: keep these logins handy. Add each university&apos;s direct application, portal, and fee/payment links inside the
          university cards below.
        </p>
      </CardContent>
    </Card>
  )
}
