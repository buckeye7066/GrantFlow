import React from 'react'
import { toast } from '@/components/ui/use-toast'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import RobertRecommendationDetailsModal from './RobertRecommendationDetailsModal'

/**
 * RobertRecommendationListener
 * ----------------------------
 * Robert's per-profile recommendation queue. The listener:
 *   1. Waits until auth state is loaded AND `activeProfileId` is known
 *      (skipped for the admin sentinel `__admin__`).
 *   2. Fetches pending recommendations on login + whenever the active
 *      profile changes.
 *   3. Polls /api/robert/recommendations/stream?since=... for new ones
 *      while the user is logged in. Falls back to the same endpoint
 *      with no `since` if the server doesn't honor it.
 *   4. Shows ONE toast at a time per recommendation, dedup'd by id, with
 *      [View Details] / [Yes, Add to Pipeline] / [No, Keep in Resources].
 *   5. Closes its polling interval on logout.
 *
 * Mounted once near the authenticated app shell — see src/pages/Layout.jsx.
 *
 * Robert NEVER auto-adds opportunities to a pipeline; the user must click.
 */

const DEFAULT_POLL_INTERVAL_MS = 30_000
const MAX_TOASTS_PER_POLL = 2

export default function RobertRecommendationListener() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const activeProfileId = useAuthStore((s) => s.activeProfileId)

  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const [detailsRecommendation, setDetailsRecommendation] = React.useState(null)
  const shownRef = React.useRef(new Set())
  const sinceRef = React.useRef(null)
  const intervalRef = React.useRef(null)

  React.useEffect(() => {
    // Reset between profiles so toasts don't bleed across profile switches.
    shownRef.current = new Set()
    sinceRef.current = null
  }, [activeProfileId])

  React.useEffect(() => {
    if (!isAuthenticated) {
      shownRef.current.clear()
      sinceRef.current = null
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
      return undefined
    }
    if (!activeProfileId || activeProfileId === '__admin__') return undefined

    let cancelled = false

    async function pollOnce({ initial = false } = {}) {
      try {
        const search = new URLSearchParams({ active_profile_id: activeProfileId })
        if (sinceRef.current && !initial) search.set('since', sinceRef.current)
        const data = await apiFetch(`/api/robert/recommendations/stream?${search.toString()}`)
        if (cancelled) return
        const items = Array.isArray(data?.recommendations) ? data.recommendations : []
        if (data?.poll_interval_ms && intervalRef.current) {
          // server-suggested cadence wins
          const desired = Math.max(5000, Number(data.poll_interval_ms) || DEFAULT_POLL_INTERVAL_MS)
          // re-arm interval with fresh cadence
          clearInterval(intervalRef.current)
          intervalRef.current = setInterval(pollOnce, desired)
          if (typeof intervalRef.current.unref === 'function') intervalRef.current.unref()
        }
        sinceRef.current = data?.server_time || new Date().toISOString()
        let shownCount = 0
        for (const rec of items) {
          if (cancelled) return
          if (shownCount >= MAX_TOASTS_PER_POLL) break
          if (!rec?.id) continue
          if (shownRef.current.has(rec.id)) continue
          // Filter: skip already accepted/declined/expired (defense in depth)
          if (['accepted', 'declined', 'expired', 'superseded'].includes(rec.recommendation_status)) continue
          shownRef.current.add(rec.id)
          shownCount += 1
          showRecommendationToast(rec, { setDetailsOpen, setDetailsRecommendation })
          // Tell the server we delivered this one (live).
          apiFetch(`/api/robert/recommendations/${encodeURIComponent(rec.id)}/delivered`, {
            method: 'POST',
            body: JSON.stringify({ via: 'live' }),
          }).catch(() => {})
        }
      } catch {
        // Best-effort: any auth/network blip is swallowed silently.
      }
    }

    // Immediate fetch on mount (login or active-profile change).
    pollOnce({ initial: true })
    intervalRef.current = setInterval(pollOnce, DEFAULT_POLL_INTERVAL_MS)
    if (typeof intervalRef.current.unref === 'function') intervalRef.current.unref()
    return () => {
      cancelled = true
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    }
  }, [isAuthenticated, activeProfileId])

  return (
    <RobertRecommendationDetailsModal
      open={detailsOpen}
      recommendation={detailsRecommendation}
      onClose={() => setDetailsOpen(false)}
      onAfterAccept={(id) => { shownRef.current.add(id); setDetailsOpen(false) }}
      onAfterDecline={(id) => { shownRef.current.add(id); setDetailsOpen(false) }}
    />
  )
}

function showRecommendationToast(rec, { setDetailsOpen, setDetailsRecommendation }) {
  // REVIEW rows are research leads (directory / prior-award pointers): never
  // offer add-to-pipeline; the API refuses it anyway (409).
  const isResearchLead = String(rec.match_decision || '').toUpperCase() === 'REVIEW'
  toast({
    id: `robert-rec-${rec.id}`,
    title: rec.toast_title || 'Robert found a possible funding source',
    description: rec.toast_body || 'A new funding opportunity may match this profile.',
    duration: 18_000,
    action: (
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={async (e) => {
            e?.preventDefault?.()
            try {
              await apiFetch(`/api/robert/recommendations/${encodeURIComponent(rec.id)}/viewed`, { method: 'POST' })
            } catch { /* best-effort */ }
            setDetailsRecommendation(rec)
            setDetailsOpen(true)
          }}
        >
          View Details
        </Button>
        {!isResearchLead && (
          <Button
            size="sm"
            onClick={async (e) => {
              e?.preventDefault?.()
              try {
                const result = await apiFetch(
                  `/api/robert/recommendations/${encodeURIComponent(rec.id)}/accept`,
                  { method: 'POST' },
                )
                toast({
                  id: `robert-rec-accepted-${rec.id}`,
                  title: 'Added to pipeline.',
                  description: result?.pipeline?.saved
                    ? 'Robert added it to this profile\'s pipeline.'
                    : 'Robert recorded the decision; check Discover Grants for confirmation.',
                  duration: 8000,
                })
              } catch (err) {
                toast({
                  id: `robert-rec-accept-failed-${rec.id}`,
                  variant: 'destructive',
                  title: 'Could not add to pipeline.',
                  description: err?.message || 'Try again from Discover Grants.',
                  duration: 8000,
                })
              }
            }}
          >
            Yes, Add to Pipeline
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={async (e) => {
            e?.preventDefault?.()
            try {
              await apiFetch(`/api/robert/recommendations/${encodeURIComponent(rec.id)}/decline`, { method: 'POST' })
              toast({
                id: `robert-rec-declined-${rec.id}`,
                title: 'Kept in general resources.',
                description: 'Robert won\'t suggest this opportunity for this profile again.',
                duration: 6000,
              })
            } catch { /* best-effort */ }
          }}
        >
          No, Keep in Resources
        </Button>
      </div>
    ),
  })
}
