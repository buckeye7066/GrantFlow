import React from "react"
import { ExternalLink } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

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

export default function StudentPortalsCard({ state }) {
  const st = normalizeState(state)

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
        <CardTitle className="text-base">Student portals</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-5">
          <PortalSection title="Admissions + financial aid" items={admissionsAndAid} />
          <PortalSection title="Standardized testing" items={standardizedTesting} />
          <PortalSection title="Licensure + certification" items={licensureAndCertification} />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Tip: keep these logins handy. Add each university’s direct application, portal, and fee/payment links inside the
          university cards below.
        </p>
      </CardContent>
    </Card>
  )
}

