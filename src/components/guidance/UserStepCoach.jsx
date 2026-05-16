import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/stores/authStore'
import { messages } from '@/i18n/messages.en'
import { createPageUrl } from '@/utils'
import {
  getPageKey,
  buildSeenKey,
  resolveGuide,
} from '@/components/guidance/userStepCoachHelpers'

// Pure helpers live in `./userStepCoachHelpers.js`. Tests import them
// from there directly. This file only exports the React component so
// the react-refresh ESLint rule stays happy.

/**
 * UserStepCoach
 * -------------
 * One calm, plain-English coach prompt per page. Shown at most ONCE per
 * (page, profile) pair via a localStorage seen flag.
 *
 * Goals (mission-goals.mdc, Anya goal #2 / #4):
 *   - Plain language, no jargon.
 *   - Every prompt should leave the user knowing what to do next.
 *
 * Lookup:
 *   messages.guidance[<PageName>] →
 *     { title, description, nextRoute? }
 *   | (ctx) => { title, description, nextRoute? } | null
 *
 * Where `nextRoute` is { page, label, params? } and the page name is the
 * same PascalCase key used by `createPageUrl()` (e.g. "MyProfiles").
 *
 * Mounted exactly once, in `src/pages/Layout.jsx`. Do NOT mount elsewhere.
 */

function safeReadFlag(key) {
  try {
    return typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(key)
      : null
  } catch {
    return null
  }
}

function safeWriteFlag(key) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, '1')
    }
  } catch {
    // localStorage can throw in private windows / quota errors — silent fail
    // is correct: the coach will simply re-fire once more.
  }
}

export default function UserStepCoach() {
  const location = useLocation()
  const navigate = useNavigate()
  const activeProfileId = useAuthStore((s) => s.activeProfileId)
  const profilesRaw = useAuthStore((s) => s.profiles)
  const profiles = Array.isArray(profilesRaw) ? profilesRaw : []

  React.useEffect(() => {
    const page = getPageKey(location.pathname)
    const guide = messages.guidance?.[page]
    if (!guide) return

    const seenKey = buildSeenKey(page, activeProfileId)
    if (safeReadFlag(seenKey)) return

    const resolved = resolveGuide(guide, { profiles, activeProfileId })
    if (!resolved) return

    // Build the action button (if a nextRoute is provided). We render it
    // here so the toast renders a real React element with the correct
    // navigate closure rather than relying on the toast factory.
    let action = null
    if (resolved.nextRoute?.page && resolved.nextRoute?.label) {
      action = (
        <Button
          size="sm"
          variant="default"
          onClick={() => {
            try {
              navigate(createPageUrl(resolved.nextRoute.page, resolved.nextRoute.params))
            } catch {
              // navigation should never block dismissing the toast
            }
          }}
        >
          {resolved.nextRoute.label}
        </Button>
      )
    }

    toast({
      id: `guide-${page}-${activeProfileId || 'none'}`,
      title: resolved.title,
      description: resolved.description,
      duration: 9000,
      action,
    })

    safeWriteFlag(seenKey)
    // `toast` is a stable module-level singleton; we intentionally do
    // not list it in the deps. `profiles` only affects dynamic guides
    // (which are rare) — we re-fire on profile id change which covers
    // the relevant transitions.
  }, [location.pathname, activeProfileId, navigate])

  return null
}
