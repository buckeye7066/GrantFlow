import React, { useState } from 'react'
import { Loader2, ShieldCheck, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { useToast } from '@/components/ui/use-toast'

// Mirrors HamiltonAutopilotAuthorization.jsx's DEFAULTS, but presented as two
// plain-language choices instead of a 9-toggle grid -- this is a first-time,
// in-tour moment, not the full advanced settings panel (still available
// later from the Pipeline page for anyone who wants finer control).
const AUTOMATION_TYPES = [
  'complete_forms', 'upload_documents', 'generate_narratives', 'save_drafts',
  'use_saved_session', 'use_saved_credentials_reference',
]

const FULL_AUTO_OPTIONS = {
  complete_forms: true,
  upload_documents: true,
  generate_narratives: true,
  save_drafts: true,
  submit_applications: true,
  allow_auto_submit: true,
  use_saved_session: true,
  use_saved_credentials_reference: true,
  use_standing_attestation: true,
  require_human_review: false,
}

const REVIEW_FIRST_OPTIONS = {
  ...FULL_AUTO_OPTIONS,
  submit_applications: false,
  allow_auto_submit: false,
  use_standing_attestation: false,
  require_human_review: true,
}

/**
 * The guided tour's "how hands-on do you want to be" step. Presents Hamilton's
 * automation choice in plain language and, if the user picks one, posts a
 * profile-wide standing authorization via the same endpoint the advanced
 * HamiltonAutopilotAuthorization panel uses (scope: 'profile', so it isn't
 * tied to one funding source). Choosing "decide later" leaves nothing
 * authorized -- see reportAutomationChoiceDeferred in guidedTourStore usage:
 * the next login re-shows this same choice as the first popup, since
 * Dashboard checks GET /api/hamilton/automation/authorizations for a
 * profile-scope row before suppressing it.
 */
export default function AutomationChoiceBody({ onDone }) {
  const profileId = useAuthStore((s) => s.activeProfileId)
  const { toast } = useToast()
  const [busy, setBusy] = useState(null) // 'auto' | 'review' | null

  const choose = async (kind) => {
    if (!profileId) {
      onDone?.()
      return
    }
    setBusy(kind)
    try {
      const options = kind === 'auto' ? FULL_AUTO_OPTIONS : REVIEW_FIRST_OPTIONS
      const types = kind === 'auto'
        ? [...AUTOMATION_TYPES, 'submit_applications', 'use_standing_attestation']
        : AUTOMATION_TYPES
      await apiFetch('/api/hamilton/automation/authorize', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: profileId,
          scope: 'profile',
          authorization_types: types,
          options,
        }),
      })
      toast({
        title: kind === 'auto' ? "Hamilton's on autopilot" : 'Hamilton will check in with you first',
        description: kind === 'auto'
          ? "I'll complete and submit applications for you. You can change this anytime from the Pipeline page."
          : "I'll fill everything out and pause for your review before anything is ever submitted.",
      })
    } catch (err) {
      toast({
        title: "Couldn't save that preference",
        description: err?.message || 'You can set this later from the Pipeline page.',
        variant: 'destructive',
      })
    } finally {
      setBusy(null)
      onDone?.()
    }
  }

  return (
    <div>
      <p className="text-sm leading-relaxed text-slate-700">
        Hamilton can fill out and submit applications for you automatically, or pause and let you
        review everything first before anything gets sent. Either way, I'll never submit anything
        to a real portal without one of these two choices being made.
      </p>

      <div className="mt-3 space-y-2">
        <button
          type="button"
          onClick={() => choose('auto')}
          disabled={busy !== null}
          className="flex w-full items-start gap-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-left transition-colors hover:bg-blue-50 disabled:opacity-60"
        >
          {busy === 'auto' ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600" />
          ) : (
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          )}
          <span>
            <span className="block text-sm font-semibold text-slate-900">Let Hamilton handle everything</span>
            <span className="block text-xs text-slate-500">Fastest — forms get filled and submitted without waiting on you.</span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => choose('review')}
          disabled={busy !== null}
          className="flex w-full items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition-colors hover:bg-slate-100 disabled:opacity-60"
        >
          {busy === 'review' ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-slate-600" />
          ) : (
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />
          )}
          <span>
            <span className="block text-sm font-semibold text-slate-900">I'll review before anything submits</span>
            <span className="block text-xs text-slate-500">Hamilton fills the form, then waits for your go-ahead.</span>
          </span>
        </button>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onDone?.()}
        disabled={busy !== null}
        className="mt-2 w-full text-slate-400"
      >
        Decide later
      </Button>
    </div>
  )
}
