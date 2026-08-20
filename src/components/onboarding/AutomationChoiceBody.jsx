import React, { useState } from 'react'
import { Loader2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { useToast } from '@/components/ui/use-toast'

// Mirrors HamiltonAutopilotAuthorization.jsx full-automation defaults.
const AUTOMATION_TYPES = [
  'complete_forms', 'upload_documents', 'generate_narratives', 'save_drafts',
  'submit_applications',
  'use_saved_session', 'use_saved_credentials_reference', 'use_standing_attestation',
]

const FULL_AUTOMATION_OPTIONS = {
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
  const [busy, setBusy] = useState(false)

  const chooseFullAutomation = async () => {
    if (!profileId) {
      onDone?.()
      return
    }
    setBusy(true)
    try {
      await apiFetch('/api/hamilton/automation/authorize', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: profileId,
          scope: 'profile',
          authorization_types: AUTOMATION_TYPES,
          options: FULL_AUTOMATION_OPTIONS,
          replace_omitted_types: true,
        }),
      })
      toast({
        title: 'Hamilton can fill and submit for you',
        description: "I'll complete applications using your profile, pause only for login, CAPTCHA, 2FA, payment, or signatures, and submit when authorized.",
      })
    } catch (err) {
      toast({
        title: "Couldn't save that preference",
        description: err?.message || 'You can set this later from the Pipeline page.',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
      onDone?.()
    }
  }

  return (
    <div>
      <p className="text-sm leading-relaxed text-slate-700">
        Hamilton can fill and submit applications for you. She still pauses for login,
        CAPTCHA, 2FA, payment, and signatures that only a human can complete.
      </p>

      <div className="mt-3 space-y-2">
        <button
          type="button"
          onClick={chooseFullAutomation}
          disabled={busy}
          className="flex w-full items-start gap-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-left transition-colors hover:bg-blue-50 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600" />
          ) : (
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          )}
          <span>
            <span className="block text-sm font-semibold text-slate-900">Let Hamilton fill and submit</span>
            <span className="block text-xs text-slate-500">Authorized auto-submit; pauses only for login, CAPTCHA, 2FA, payment, or signatures.</span>
          </span>
        </button>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onDone?.()}
        disabled={busy}
        className="mt-2 w-full text-slate-400"
      >
        Decide later
      </Button>
    </div>
  )
}
