import React from 'react'
import { toast } from '@/components/ui/use-toast'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { scoreToMatchLabel } from '@/lib/matchDisplayThresholds'

/**
 * AnyaMatchScoutAlerts
 * --------------------
 * Polls `/api/anya/match-suggestions/pending` once after login and again
 * every 5 minutes. For each pending suggestion it has not already shown
 * THIS browser session, it pops a friendly toast with two buttons:
 *
 *   [Add to Pipeline]    → POST /api/anya/match-suggestions/:id/accept
 *   [Not right now]      → POST /api/anya/match-suggestions/:id/dismiss
 *
 * Hard rules:
 *   - Never auto-adds. Both actions require a user click.
 *   - Caps at 2 toasts per poll so a fresh login does not avalanche.
 *   - Tracks shown ids in a session-only Set so dismissing the toast
 *     (without action) does not re-fire on the next poll. The server
 *     still keeps the row pending so the notification bell shows it.
 *   - Silent on errors — this is best-effort discovery UX.
 *
 * Mounted exactly once, in `src/pages/Layout.jsx`.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes — same cadence as NotificationBell
const MAX_TOASTS_PER_POLL = 2

function formatProfileLabel(suggestion) {
  return suggestion?.profile_name || 'this profile'
}

export default function AnyaMatchScoutAlerts() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  // Session-only "already shown" cache. A page reload re-shows toasts for
  // still-pending suggestions, which is fine — the user may have ignored
  // the first toast. The bell + dedupe by id prevent duplicate stacking.
  const shownRef = React.useRef(new Set())

  React.useEffect(() => {
    if (!isAuthenticated) return undefined
    let cancelled = false

    async function poll() {
      try {
        const data = await apiFetch('/api/anya/match-suggestions/pending')
        if (cancelled) return
        if (data?.muted) return
        const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : []
        let shownThisPoll = 0
        for (const suggestion of suggestions) {
          if (cancelled) return
          if (shownThisPoll >= MAX_TOASTS_PER_POLL) break
          if (!suggestion?.id) continue
          if (shownRef.current.has(suggestion.id)) continue
          shownRef.current.add(suggestion.id)
          shownThisPoll += 1
          showSuggestionToast(suggestion)
        }
      } catch {
        // Best-effort: any network/auth blip is silently swallowed.
      }
    }

    poll()
    const handle = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [isAuthenticated])

  return null
}

function showSuggestionToast(suggestion) {
  const rawScore = Number(suggestion.match_score)
  const hasScore = Number.isFinite(rawScore)
  const matchLabel = hasScore ? scoreToMatchLabel(rawScore) : 'Potential Match'
  const title = suggestion.title || 'a funding opportunity'
  const profileLabel = formatProfileLabel(suggestion)

  toast({
    id: `anya-match-${suggestion.id}`,
    title: 'Anya found a strong funding match',
    description: `${title} is a ${matchLabel} for ${profileLabel}${hasScore ? ` (evidence score ${Math.round(rawScore)})` : ""}. Want to add it to the pipeline?`,
    duration: 15000,
    action: (
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={async (e) => {
            e?.preventDefault?.()
            try {
              const result = await apiFetch(
                `/api/anya/match-suggestions/${encodeURIComponent(suggestion.id)}/accept`,
                { method: 'POST' },
              )
              toast({
                id: `anya-match-accepted-${suggestion.id}`,
                title: result?.already_existed
                  ? 'Already in your pipeline'
                  : 'Added to your pipeline',
                description: result?.already_existed
                  ? `${title} was already on the board for ${profileLabel}.`
                  : `${title} is now tracked for ${profileLabel}. GrantFlow will help with the next steps.`,
                duration: 8000,
              })
            } catch (err) {
              toast({
                id: `anya-match-accept-failed-${suggestion.id}`,
                variant: 'destructive',
                title: 'Could not add to pipeline',
                description: err?.message || 'Try again from the Discover Grants page.',
                duration: 8000,
              })
            }
          }}
        >
          Add to Pipeline
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async (e) => {
            e?.preventDefault?.()
            try {
              await apiFetch(
                `/api/anya/match-suggestions/${encodeURIComponent(suggestion.id)}/dismiss`,
                { method: 'POST', body: JSON.stringify({ reason: 'toast_dismiss' }) },
              )
            } catch {
              // Best-effort — the row will still expire eventually.
            }
          }}
        >
          Not right now
        </Button>
      </div>
    ),
  })
}
