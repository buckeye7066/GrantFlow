import React, { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ExternalLink,
  House,
  Leaf,
  Loader2,
  Search,
  ShieldCheck,
  Sun,
  ThermometerSun,
  Wind,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import ProfileSelect from '@/components/shared/ProfileSelect'
import { useToast } from '@/components/ui/use-toast'
import { searchGreenHomePrograms } from '@/api/items'
import { useAuthStore } from '@/stores/authStore'

const UPGRADE_AREAS = [
  { label: 'Weatherization', detail: 'Energy audits, insulation, and air sealing', icon: House },
  { label: 'Heating & cooling', detail: 'Eligible heat-pump or HVAC repair/replacement', icon: ThermometerSun },
  { label: 'Geothermal', detail: 'No-cost geothermal installation when a verified program provides it', icon: Leaf },
  { label: 'Solar & storage', detail: 'No-cost direct installation only, never financing or a tax credit', icon: Sun },
  { label: 'Small home wind', detail: 'No-cost residential wind installation only when explicitly verified', icon: Wind },
]

const EXCLUDED_REASON_LABELS = {
  loan_or_financing: 'Loan or financing required',
  lease_or_ppa: 'Lease or power-purchase agreement',
  tax_credit: 'Tax credit rather than direct help',
  rebate: 'Rebate rather than no-cost installation',
  reimbursement: 'Reimbursement after spending money',
  applicant_payment: 'Applicant payment required',
  cost_share_or_match: 'Match, cost share, or contribution required',
  purchase_required: 'Purchase required first',
  retired_or_rescinded_program: 'Program has ended or been rescinded',
}

const REVIEW_REASON_LABELS = {
  no_cost_not_proven: 'Cost terms were not clear enough to show',
  source_not_yet_verified: 'Source still needs verification',
  official_source_review_stale: 'Official source review needs refreshing',
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function displayKind(program = {}) {
  const kind = String(program.opportunity_kind || '').toLowerCase()
  if (kind === 'directory') return 'Official application path'
  if (kind === 'benefit') return 'Public benefit path'
  if (program.is_pointer === true) return 'Eligibility or provider locator'
  return 'No-cost program'
}

function ProgramCard({ program }) {
  const url = safeExternalUrl(
    program.url || program.application_url || program.source_url || program.info_url,
  )
  const upgradeLabels = Array.isArray(program.upgrades) && program.upgrades.length > 0
    ? program.upgrades
    : Array.isArray(program.matched_green_home_items)
      ? program.matched_green_home_items
      : []
  const eligibility = Array.isArray(program.eligibility_bullets)
    ? program.eligibility_bullets
    : []

  return (
    <Card className="flex h-full flex-col border-emerald-200 bg-white shadow-sm">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="bg-emerald-700 text-white">
            <ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />
            Explicit no-cost path
          </Badge>
          <Badge variant="outline">{displayKind(program)}</Badge>
          <Badge variant="outline">Provider confirms eligibility</Badge>
        </div>
        <div>
          <CardTitle className="text-lg leading-snug text-slate-950">
            {program.title || program.name || 'No-cost green home program'}
          </CardTitle>
          <CardDescription className="mt-1">
            {program.sponsor || program.source || 'Official or reviewed program source'}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="text-sm leading-6 text-slate-700">
          {program.description || program.summary || 'Review the official source for the services available in your area.'}
        </p>

        {program.no_cost_evidence ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-900">Why it is shown</p>
            <p className="mt-1 text-sm text-emerald-950">{program.no_cost_evidence}</p>
          </div>
        ) : null}

        {upgradeLabels.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Possible covered work</p>
            <div className="flex flex-wrap gap-2">
              {upgradeLabels.slice(0, 8).map((upgrade) => (
                <Badge key={upgrade} variant="secondary" className="font-normal">
                  {upgrade}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {eligibility.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Eligibility notes</p>
            <ul className="space-y-1.5 text-sm text-slate-700">
              {eligibility.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-auto pt-2">
          {url ? (
            <Button asChild className="w-full bg-emerald-700 text-white hover:bg-emerald-800">
              <a href={url} target="_blank" rel="noopener noreferrer">
                Open official source
                <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              This record has no usable source link and cannot be acted on yet.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function CountSummary({ title, rows, labels }) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <ul className="mt-2 space-y-1 text-sm text-slate-700">
        {rows.map((row) => (
          <li key={row.reason} className="flex justify-between gap-3">
            <span>{labels[row.reason] || row.reason.replace(/_/g, ' ')}</span>
            <strong>{row.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function GreenHomePrograms() {
  const { toast } = useToast()
  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const user = useAuthStore((state) => state.user)
  const profiles = useAuthStore((state) => state.profiles)
  const initialProfileId = useMemo(() => {
    const candidate = activeProfileId && !['all', '__admin__'].includes(activeProfileId)
      ? activeProfileId
      : user?.active_profile_id || user?.profile_id || profiles?.[0]?.id || ''
    return String(candidate || '')
  }, [activeProfileId, profiles, user])

  const [profileId, setProfileId] = useState(initialProfileId)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!profileId && initialProfileId) setProfileId(initialProfileId)
  }, [initialProfileId, profileId])

  const runSearch = async () => {
    if (!profileId) {
      toast({
        variant: 'destructive',
        title: 'Select a profile',
        description: 'Choose the household or homeowner profile before searching.',
      })
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await searchGreenHomePrograms({ profileId })
      setResult(data)
      if ((data?.programs?.length || 0) === 0) {
        toast({
          title: 'No verified no-cost paths found',
          description: 'Programs with loans, payments, rebates, reimbursements, or unclear cost terms were withheld.',
        })
      }
    } catch (searchError) {
      const message = searchError?.message || 'The green-home search could not be completed.'
      setError(message)
      toast({ variant: 'destructive', title: 'Search failed', description: message })
    } finally {
      setLoading(false)
    }
  }

  const programs = Array.isArray(result?.programs) ? result.programs : []
  const coverageErrors = Array.isArray(result?.search_coverage?.source_errors)
    ? result.search_coverage.source_errors
    : []

  return (
    <main className="space-y-7 px-4 py-6 md:p-8">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-emerald-100 p-3">
            <Leaf className="h-7 w-7 text-emerald-800" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">
              No-Cost Green Home Upgrades
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              Search for programs that may provide energy-saving home improvements without requiring a loan or household payment.
            </p>
          </div>
        </div>
      </header>

      <Alert className="border-emerald-300 bg-emerald-50">
        <ShieldCheck className="h-5 w-5 text-emerald-800" aria-hidden="true" />
        <AlertTitle className="text-emerald-950">Strict no-payment policy</AlertTitle>
        <AlertDescription className="text-emerald-950">
          Primary results exclude loans, financing, leases, power-purchase agreements, tax credits, rebates, reimbursement-only offers, matching funds, cost sharing, required purchases, and homeowner contributions. A provider still makes the final eligibility and project decision.
        </AlertDescription>
      </Alert>

      <section aria-labelledby="green-upgrade-areas">
        <h2 id="green-upgrade-areas" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
          Upgrade areas searched
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {UPGRADE_AREAS.map(({ label, detail, icon: Icon }) => (
            <Card key={label} className="border-slate-200 bg-white">
              <CardContent className="p-4">
                <Icon className="h-5 w-5 text-emerald-700" aria-hidden="true" />
                <p className="mt-2 font-semibold text-slate-900">{label}</p>
                <p className="mt-1 text-xs leading-5 text-slate-600">{detail}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Card className="border-emerald-200">
        <CardHeader>
          <CardTitle className="text-lg">Search for this household</CardTitle>
          <CardDescription>
            GrantFlow uses the selected profile for geography and internal eligibility matching. Sensitive identifiers are not placed in external search queries.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full space-y-2 sm:max-w-md">
            <label htmlFor="green-home-profile" className="text-sm font-medium text-slate-800">
              Household or homeowner profile
            </label>
            <ProfileSelect
              value={profileId}
              onValueChange={(value) => {
                setProfileId(value)
                setResult(null)
                setError(null)
              }}
              showAllOption={false}
              triggerId="green-home-profile"
              ariaLabel="Household or homeowner profile"
              placeholder="Select a profile"
              disabled={loading}
            />
          </div>
          <Button
            type="button"
            onClick={runSearch}
            disabled={loading || !profileId}
            className="gap-2 bg-emerald-700 text-white hover:bg-emerald-800"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />}
            {loading ? 'Searching verified paths…' : 'Find no-cost programs'}
          </Button>
        </CardContent>
      </Card>

      {loading ? (
        <div role="status" aria-live="polite" className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-700" aria-hidden="true" />
          <p className="mt-3 font-medium text-slate-900">Searching official, catalog, and live sources</p>
          <p className="mt-1 text-sm text-slate-600">Every result is checked against the no-loan and no-payment policy before it can appear.</p>
        </div>
      ) : null}

      {error && !loading ? (
        <Alert role="alert" className="border-red-300 bg-red-50">
          <AlertTitle className="text-red-950">The search could not be completed</AlertTitle>
          <AlertDescription className="text-red-900">
            {error} No unavailable source is being counted as a zero-result search.
          </AlertDescription>
        </Alert>
      ) : null}

      {result && !loading ? (
        <section className="space-y-5" aria-labelledby="green-home-results">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="green-home-results" className="text-xl font-bold text-slate-950">
                {programs.length} verified no-cost path{programs.length === 1 ? '' : 's'}
              </h2>
              <p className="mt-1 text-sm text-slate-600">{result.notice}</p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">Occupancy: {result.household?.occupancy || 'unknown'}</Badge>
              {result.household?.state ? <Badge variant="outline">State: {result.household.state}</Badge> : null}
              <Badge variant="outline">Policy: {result.policy_version}</Badge>
            </div>
          </div>

          {result.household?.occupancy === 'renter' ? (
            <Alert className="border-blue-200 bg-blue-50">
              <AlertTitle className="text-blue-950">Renters may also qualify</AlertTitle>
              <AlertDescription className="text-blue-900">
                Some weatherization programs serve renters, but the provider may require landlord permission before work begins.
              </AlertDescription>
            </Alert>
          ) : null}

          {coverageErrors.length > 0 ? (
            <Alert className="border-amber-300 bg-amber-50">
              <AlertTitle className="text-amber-950">Partial source coverage</AlertTitle>
              <AlertDescription className="text-amber-900">
                {coverageErrors.length} source operation{coverageErrors.length === 1 ? '' : 's'} failed. The results below remain usable, but this is not being represented as a complete search.
              </AlertDescription>
            </Alert>
          ) : null}

          {programs.length > 0 ? (
            <div className="grid gap-5 lg:grid-cols-2">
              {programs.map((program, index) => (
                <ProgramCard
                  key={program.id || program.url || program.source_url || `${program.title}-${index}`}
                  program={program}
                />
              ))}
            </div>
          ) : (
            <Card className="border-amber-200 bg-amber-50">
              <CardContent className="p-6">
                <h3 className="font-semibold text-amber-950">No verified no-cost program was available</h3>
                <p className="mt-2 text-sm leading-6 text-amber-900">
                  This does not mean no help exists. It means every result found either required money, relied on a credit or reimbursement, had unclear terms, was no longer active, or still needed source verification.
                </p>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <CountSummary
              title={`${result.review_count || 0} result${result.review_count === 1 ? '' : 's'} withheld for review`}
              rows={result.review_reasons}
              labels={REVIEW_REASON_LABELS}
            />
            <CountSummary
              title={`${result.excluded_count || 0} result${result.excluded_count === 1 ? '' : 's'} excluded by policy`}
              rows={result.excluded_reasons}
              labels={EXCLUDED_REASON_LABELS}
            />
          </div>
        </section>
      ) : null}
    </main>
  )
}
