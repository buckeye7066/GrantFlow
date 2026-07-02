import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/api/client'
import { useAuthStore, normalizeUserAdmin } from '@/stores/authStore'
import { isGapGateEnabled } from '@/lib/gapGateFlag'
import { persistGapAnswers } from './gapInterviewPersistence'
import {
  planNeedsInterview,
  profilesEndpointFor,
  selectInterviewCandidates,
  snoozeProfile,
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
 * NEVER hard-blocks: "Skip for now", the dialog X, and outside-click all
 * dismiss. Dismissing snoozes that profile for the browser SESSION
 * (sessionStorage), so it re-asks at the next login — not on every navigation.
 *
 * Enabled by default; kill switch is VITE_GAP_GATE_ENABLED=false (see
 * src/lib/gapGateFlag.js — shared with the ProfileOverview mount).
 */
export default function LoginGapInterviewLauncher() {
  const queryClient = useQueryClient()
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const user = useAuthStore((state) => state.user)
  const isAdmin = normalizeUserAdmin(user)
  const enabled = isGapGateEnabled() && isAuthenticated

  const [gapped, setGapped] = useState(null) // null = not probed yet
  const [index, setIndex] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const probedRef = useRef(false)

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

  if (!enabled) return null
  const current = Array.isArray(gapped) ? gapped[index] : null
  if (!current) return null

  const advance = () => setIndex((i) => i + 1)

  const handleDismiss = () => {
    if (submitting) return
    // Session snooze: re-ask at the next login, not on the next navigation.
    snoozeProfile(current.profile.id)
    advance()
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
    <Dialog open onOpenChange={(open) => { if (!open) handleDismiss() }}>
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
          onSkip={handleDismiss}
        />
      </DialogContent>
    </Dialog>
  )
}
