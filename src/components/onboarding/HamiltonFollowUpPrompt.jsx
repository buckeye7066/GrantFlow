import React, { useEffect, useState } from 'react'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import AnyaCoachmark from '@/components/onboarding/AnyaCoachmark'
import AutomationChoiceBody from '@/components/onboarding/AutomationChoiceBody'

/**
 * Re-asks Anya's automation-preference question (the same choice offered
 * inside the guided tour) as the first popup on a later login, if the user
 * picked "decide later" during the tour and still hasn't authorized
 * anything for Hamilton. The signal is the authorizations table itself
 * (no separate "deferred" flag to drift out of sync with) -- if a
 * profile-scope authorization already exists (made here, in a later tour
 * run, or from the Pipeline page's advanced panel), this renders nothing.
 */
export default function HamiltonFollowUpPrompt() {
  const profileId = useAuthStore((s) => s.activeProfileId)
  const [status, setStatus] = useState('checking') // 'checking' | 'needed' | 'done'

  useEffect(() => {
    let cancelled = false
    if (!profileId || profileId === '__admin__') {
      setStatus('done')
      return undefined
    }
    apiFetch(`/api/hamilton/automation/authorizations?profile_id=${encodeURIComponent(profileId)}`)
      .then((res) => {
        if (cancelled) return
        const hasAny = Array.isArray(res?.active) && res.active.length > 0
        setStatus(hasAny ? 'done' : 'needed')
      })
      .catch(() => {
        if (!cancelled) setStatus('done') // fail closed — don't nag if the check itself errors
      })
    return () => {
      cancelled = true
    }
  }, [profileId])

  if (status !== 'needed') return null

  return (
    <AnyaCoachmark
      targetRef={null}
      title="One more thing before Hamilton gets to work"
      body={<AutomationChoiceBody onDone={() => setStatus('done')} />}
      onNext={null}
      onSkip={() => setStatus('done')}
    />
  )
}
