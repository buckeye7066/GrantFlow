import React from "react"
import { ExternalLink, FlaskConical, HeartPulse, Info, Loader2, MapPin } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { openWithHamiltonWatching } from "@/components/hamilton/hamiltonWatchedOpen"

function normalizeState(value) {
  const v = String(value || "").trim().toUpperCase()
  return v.length === 2 ? v : ""
}

function normalizeConditionNames(conditions) {
  if (!conditions) return []
  if (Array.isArray(conditions)) {
    return conditions
      .map((entry) => {
        if (!entry) return ""
        if (typeof entry === "string") return entry
        if (typeof entry === "object" && typeof entry.name === "string") return entry.name
        return ""
      })
      .map((s) => String(s).trim())
      .filter(Boolean)
  }
  if (typeof conditions === "string") {
    return conditions
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

// With a profileId, resources open through Hamilton's WATCHED secure window
// (session captured for the profile — see hamiltonWatchedOpen.js); without
// one it stays a plain new-tab link. Popup must open inside the click gesture,
// so openWithHamiltonWatching is called directly from onClick with no awaits.
function PortalButton({ href, label, profileId }) {
  const { toast } = useToast()
  const [opening, setOpening] = React.useState(false)
  if (!href) return null
  if (profileId) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-start"
        disabled={opening}
        title={`Open ${label} with Hamilton watching`}
        onClick={() => {
          setOpening(true)
          openWithHamiltonWatching({ profileId, url: href, label, toast }).finally(() => setOpening(false))
        }}
      >
        {opening ? <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ExternalLink className="mr-2 h-4 w-4" />}
        {label}
      </Button>
    )
  }
  return (
    <Button asChild variant="outline" size="sm" className="justify-start">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink className="mr-2 h-4 w-4" />
        {label}
      </a>
    </Button>
  )
}

function PortalSection({ title, icon: Icon, items, helper, profileId }) {
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {Icon ? <Icon className="h-4 w-4 text-slate-600" /> : null}
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</div>
      </div>
      {helper ? <p className="text-xs text-slate-600">{helper}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((p) => (
          <PortalButton key={`${p.label}-${p.href}`} href={p.href} label={p.label} profileId={profileId} />
        ))}
      </div>
    </div>
  )
}

function buildClinicalTrialsLinks({ conditions, state }) {
  const st = normalizeState(state)
  const names = normalizeConditionNames(conditions).slice(0, 3)
  if (names.length === 0) {
    // General search page.
    return [
      {
        label: st ? `ClinicalTrials.gov (near ${st})` : "ClinicalTrials.gov (search)",
        href: st
          ? `https://clinicaltrials.gov/search?locStr=${encodeURIComponent(st)}`
          : "https://clinicaltrials.gov/search",
      },
    ]
  }

  return names.map((name) => {
    const base = "https://clinicaltrials.gov/search"
    const params = new URLSearchParams()
    params.set("cond", name)
    if (st) params.set("locStr", st)
    return {
      label: st ? `Trials for ${name} (near ${st})` : `Trials for ${name}`,
      href: `${base}?${params.toString()}`,
    }
  })
}

