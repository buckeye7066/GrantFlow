import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'

import { matchProfileToOpportunities } from '@/api/matching'
import { AUTO_ADD_SCORE } from '@/lib/matchDisplayThresholds'
import { apiFetch } from '@/api/client'
import { pricingApi } from '@/api/pricing'

async function fetchReadiness(profileId) {
  // Prefer the detailed-readiness endpoint when available (added by the
  // profile-readiness PR), and degrade gracefully when it isn't.
  try {
    return await apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/readiness/detailed`)
  } catch {
    try {
      return await apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/readiness`)
    } catch {
      return null
    }
  }
}

import { AnyaPotentialFundingSummary } from './AnyaPotentialFundingSummary'
import { AnyaFundingMatchCard } from './AnyaFundingMatchCard'
import { buildPotentialFundingSummary } from './anyaResultsFormatters'

/**
 * Anya intake match-results screen.
 *
 * Renders:
 *   - profile summary
 *   - readiness score
 *   - matched funding opportunities with potential amount ranges
 *   - next-step CTAs
 *
 * In the background (no UI), it fires `pricingApi.recommend` so the
 * pricing engine produces an internal quote for admin review. The
 * client-facing "estimate" is only shown when
 * PRICING_SHOW_CLIENT_ESTIMATE=true on the server (the
 * `/api/pricing/my-estimate/:profileId` endpoint enforces this).
 *
 * Props (any may be omitted — falls back to fetching by `profileId`):
 *   profileId            string (required if not passed via location state)
 *   profile              optional pre-loaded profile object
 *   intakeAnswers        optional intake-answer dict
 *   intakeSessionId      optional session id (for pricing recommendation)
 *   onAddToPipeline      optional handler for "Add to pipeline" CTA
 *   onSave               optional handler for "Save for later" CTA
 *   onAsk                optional handler for "Ask Anya about this" CTA
 */
export function AnyaIntakeResults({
  profileId,
  profile = null,
  intakeAnswers = {},
  intakeSessionId = null,
  onAddToPipeline,
  onSave,
  onAsk,
}) {
  const navigate = useNavigate()
  const [matches, setMatches] = useState([])
  const [readiness, setReadiness] = useState(null)
  const [estimate, setEstimate] = useState(null)
  const [loadingMatches, setLoadingMatches] = useState(true)
  const [error, setError] = useState(null)

  const summary = useMemo(() => buildPotentialFundingSummary(matches), [matches])

  // Fetch matches.
  useEffect(() => {
    let cancelled = false
    if (!profileId) {
      setError('No profile id provided')
      setLoadingMatches(false)
      return
    }
    setLoadingMatches(true)
    matchProfileToOpportunities(profileId, { minScore: AUTO_ADD_SCORE, limit: 25 })
      .then((res) => {
        if (cancelled) return
        const list = Array.isArray(res?.opportunities)
          ? res.opportunities
          : Array.isArray(res?.matches)
            ? res.matches
            : Array.isArray(res)
              ? res
              : []
        setMatches(list)
        setError(null)
      })
      .catch((err) => !cancelled && setError(err?.message || String(err)))
      .finally(() => !cancelled && setLoadingMatches(false))
    return () => { cancelled = true }
  }, [profileId])

  // Fetch readiness.
  useEffect(() => {
    if (!profileId) return
    let cancelled = false
    fetchReadiness(profileId)
      .then((r) => !cancelled && setReadiness(r))
      .catch(() => !cancelled && setReadiness(null))
    return () => { cancelled = true }
  }, [profileId])

  // Background pricing recommendation + (gated) client-facing estimate.
  useEffect(() => {
    if (!profileId) return
    let cancelled = false
    pricingApi
      .recommend({
        profile_id: profileId,
        intake_session_id: intakeSessionId,
        intake_answers: intakeAnswers || {},
        profile: profile || {},
        matches,
      })
      .catch(() => { /* background — failures shouldn't block the user */ })
      .finally(() => {
        if (cancelled) return
        pricingApi
          .myEstimate(profileId)
          .then((r) => !cancelled && setEstimate(r))
          .catch(() => !cancelled && setEstimate(null))
      })
    return () => { cancelled = true }
    // intentionally only re-run when match set or profile changes
  }, [profileId, matches, intakeAnswers, profile, intakeSessionId])

  const score = Number(readiness?.readiness_score || 0)
  const status = readiness?.status || (loadingMatches ? 'loading' : 'unknown')

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Here are possible funding matches based on what you shared</CardTitle>
          <CardDescription>
            These are not guaranteed awards, but they appear relevant. I can help you improve your profile or choose which opportunities to pursue.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <ProfileSummary profile={profile} />
          <ReadinessSummary score={score} status={status} />
        </CardContent>
      </Card>

      <AnyaPotentialFundingSummary summary={summary} />

      {error ? (
        <Card>
          <CardContent className="text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {loadingMatches ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">Searching for matches…</CardContent>
          </Card>
        ) : matches.length === 0 ? (
          <Card>
            <CardContent className="space-y-2 py-8 text-center">
              <p className="font-medium">No matches yet — let&apos;s sharpen your profile.</p>
              <p className="text-sm text-muted-foreground">
                Improving readiness usually unlocks more opportunities. Anya can keep asking helpful questions.
              </p>
              <Button onClick={() => navigate(profileId ? `/Profiles?id=${profileId}` : '/Profiles')}>
                Continue improving my profile
              </Button>
            </CardContent>
          </Card>
        ) : (
          matches.map((m) => (
            <AnyaFundingMatchCard
              key={m.id || m.opportunity_id || m.title}
              match={m}
              onView={(match) => match.url && window.open(match.url, '_blank', 'noopener,noreferrer')}
              onSave={onSave}
              onAddToPipeline={onAddToPipeline}
              onAsk={onAsk}
            />
          ))
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Suggested next steps</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{estimateLine(estimate)}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate(profileId ? `/Profiles?id=${profileId}` : '/Profiles')}>
              Continue improving my profile
            </Button>
            <Button variant="secondary" onClick={() => navigate('/Pipeline')}>
              Open my pipeline
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Potential funding amounts are based on published opportunity information and are not guaranteed.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function ProfileSummary({ profile }) {
  if (!profile) {
    return (
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Profile</div>
        <div className="text-sm text-muted-foreground">Profile snapshot pending.</div>
      </div>
    )
  }
  const name = profile.display_name || profile.name || 'New profile'
  const type = profile.primary_type || profile.profile_type || 'Profile'
  const where = [profile.city, profile.state].filter(Boolean).join(', ')
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">Profile</div>
      <div className="text-base font-medium">{name}</div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{type}</Badge>
        {where ? <Badge variant="outline">{where}</Badge> : null}
      </div>
    </div>
  )
}

function ReadinessSummary({ score, status }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Profile readiness</div>
        <Badge variant="outline">{status}</Badge>
      </div>
      <div className="text-3xl font-semibold">{Math.round(score)}/100</div>
      <Progress value={Math.max(0, Math.min(100, score))} />
      <p className="text-xs text-muted-foreground">Higher readiness sharpens future matches.</p>
    </div>
  )
}

function estimateLine(estimate) {
  if (!estimate) return 'Anya is preparing suggested next steps based on your matches.'
  if (estimate.available && estimate.message) return estimate.message
  return estimate.message || 'Dr. White can review your intake and determine the best next-step service option if you want hands-on help.'
}

export default AnyaIntakeResults
