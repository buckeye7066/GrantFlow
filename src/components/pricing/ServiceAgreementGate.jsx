import React, { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CheckCircle2, ScrollText } from 'lucide-react'
import { accessGateApi } from '@/api/accessGate'

const DEFAULT_AGREEMENT_TEXT = `GrantFlow Professional Grant Writing Services — Service Agreement (2026-06-15)

All fees are for professional services rendered. Fees are not contingent on award outcomes. There are no percentage-based or commission fees.

Payment terms: 40% due at project kickoff, 40% due at complete draft delivery, 20% due at submission/handoff delivery. Net 15 days. 1.5% monthly late fee.

Potential funding amounts shown in GrantFlow are based on published opportunity information and are not guaranteed.

By accepting this agreement you authorize GrantFlow to begin the recommended service package after payment is received.`

/**
 * Required-agreement step. Shown after pricing is generated and before
 * checkout. The checkbox label is the exact text the spec requires:
 *
 *   "I agree to the GrantFlow professional service terms."
 *
 * On submit we POST /api/access-gate/agreement/accept which records IP +
 * user-agent + agreement_text snapshot.
 */
export function ServiceAgreementGate({
  profileId,
  agreementText,
  onAccepted,
  alreadyAccepted = false,
}) {
  const [checked, setChecked] = useState(Boolean(alreadyAccepted))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [accepted, setAccepted] = useState(Boolean(alreadyAccepted))

  async function submit() {
    if (!checked || !profileId) return
    setSubmitting(true)
    setError(null)
    try {
      const r = await accessGateApi.acceptAgreement(profileId, agreementText || '')
      if (!r?.ok) {
        setError(r?.error || 'agreement_failed')
        return
      }
      setAccepted(true)
      if (typeof onAccepted === 'function') onAccepted(r)
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (accepted) {
    return (
      <Alert>
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>Agreement accepted</AlertTitle>
        <AlertDescription>
          Thanks. You can continue to checkout when you're ready.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="h-5 w-5" /> Service agreement
        </CardTitle>
        <CardDescription>
          Please review and accept the GrantFlow professional service terms before checkout.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-h-60 overflow-auto rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
          {agreementText || DEFAULT_AGREEMENT_TEXT}
        </div>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox checked={checked} onCheckedChange={(v) => setChecked(Boolean(v))} />
          <span>I agree to the GrantFlow professional service terms.</span>
        </label>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not record agreement</AlertTitle>
            <AlertDescription>{String(error)}</AlertDescription>
          </Alert>
        ) : null}
        <div>
          <Button disabled={!checked || submitting || !profileId} onClick={submit}>
            {submitting ? 'Recording…' : 'Accept and continue'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default ServiceAgreementGate
