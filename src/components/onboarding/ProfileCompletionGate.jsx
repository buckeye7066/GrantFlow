import React, { useMemo, useState } from 'react'
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
 * missing data points), explaining this is needed before they can proceed.
 *
 * Driven by the auth/onboarding payload's `profile_completion` summary
 * (authStore.profileCompletion). While it reports `blocked` for a non-admin,
 * this overlay renders a NON-DISMISSIBLE dialog walking the numbered questions
 * for the first incomplete profile; each answer POSTs to the completion-gate
 * endpoint, which persists the field and returns the advanced gate. When the
 * profile becomes complete the overlay clears itself.
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

  const initialGate = profileCompletion?.next ?? null
  const [gate, setGate] = useState(initialGate)
  const [gateKey] = useState(() => initialGate?.profile_id ?? null)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Re-seed local gate if the store's next-profile changes identity (e.g. a
  // fresh login for a different incomplete profile).
  const active =
    isAuthenticated &&
    !isAdmin &&
    !forcedWelcomeVideo &&
    Boolean(profileCompletion?.blocked) &&
    Boolean(gate) &&
    Array.isArray(gate?.questions) &&
    gate.questions.length > 0 &&
    gate?.profile_id === gateKey

  const current = useMemo(
    () => (active ? gate.questions[0] : null),
    [active, gate],
  )

  if (!active || !current) return null

  const profileId = gate.profile_id

  const handleSubmit = async (event) => {
    event?.preventDefault?.()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const next = await apiFetch(`/api/profiles/${profileId}/completion-gate/answer`, {
        method: 'POST',
        body: JSON.stringify({ question_id: current.id, value }),
      })
      setValue('')
      if (next?.complete || !(next?.questions?.length > 0)) {
        // This profile is done — clear the gate so the overlay stops blocking.
        setProfileCompletion({
          ...(profileCompletion || {}),
          blocked: false,
          next: null,
        })
        setGate(null)
        return
      }
      setGate({ profile_id: profileId, ...next })
    } catch (err) {
      setError('Sorry — that did not save. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const answered = gate.filled_count ?? 0
  const total = current.total

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
            {gate.intro ||
              'Before I can find funding that fits, I need a few required details about this profile. You can’t proceed until it’s complete.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="text-sm font-medium text-muted-foreground" data-testid="completion-gate-counter">
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
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {answered} of {answered + total} required details filled
            </span>
            <Button type="submit" disabled={submitting || value.trim().length === 0}>
              {submitting ? 'Saving…' : current.index >= current.total ? 'Finish' : 'Continue'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
