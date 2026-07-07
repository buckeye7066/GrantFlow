import React, { useState } from 'react'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'

/**
 * ForcedWelcomeVideo — a one-time, NON-dismissible full-screen gate.
 *
 * When the auth payload carries `forcedWelcomeVideo` ({ id, url, label }), this
 * is the FIRST thing a targeted user sees on login: a dark full-screen overlay
 * (z-index above everything, including LoginGapInterviewLauncher) with the video
 * autoplaying. There is NO close button and NO click-outside — the only way out
 * is the "Continue" button, which appears ONLY after the video finishes
 * ('ended') OR errors (so a bad/broken asset can never trap the user forever).
 *
 * On Continue we POST /api/onboarding/welcome-video/consume { id } (monotonic,
 * idempotent) and then clear the store's forcedWelcomeVideo so OnboardingSequencer
 * falls through to the normal onboarding branches. The consume is best-effort:
 * even if the POST fails we still clear locally so the user is never stuck; the
 * server row stays unconsumed and would re-show on a later login, which is the
 * safe direction for a "must watch once" gate.
 *
 * The video file has burned-in captions, so no <track> is needed.
 */
export default function ForcedWelcomeVideo() {
  const forcedWelcomeVideo = useAuthStore((state) => state.forcedWelcomeVideo)
  const setForcedWelcomeVideo = useAuthStore((state) => state.setForcedWelcomeVideo)
  const [canContinue, setCanContinue] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  if (!forcedWelcomeVideo?.url) return null

  const handleContinue = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      if (forcedWelcomeVideo?.id) {
        await apiFetch('/api/onboarding/welcome-video/consume', {
          method: 'POST',
          body: JSON.stringify({ id: forcedWelcomeVideo.id }),
        })
      }
    } catch (err) {
      // Best-effort: clear locally regardless so the user is never trapped.
      // The server row stays unconsumed and re-shows next login (safe direction).
      console.warn('[ForcedWelcomeVideo] consume failed:', err?.message || err)
    } finally {
      setForcedWelcomeVideo(null)
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100000] flex flex-col items-center justify-center bg-black/95 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={forcedWelcomeVideo.label || 'Welcome video'}
      data-testid="forced-welcome-video"
    >
      {forcedWelcomeVideo.label ? (
        <h2 className="mb-4 text-center text-lg font-semibold text-white sm:text-xl">
          {forcedWelcomeVideo.label}
        </h2>
      ) : null}

      <div className="w-full max-w-4xl">
        <video
          src={forcedWelcomeVideo.url}
          autoPlay
          controls
          playsInline
          className="max-h-[80vh] w-full rounded-lg bg-black shadow-2xl"
          onEnded={() => setCanContinue(true)}
          onError={() => setCanContinue(true)}
        />
      </div>

      <div className="mt-6 flex min-h-[3rem] items-center">
        {canContinue ? (
          <button
            type="button"
            onClick={handleContinue}
            disabled={submitting}
            data-testid="forced-welcome-video-continue"
            className="rounded-full bg-white px-8 py-3 text-base font-semibold text-slate-900 shadow-lg transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Continuing…' : 'Continue'}
          </button>
        ) : (
          <p className="text-sm text-white/70">Please watch the video to continue.</p>
        )}
      </div>
    </div>
  )
}
