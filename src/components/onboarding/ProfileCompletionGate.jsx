import React, { useState } from 'react'
import { apiFetch } from '@/api/client'
import { useAuthStore, normalizeUserAdmin } from '@/stores/authStore'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * ProfileCompletionGate — the BLOCKING profile-completion gate.
 *
 * Owner directive: a profile user cannot proceed until they finish filling out
 * their profile with the information RELEVANT TO THEIR PROFILE TYPE. On next
 * login, Anya presents the missing data points as a SERIES OF NUMBERED
 * questions ("1 of N", "2 of N", …, "N of N" where N = the number of still-
 * missing data points at login), explaining this is needed before they can
 * proceed.
 *
 * Driven by the auth/onboarding payload's `profile_completion` summary
 * (authStore.profileCompletion). While it reports `blocked` for a non-admin,
 * this overlay renders a NON-DISMISSIBLE dialog walking the numbered questions
 * for the first incomplete profile. The question list + its stable N come from
 * that one payload (each question already carries {index, total}); we walk it in
 * order so the counter PROGRESSES 1→N rather than resetting as fields fill.
 * Each answer POSTs to the completion-gate endpoint (persist + recompute); a
 * response reporting completion ends the gate early.
 *
 * ADMINS ARE NEVER GATED (the backend resolves admins to an inert summary; this
 * is belt-and-suspenders). It never renders while a one-time forced welcome
 * video is pending (that overlay is strictly higher priority).
 *
 * Mount once (App.jsx), alongside OnboardingSequencer.
 */
export default function ProfileCompletionGate() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const user = useAuthStore((s) => s.user)
  const profileCompletion = useAuthStore((s) => s.profileCompletion)
  const forcedWelcomeVideo = useAuthStore((s) => s.forcedWelcomeVideo)
  const setProfileCompletion = useAuthStore((s) => s.setProfileCompletion)
  const isAdmin = normalizeUserAdmin(user)

  const next = profileCompletion?.next ?? null
  // Freeze the numbered question list + profile id at mount for THIS profile, so
  // the "X of N" counter progresses across answers instead of resetting.
  const [session] = useState(() =>
    next && Array.isArray(next.questions) && next.questions.length > 0
      ? { profileId: next.profile_id, questions: next.questions, intro: next.intro }
      : null,
  )
  const [pos, setPos] = useState(0)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const active =
    isAuthenticated &&
    !isAdmin &&
    !forcedWelcomeVideo &&
    Boolean(profileCompletion?.blocked) &&
    Boolean(session) &&
    !done &&
    pos < (session?.questions.length ?? 0)

  if (!active) return null

  const current = session.questions[pos]
  const profileId = session.profileId

  const finish = () => {
    setDone(true)
    setProfileCompletion({ ...(profileCompletion || {}), blocked: false, next: null })
  }

  const handleSubmit = async (event) => {
    event?.preventDefault?.()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await apiFetch(`/api/profiles/${profileId}/completion-gate/answer`, {
        method: 'POST',
        body: JSON.stringify({ question_id: current.id, value }),
      })
      setValue('')
      // Server says the profile is fully complete → stop early.
      if (result?.complete) {
        finish()
        return
      }
      // Otherwise advance to the next numbered question; if this was the last,
      // the profile is complete.
      if (pos + 1 >= session.questions.length) {
        finish()
        return
      }
      setPos((p) => p + 1)
    } catch {
      setError('Sorry — that did not save. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const isLast = current.index >= current.total

  return (
    <Dialog open onOpenChange={() => { /* non-dismissible: must be completed */ }}>
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="profile-completion-gate"
      >
        <DialogHeader>
          <DialogTitle>Let’s finish your profile</DialogTitle>
          <DialogDescription>
            {session.intro ||
              'Before I can find funding that fits, I need a few required details about this profile. You can’t proceed until it’s complete.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div
            className="text-sm font-medium text-muted-foreground"
            data-testid="completion-gate-counter"
          >
            Question {current.index} of {current.total}
          </div>
          <label className="block text-base font-medium" htmlFor="completion-gate-answer">
            {current.prompt}
          </label>
          <Input
            id="completion-gate-answer"
            autoFocus
            type={current.type === 'number' ? 'number' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={submitting}
            placeholder="Type your answer…"
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex items-center justify-end">
            <Button type="submit" disabled={submitting || value.trim().length === 0}>
              {submitting ? 'Saving…' : isLast ? 'Finish' : 'Continue'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
