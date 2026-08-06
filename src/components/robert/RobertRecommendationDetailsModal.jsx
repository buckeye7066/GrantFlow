import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/use-toast'
import { apiFetch } from '@/api/client'
import { humanizeMatchReason } from '@/utils/reasonText'
import { scoreToMatchLabel } from '@/lib/matchDisplayThresholds'

/**
 * RobertRecommendationDetailsModal
 * --------------------------------
 * Opens when the user clicks "View Details" on a Robert toast. Shows
 * the title/sponsor/match score/why-found and provides Accept/Decline
 * actions.
 *
 * Loads the underlying funding opportunity by id (best-effort) so we
 * can surface a real description + URL.
 */

export default function RobertRecommendationDetailsModal({ open, recommendation, onClose, onAfterAccept, onAfterDecline }) {
  const [opportunity, setOpportunity] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    if (!open || !recommendation?.opportunity_id) {
      setOpportunity(null)
      return undefined
    }
    ;(async () => {
      try {
        const result = await apiFetch(`/api/opportunities/${encodeURIComponent(recommendation.opportunity_id)}`)
        if (!cancelled) setOpportunity(result?.opportunity || result || null)
      } catch {
        if (!cancelled) setOpportunity(null)
      }
    })()
    return () => { cancelled = true }
  }, [open, recommendation?.opportunity_id])

  if (!recommendation) return null

  const rawScore = Number(recommendation.match_score)
  const hasScore = Number.isFinite(rawScore)
  const matchLabel = hasScore ? scoreToMatchLabel(rawScore) : null
  const decision = String(recommendation.match_decision || '').toUpperCase()
  const reasons = Array.isArray(recommendation.match_reasons) ? recommendation.match_reasons : []

  async function handleAccept() {
    if (busy) return
    setBusy(true)
    try {
      const result = await apiFetch(
        `/api/robert/recommendations/${encodeURIComponent(recommendation.id)}/accept`,
        { method: 'POST' },
      )
      toast({
        id: `robert-rec-accepted-${recommendation.id}`,
        title: 'Added to pipeline.',
        description: result?.pipeline?.saved
          ? 'Robert added it to this profile\'s pipeline.'
          : 'Robert recorded the decision; check Discover Grants for confirmation.',
        duration: 8000,
      })
      onAfterAccept?.(recommendation.id)
    } catch (err) {
      toast({
        id: `robert-rec-accept-failed-${recommendation.id}`,
        variant: 'destructive',
        title: 'Could not add to pipeline.',
        description: err?.message || 'Try again from Discover Grants.',
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleDecline() {
    if (busy) return
    setBusy(true)
    try {
      await apiFetch(`/api/robert/recommendations/${encodeURIComponent(recommendation.id)}/decline`, { method: 'POST' })
      toast({
        id: `robert-rec-declined-${recommendation.id}`,
        title: 'Kept in general resources.',
        description: 'Robert won\'t suggest this opportunity for this profile again.',
      })
      onAfterDecline?.(recommendation.id)
    } catch {
      // best-effort
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Robert recommendation details</DialogTitle>
          <DialogDescription>
            Robert found this opportunity from a verified source and matched it to your profile using GrantFlow's canonical scoring engine.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            {decision && (
              <Badge variant={decision === 'ACCEPT' ? 'default' : decision === 'REVIEW' ? 'secondary' : 'outline'}>
                {decision}
              </Badge>
            )}
            {matchLabel && <Badge variant="outline">{matchLabel} · score {Math.round(rawScore)}</Badge>}
            {recommendation.toast_priority && (
              <Badge variant="outline">priority: {recommendation.toast_priority}</Badge>
            )}
          </div>

          <div>
            <div className="font-semibold text-base">{opportunity?.title || recommendation.toast_title || 'Funding opportunity'}</div>
            {opportunity?.sponsor && <div className="text-muted-foreground">{opportunity.sponsor}</div>}
          </div>

          {opportunity?.description && (
            <p className="text-muted-foreground whitespace-pre-line">{String(opportunity.description).slice(0, 600)}</p>
          )}

          {recommendation.why_found && (
            <div>
              <div className="font-medium">Why Robert found this</div>
              <div className="text-muted-foreground">{recommendation.why_found}</div>
            </div>
          )}

          {reasons.length > 0 && (
            <div>
              <div className="font-medium">Why it appears relevant</div>
              <ul className="list-disc list-inside text-muted-foreground">
                {reasons.slice(0, 6).map((r, i) => {
                  const text = humanizeMatchReason(r)
                  return text ? <li key={i}>{text}</li> : null
                })}
              </ul>
            </div>
          )}

          {opportunity?.application_url && (
            <div>
              <a href={opportunity.application_url} target="_blank" rel="noreferrer" className="underline text-blue-600">
                Open the application page
              </a>
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-col sm:flex-row gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
          <Button variant="outline" onClick={handleDecline} disabled={busy}>No, Keep in Resources</Button>
          <Button onClick={handleAccept} disabled={busy}>Yes, Add to Pipeline</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