export default function HealthResourcesCard({
  state,
  conditions,
  supportNeeds,
  consentForStudies,
  onEditHealth,
  onToggleStudyConsent,
  consentSaving = false,
  isOrganization = false,
  profileId = null,
}) {
  // Defense in depth: personal patient-assistance content (copay help, clinical
  // trials matched to "conditions in your medical profile") is for an individual
  // person, never an organization — even if a disability flag is captured on the
  // org record. ProfileDetail already hides the Health tab for orgs; if this card
  // is ever rendered for an org anyway, show org-appropriate content only.
  if (isOrganization) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-slate-700" />
            Health &amp; disability-focused funding
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            Personal patient-assistance resources (copay help, clinical-trial matching, etc.) apply to an
            individual person, not an organization. For an organization that serves people with health or
            disability needs, use the funding discovery and pipeline tools to find disability- and
            health-focused grants. Capture the populations you serve under Programs &amp; Services and
            Story &amp; Goals so those opportunities surface.
          </p>
        </CardContent>
      </Card>
    )
  }

  const st = normalizeState(state)
  const conditionNames = normalizeConditionNames(conditions)
  const conditionBlob = conditionNames.join(" ").toLowerCase()
  const support = Array.isArray(supportNeeds)
    ? supportNeeds.map((s) => String(s || "").trim()).filter(Boolean)
    : []
  const supportBlob = support.join(" ").toLowerCase()

  const hasCancer =
    conditionBlob.includes("cancer") || conditionBlob.includes("oncology") || conditionBlob.includes("tumor")
  const hasKidney =
    conditionBlob.includes("kidney") || conditionBlob.includes("dialysis") || conditionBlob.includes("renal")
  const hasHiv = conditionBlob.includes("hiv") || conditionBlob.includes("aids")
  const hasTbi = conditionBlob.includes("tbi") || conditionBlob.includes("brain injury")
  const hasEpilepsy = conditionBlob.includes("epilepsy") || conditionBlob.includes("seizure")
  const hasNeurodivergent = conditionBlob.includes("autism") || conditionBlob.includes("adhd") || conditionBlob.includes("neurodiv")

  const wantsTransport =
    supportBlob.includes("transport") ||
    supportBlob.includes("mobility") ||
    supportBlob.includes("appointment") ||
    support.some((v) => v.toLowerCase() === "transportation")

  const transportation = [
    { label: "NeedyMeds: transportation assistance", href: "https://www.needymeds.org/free_non_profit_clinics.taf?_function=transportation" },
    { label: "211.org (local help, incl. transportation)", href: "https://www.211.org/" },
    ...(hasCancer
      ? [{ label: "American Cancer Society: rides to treatment", href: "https://www.cancer.org/support-programs-and-services/road-to-recovery.html" }]
      : []),
  ]

  const financialAid = [
    { label: "NeedyMeds (patient assistance)", href: "https://www.needymeds.org/" },
    { label: "Patient Advocate Foundation (case management)", href: "https://www.patientadvocate.org/" },
    { label: "HealthWell Foundation (copay assistance)", href: "https://www.healthwellfoundation.org/" },
    { label: "PAN Foundation (copay assistance)", href: "https://www.panfoundation.org/" },
    ...(hasKidney ? [{ label: "American Kidney Fund (financial help)", href: "https://www.kidneyfund.org/" }] : []),
    ...(hasHiv ? [{ label: "AIDS United (resources)", href: "https://aidsunited.org/" }] : []),
    ...(hasEpilepsy ? [{ label: "Epilepsy Foundation (resources)", href: "https://www.epilepsy.com/" }] : []),
  ]

  const education = [
    { label: "NIH MedlinePlus (patient education)", href: "https://medlineplus.gov/" },
    { label: "CDC (health information)", href: "https://www.cdc.gov/" },
    ...(hasCancer ? [{ label: "NCI (cancer information)", href: "https://www.cancer.gov/" }] : []),
    ...(hasNeurodivergent
      ? [
          { label: "Autism Society (resources)", href: "https://autismsociety.org/" },
          { label: "ASAN (self-advocacy)", href: "https://autisticadvocacy.org/" },
        ]
      : []),
    ...(hasTbi ? [{ label: "CDC: traumatic brain injury", href: "https://www.cdc.gov/traumaticbraininjury/index.html" }] : []),
  ]

  const research = [
    ...buildClinicalTrialsLinks({ conditions, state: st }),
    { label: "ResearchMatch (volunteer registry)", href: "https://www.researchmatch.org/" },
  ]

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <HeartPulse className="h-5 w-5 text-slate-700" />
          Health resources
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-5">
          <PortalSection
            title="Transportation to care"
            icon={MapPin}
            items={transportation}
            profileId={profileId}
            helper={
              wantsTransport
                ? "Based on your profile, transportation support appears relevant. These are informational resources."
                : "Informational resources for getting to medical appointments."
            }
          />

          <PortalSection
            title="Financial assistance"
            icon={Info}
            items={financialAid}
            profileId={profileId}
            helper="These organizations offer support programs (copay help, case management, or assistance navigation)."
          />

          <PortalSection
            title="Education resources"
            icon={Info}
            items={education}
            profileId={profileId}
            helper="Reliable, non-commercial health education sources (informational only)."
          />

          {/* Clinical-trials / research-studies OPT-IN. A direct, explained
              toggle — participation is the user's choice. Default OFF; nothing
              about studies is shown or fetched until this is turned on. */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-start gap-3">
              <FlaskConical className="h-5 w-5 text-slate-700 mt-0.5" />
              <div className="flex-1">
                <div className="flex items-start justify-between gap-3">
                  <Label htmlFor="consent-studies" className="text-sm font-semibold text-slate-900 cursor-pointer">
                    Show me clinical trials &amp; research studies
                  </Label>
                  {onToggleStudyConsent ? (
                    <Switch
                      id="consent-studies"
                      checked={Boolean(consentForStudies)}
                      disabled={consentSaving}
                      onCheckedChange={(next) => onToggleStudyConsent(Boolean(next))}
                      aria-label="Opt in to clinical trials and research studies"
                    />
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  When ON, GrantFlow shows currently-recruiting clinical trials and research studies that match the
                  conditions in your medical profile (early-phase studies included). This is <strong>optional and entirely
                  your choice</strong>: GrantFlow only shows you the listings with their official ClinicalTrials.gov links —
                  it never enrolls you, never submits anything, and never shares your medical information. You decide whether
                  to contact or join any study, and the study team determines eligibility.
                </p>
                {/* Fallback for contexts without the inline toggle handler. */}
                {!onToggleStudyConsent && onEditHealth ? (
                  <div className="mt-3">
                    <Button variant="outline" size="sm" onClick={onEditHealth}>
                      Update consent in Health &amp; Medical
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {consentForStudies ? (
            <PortalSection
              title="Research opportunities (opted in)"
              icon={FlaskConical}
              items={research}
              profileId={profileId}
              helper="Informational only. ClinicalTrials listings are external and eligibility is determined by study teams."
            />
          ) : null}
        </div>

        <p className="mt-4 text-xs text-slate-600">
          Note: GrantFlow provides informational resources and listings only. It does not provide medical advice or diagnosis/treatment recommendations.
          {st ? ` (State: ${st})` : ""}
        </p>
      </CardContent>
    </Card>
  )
}

