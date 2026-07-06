import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/api/client'
import { useAuthStore, normalizeUserAdmin } from '@/stores/authStore'
import { isGapGateEnabled } from '@/lib/gapGateFlag'
import { hasGuidedTourRunThisSession } from '@/stores/guidedTourStore'
import { persistGapAnswers } from './gapInterviewPersistence'
import {
  planNeedsInterview,
  profilesEndpointFor,
  selectInterviewCandidates,
  snoozeProfile,
  snoozeProfiles,
} from './loginGapInterviewLogic'
import ProfileGapInterview from './ProfileGapInterview'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * LoginGapInterviewLauncher — Anya asks questions at login, globally, for any
 * user, to fill profile gaps.
 *
 * Mounted ONCE in App.jsx. After authentication it:
 *   1. fetches the profiles the current user can access (same endpoint the
 *      profile list uses: GET /api/profiles; admins are capped to directly
 *      linked profiles via ?scope=mine — see loginGapInterviewLogic.js),
 *   2. probes the gap plan (GET /api/profiles/:id/gap-plan) for a small bounded
 *      number of them (first MAX_PROFILES_PER_LOGIN, skipping synthetic
 *      agent:amy profiles and session-snoozed ones),
 *   3. for each profile that still needs questions, presents Anya's interview
 *      (ProfileGapInterview) in a dismissible dialog, ONE profile at a time,
 *      persisting answers through the same merge+PUT path as ProfileGapGate
 *      (shared gapInterviewPersistence.js).
 *
 * NEVER hard-blocks, and closing must never open another dialog:
 *   - "Skip for now" snoozes JUST the current profile (session) and moves to
 *     the next gapped profile, if any.
 *   - A close GESTURE (Escape, the dialog X, outside-click) ends the whole
 *     interview: it snoozes every remaining queued profile for the browser
 *     session and closes. Users were previously trapped walking the entire
 *     profile queue because close was wired to "advance".
 * Snoozes are sessionStorage, so Anya re-asks at the next login — not on
 * every navigation.
 *
 * Enabled by default; kill switch is VITE_GAP_GATE_ENABLED=false (see
 * src/lib/gapGateFlag.js — shared with the ProfileOverview mount).
 *
 * Optional `onFinished` prop: called exactly once when this launcher has
 * nothing left to show — either the user closed it (closedForSession) or it
 * ran out of gapped profiles. Used by ResetOnboardingFlow to sequence
 * video -> gap interview -> guided tour for an existing user being reset;
 * the normal global mount in App.jsx doesn't pass it.
 */
export default function LoginGapInterviewLauncher({ onFinished } = {}) {
  const queryClient = useQueryClient()
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const user = useAuthStore((state) => state.user)
  const guidedCycleTourStatus = useAuthStore((state) => state.guidedCycleTourStatus)
  const isAdmin = normalizeUserAdmin(user)
  // Suppressed for the guided tour's ENTIRE run, and for the rest of the
  // browser tab session it ran in -- a brand-new profile always has gaps, so
  // this would otherwise pop up on top of (or right after) the tour. It's
  // meant to resume on the user's next separate login, not stack the moment
  // the tour finishes within that same first session.
  const enabled = isGapGateEnabled() && isAuthenticated
    && guidedCycleTourStatus !== 'pending'
    && !hasGuidedTourRunThisSession()

  const [gapped, setGapped] = useState(null) // null = not probed yet
  const [index, setIndex] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [closedForSession, setClosedForSession] = useState(false)
  const probedRef = useRef(false)
  const finishedRef = useRef(false)

  // Fire onFinished exactly once, on natural completion (closed, or ran out
  // of gapped profiles). Deliberately does NOT fire just because `enabled`
  // is momentarily false (e.g. auth state still loading) -- that's a
  // transient render, not "finished".
  useEffect(() => {
    if (finishedRef.current || !onFinished) return
    if (!enabled) return
    if (closedForSession) {
      finishedRef.current = true
      onFinished()
      return
    }
    if (gapped !== null && !gapped[index]) {
      finishedRef.current = true
      onFinished()
    }
  }, [enabled, closedForSession, gapped, index, onFinished])

  const userKey = user?.id ?? user?.email ?? 'anon'
  const profilesQuery = useQuery({
    queryKey: ['login-gap-interview', 'profiles', userKey, isAdmin],
    queryFn: () => apiFetch(profilesEndpointFor(isAdmin)),
    enabled,
  })

  const candidates = useMemo(
    () => (profilesQuery.data ? selectInterviewCandidates(profilesQuery.data) : []),
    [profilesQuery.data],
  )

  // Probe gap plans ONCE per app mount (i.e. once per login/page load), one
  // profile at a time, best-effort — a failing probe never blocks the app.
  useEffect(() => {
    if (!enabled || !profilesQuery.isSuccess || probedRef.current) return undefined
    probedRef.current = true
    let cancelled = false
    ;(async () => {
      const found = []
      for (const profile of candidates) {
        if (cancelled) return
        try {
          const plan = await apiFetch(`/api/profiles/${profile.id}/gap-plan`)
          if (planNeedsInterview(plan)) found.push({ profile, plan })
        } catch {
          /* best-effort probe; skip this profile */
        }
      }
      if (!cancelled) setGapped(found)
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, profilesQuery.isSuccess, candidates])

  if (!enabled || closedForSession) return null
  const current = Array.isArray(gapped) ? gapped[index] : null
  if (!current) return null

  const advance = () => setIndex((i) => i + 1)

  // Explicit "Skip for now" button: snooze just this profile, show the next.
  const handleSkip = () => {
    if (submitting) return
    snoozeProfile(current.profile.id)
    advance()
  }

  // Close GESTURE (Escape / X / outside-click): end the whole interview for
  // this session. Snoozing only the current profile here would immediately
  // surface the next profile's dialog — the "trapped in modal cycles" bug.
  const handleClose = () => {
    if (submitting) return
    snoozeProfiles(gapped.slice(index).map((item) => item?.profile?.id))
    setClosedForSession(true)
  }

  const handleSubmit = async (sectionUpdates) => {
    setSubmitting(true)
    try {
      await persistGapAnswers(current.profile.id, sectionUpdates)
      // Refresh anything (e.g. ProfileOverview's ProfileGapGate) reading this plan.
      queryClient.invalidateQueries({ queryKey: ['gap-plan', current.profile.id] })
    } catch {
      // Persist failed — don't trap the user in the dialog; next login re-asks.
    } finally {
      setSubmitting(false)
      advance()
    }
  }

  const profileName = current.profile.display_name || 'this profile'

  return (
    <Dialog open onOpenChange={(open) => { if (!open) handleClose() }}>
      <DialogContent
        className="max-w-lg max-h-[85vh] overflow-y-auto"
        data-testid="login-gap-interview-dialog"
      >
        <DialogHeader>
          <DialogTitle>Anya has a few questions about {profileName}</DialogTitle>
          <DialogDescription>
            Filling these gaps helps Anya match {profileName} to funding that actually fits.
            You can skip for now — she&apos;ll ask again next time you log in.
          </DialogDescription>
        </DialogHeader>
        <ProfileGapInterview
          plan={current.plan}
          submitting={submitting}
          onSubmit={handleSubmit}
          onSkip={handleSkip}
        />
      </DialogContent>
    </Dialog>
  )
}
