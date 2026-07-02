import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/api/client'
import { persistGapAnswers } from './gapInterviewPersistence'
import ProfileGapInterview from './ProfileGapInterview'

/**
 * ProfileGapGate — data container for Anya's opening interview / login gap gate.
 *
 * Fetches the profile's gap plan (GET /api/profiles/:id/gap-plan, #787). When the
 * profile is incomplete it renders the dichotomous ProfileGapInterview (#790) and,
 * on submit, persists the answers by merging each section update into the current
 * section and PUTting it — then re-checks. When complete (or `enabled` is false)
 * it renders `children` untouched.
 *
 * FLAG-GATED: `enabled` defaults to false, so mounting this anywhere is INERT (no
 * fetch, no gate) until the caller passes enabled — the gate can be turned on
 * once verified live, with zero risk to the existing flow before then.
 */
export default function ProfileGapGate({ profileId, enabled = false, onComplete, children = null }) {
  const queryClient = useQueryClient()
  const [submitting, setSubmitting] = useState(false)

  const { data: plan } = useQuery({
    queryKey: ['gap-plan', profileId],
    queryFn: () => apiFetch(`/api/profiles/${profileId}/gap-plan`),
    enabled: Boolean(enabled && profileId),
  })

  const persist = useMutation({
    // Merge-then-PUT lives in gapInterviewPersistence so the global login
    // launcher persists through the exact same path (no duplicated logic).
    mutationFn: (sectionUpdates) => persistGapAnswers(profileId, sectionUpdates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gap-plan', profileId] })
      onComplete?.()
    },
  })

  if (!enabled) return children
  if (!plan || plan.complete || !plan.needs_questions) return children

  return (
    <ProfileGapInterview
      plan={plan}
      submitting={submitting || persist.isPending}
      onSubmit={async (sectionUpdates) => {
        setSubmitting(true)
        try {
          await persist.mutateAsync(sectionUpdates)
        } finally {
          setSubmitting(false)
        }
      }}
    />
  )
}
