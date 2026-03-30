import React, { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, RefreshCw, Clock, Award, CheckCircle2, X } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { createCrawlerJob } from "@/api/crawlers"
import { apiFetch } from "@/api/client"
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

function DetectedAwardCard({ result, onConfirm }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <Award className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-emerald-900 truncate">{result.portal_name}</p>
        {result.awards_detected > 0 && (
          <p className="text-xs text-emerald-700">
            Award signal detected{extractAwardAmount(result.results_json)}
          </p>
        )}
        <p className="text-xs text-emerald-600">
          {result.checked_at
            ? formatDistanceToNow(new Date(result.checked_at), { addSuffix: true })
            : ""}
        </p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-emerald-700 hover:bg-emerald-100"
          title="Confirm award"
          onClick={() => {
            onConfirm(result)
            setDismissed(true)
          }}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </Button>
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

export default function StudentPortalsCard({ state, profileId }) {
  const st = normalizeState(state)
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [checking, setChecking] = useState(false)

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
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["portal-check-status", profileId] })
      }, PORTAL_CHECK_REFRESH_DELAY_MS)
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

  const handleConfirmAward = (result) => {
    toast({
      title: "Award confirmed",
      description: `${result.portal_name} award added to your profile pipeline.`,
    })
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
                key={result.portal_url ?? result.portal_name}
                result={result}
                onConfirm={handleConfirmAward}
              />
            ))}
          </div>
        )}
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
