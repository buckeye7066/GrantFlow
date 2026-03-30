import React, { useState } from "react"
import { ExternalLink, RefreshCw, CheckCircle2, Clock } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { createCrawlerJob } from "@/api/crawlers"
import { useToast } from "@/components/ui/use-toast"

function normalizeState(value) {
  const v = String(value || "").trim().toUpperCase()
  return v.length === 2 ? v : ""
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

export default function StudentPortalsCard({ state, profileId }) {
  const st = normalizeState(state)
  const { toast } = useToast()
  const [checking, setChecking] = useState(false)
  const [lastChecked, setLastChecked] = useState(null)

  const handleCheckNow = async () => {
    if (!profileId || checking) return
    setChecking(true)
    try {
      await createCrawlerJob({
        type: "portal_check",
        profile_id: profileId,
        parameters: { check_type: "manual", max_portals: 20 },
      })
      setLastChecked(new Date())
      toast({
        title: "Portal check queued",
        description: "Checking financial aid portals for new award updates\u2026",
      })
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
          <CardTitle className="text-base">Student portals</CardTitle>
          {profileId ? (
            <div className="flex items-center gap-2">
              {lastChecked && (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Clock className="h-3.5 w-3.5" />
                  Last checked {lastChecked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
