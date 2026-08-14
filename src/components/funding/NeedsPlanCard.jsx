import React, { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Search } from "lucide-react"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getNeedsPlan } from "@/api/items"

/**
 * NeedsPlanCard — the profile's PREDETERMINED needs list.
 *
 * An organization profile should not have to already know what to ask for. The
 * backend derives a candidate need list from the profile's own type (a research
 * lab gets licensing/biosafety/facility/instrumentation/…, a volunteer fire
 * department gets apparatus/PPE/training/…), and this card turns each open need
 * into a one-click search that reuses the page's existing search path.
 *
 * THREE THINGS THIS CARD MUST NEVER DO, because each has burned this product:
 *
 * 1. Hide a need without saying why. A need the backend suppressed is shown in
 *    an expandable "Already covered" list WITH the profile field and value that
 *    suppressed it, so a wrong suppression is visible and correctable rather
 *    than being a silent disappearance.
 * 2. Present an empty result as an answer. `search_backends.verdict` is
 *    surfaced verbatim: if no web-search backend is configured or the backend
 *    is down, this says so. A zero from a dark backend is not a finding.
 * 3. Invent a score. Nothing here manufactures a percentage or a fit number —
 *    relevance stays the matcher's job, on the result cards.
 */

const BUCKET_EMPTY = []

function NeedChip({ need, onSearch, disabled }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={disabled}
      className="h-auto py-1.5 px-3 text-xs text-left whitespace-normal"
      onClick={() => onSearch(need.search_subject ?? need.label, need)}
      title={need.description || need.label}
    >
      <Search className="h-3 w-3 mr-1.5 shrink-0" aria-hidden="true" />
      <span>{need.label}</span>
      {need.is_capital ? (
        <Badge variant="outline" className="ml-2 text-[10px] px-1 py-0">
          capital
        </Badge>
      ) : null}
    </Button>
  )
}

export default function NeedsPlanCard({ profileId, onSearchNeed = () => {}, searchBackends = null }) {
  const [showSuppressed, setShowSuppressed] = useState(false)
  const [showNotApplicable, setShowNotApplicable] = useState(false)

  const enabled = Boolean(profileId) && profileId !== "all" && profileId !== "__admin__"

  const planQuery = useQuery({
    queryKey: ["needs-plan", profileId],
    queryFn: () => getNeedsPlan({ profileId }),
    enabled,
    staleTime: 5 * 60 * 1000,
  })

  if (!enabled) return null

  if (planQuery.isLoading) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-slate-500">Loading this profile&rsquo;s needs&hellip;</CardContent>
      </Card>
    )
  }

  if (planQuery.isError) {
    // An error is stated, never swallowed into an empty list.
    return (
      <Card>
        <CardContent className="py-6 text-sm text-amber-700 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>Could not load the needs plan: {planQuery.error?.message || "unknown error"}</span>
        </CardContent>
      </Card>
    )
  }

  const plan = planQuery.data ?? {}
  const open = plan.open ?? BUCKET_EMPTY
  const suppressed = plan.suppressed ?? BUCKET_EMPTY
  const notApplicable = plan.not_applicable ?? BUCKET_EMPTY
  const userAdded = plan.user_added ?? BUCKET_EMPTY

  // A person profile has no org needs plan — that is a real answer, not a bug,
  // and it is said plainly instead of rendering an empty card.
  const isNotAnOrg = plan.blueprint?.source === "not_an_organization"

  if (isNotAnOrg && userAdded.length === 0) return null

  const backendWarning = searchBackends?.message ?? null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">What this profile is likely to need</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {isNotAnOrg
                ? "Your own items, ready to search."
                : `Derived from the profile type${plan.primary_type ? ` (${plan.primary_type.replace(/_/g, " ")})` : ""}. Click any need to search it.`}
            </p>
          </div>
          {open.length > 0 ? (
            <Badge variant="outline" className="text-[11px]">
              {open.length} open
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {backendWarning ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{backendWarning}</span>
          </div>
        ) : null}

        {open.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Open needs for this profile">
            {open.map((need) => (
              <NeedChip key={need.code} need={need} onSearch={onSearchNeed} />
            ))}
          </div>
        ) : !isNotAnOrg ? (
          <p className="text-xs text-slate-500">
            Every need in this profile&rsquo;s plan is either already covered or does not apply.
          </p>
        ) : null}

        {userAdded.length > 0 ? (
          <div className="pt-1">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mb-2">
              Your own items
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Needs you added yourself">
              {userAdded.map((need) => (
                <NeedChip key={`${need.origin_field}:${need.label}`} need={need} onSearch={onSearchNeed} />
              ))}
            </div>
          </div>
        ) : null}

        {suppressed.length > 0 ? (
          <div className="pt-1 border-t border-slate-100">
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 pt-3"
              onClick={() => setShowSuppressed((v) => !v)}
              aria-expanded={showSuppressed}
            >
              {showSuppressed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              <span>
                {suppressed.length} need{suppressed.length === 1 ? "" : "s"} hidden because your profile says you
                already have {suppressed.length === 1 ? "it" : "them"}
              </span>
            </button>
            {showSuppressed ? (
              <ul className="mt-2 space-y-1.5 pl-6">
                {suppressed.map((need) => (
                  <li key={need.code} className="text-xs text-slate-600">
                    <span className="font-medium text-slate-800">{need.label}</span>
                    {need.evidence ? (
                      <>
                        {" — from "}
                        <code className="text-[11px] bg-slate-100 px-1 rounded">{need.evidence.field}</code>
                        {need.evidence.value !== true ? `: “${need.evidence.value}”` : ""}
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {showSuppressed ? (
              <p className="mt-2 pl-6 text-[11px] text-slate-500">
                Wrong? Clear that field in the profile and the need comes back.
              </p>
            ) : null}
          </div>
        ) : null}

        {notApplicable.length > 0 ? (
          <div className="pt-1">
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800"
              onClick={() => setShowNotApplicable((v) => !v)}
              aria-expanded={showNotApplicable}
            >
              {showNotApplicable ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {notApplicable.length} need{notApplicable.length === 1 ? "" : "s"} that may not apply to you
              </span>
            </button>
            {showNotApplicable ? (
              <ul className="mt-2 space-y-1.5 pl-6">
                {notApplicable.map((need) => (
                  <li key={need.code} className="text-xs text-slate-500">
                    <span className="font-medium text-slate-700">{need.label}</span>
                    {need.detail ? ` — ${need.detail}` : null}
                    {/* Still searchable on demand: "may not apply" is our
                        inference, and the owner can overrule it. */}
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 ml-2 text-[11px]"
                      onClick={() => onSearchNeed(need.search_subject ?? need.label, need)}
                    >
                      search anyway
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
