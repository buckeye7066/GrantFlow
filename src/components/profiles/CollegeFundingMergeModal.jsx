import React, { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { mergeCommittedCollegeFunding } from '@/api/committedCollege.js'

const MODE_BADGE = {
  hamilton_autopilot: { label: 'Hamilton autopilot', className: 'bg-blue-100 text-blue-700 border-blue-200' },
  hamilton_packet: { label: 'Hamilton packet', className: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  user_confirm: { label: 'You confirm', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  manual_review: { label: 'Manual review', className: 'bg-slate-100 text-slate-700 border-slate-200' },
  skip: { label: 'No application', className: 'bg-slate-100 text-slate-500 border-slate-200' },
}

const idOf = (f) => f?.id ?? f?.opportunity_id ?? f?.grant_id ?? f?.funding_opportunity_id

/**
 * Funding merge preview + handoff modal.
 * @param {boolean} open
 * @param {Function} onOpenChange
 * @param {string} profileId
 * @param {Array} matchedFunding  funding items from the workspace ({id,title,amount,...})
 */
export default function CollegeFundingMergeModal({ open, onOpenChange, profileId, matchedFunding = [] }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const selectableItems = useMemo(() => matchedFunding.filter((f) => idOf(f)), [matchedFunding])
  const [selectedIds, setSelectedIds] = useState(() => new Set(selectableItems.map(idOf)))
  const [plan, setPlan] = useState(null)

  // Reset selection whenever the modal re-opens with new funding.
  React.useEffect(() => {
    if (open) {
      setSelectedIds(new Set(selectableItems.map(idOf)))
      setPlan(null)
    }
  }, [open, selectableItems])

  const selectedFunding = useMemo(
    () => selectableItems.filter((f) => selectedIds.has(idOf(f))),
    [selectableItems, selectedIds],
  )

  const merge = useMutation({
    mutationFn: ({ authorize }) => mergeCommittedCollegeFunding(profileId, { selectedFunding, authorize }),
    onSuccess: (res, vars) => {
      setPlan(res?.plan || null)
      if (vars.authorize) {
        const n = res?.plan?.automatable_ids?.length || 0
        toast({ title: 'Handed to Hamilton', description: `${n} item(s) sent to Hamilton; review status in the workspace.` })
        queryClient.invalidateQueries({ queryKey: ['committed-college-workspace', profileId] })
        queryClient.invalidateQueries({ queryKey: ['profile', profileId] })
        onOpenChange(false)
      }
    },
    onError: (err) => toast({ title: 'Merge failed', description: err?.message, variant: 'destructive' }),
  })

  const toggle = (id) => setSelectedIds((cur) => {
    const next = new Set(cur)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const fmt = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString()}`)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge funding with Hamilton</DialogTitle>
          <DialogDescription>
            Choose funding to hand to Hamilton. Federal/FAFSA aid is never auto-submitted — you complete and sign those yourself.
          </DialogDescription>
        </DialogHeader>

        {selectableItems.length === 0 ? (
          <Alert><AlertDescription>No matched funding with a reference id yet.</AlertDescription></Alert>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {selectableItems.map((f) => {
              const id = idOf(f)
              const planned = plan?.items?.find((p) => String(p.id) === String(id))
              const badge = planned ? MODE_BADGE[planned.handoff_mode] : null
              return (
                <div key={id} className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
                  <Checkbox checked={selectedIds.has(id)} onCheckedChange={() => toggle(id)} className="mt-1" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900 truncate">{f.title || 'Untitled funding'}</span>
                      <span className="text-sm text-slate-500 shrink-0">{fmt(f.amount)}</span>
                    </div>
                    {badge ? (
                      <div className="mt-1.5 flex items-center gap-2">
                        <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
                        {planned?.federal ? <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">Federal — you sign</Badge> : null}
                      </div>
                    ) : null}
                    {planned?.compliance_notes?.length ? (
                      <p className="mt-1 text-xs text-slate-500">{planned.compliance_notes[0]}</p>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {plan ? (
          <Alert className="border-emerald-200 bg-emerald-50">
            <AlertDescription className="text-emerald-900 text-sm">
              Plan: {plan.summary.autopilot} autopilot · {plan.summary.packet} packet · {plan.summary.user_confirm} you confirm · {plan.summary.manual} manual.
              {plan.requires_user_action ? ' Some items need your action and won’t be auto-submitted.' : ''}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={merge.isPending}>Cancel</Button>
          <Button
            variant="outline"
            onClick={() => merge.mutate({ authorize: false })}
            disabled={merge.isPending || selectedFunding.length === 0}
          >
            {merge.isPending && !merge.variables?.authorize ? 'Previewing…' : 'Preview plan'}
          </Button>
          <Button
            onClick={() => merge.mutate({ authorize: true })}
            disabled={merge.isPending || !plan || (plan.automatable_ids?.length || 0) === 0}
          >
            {merge.isPending && merge.variables?.authorize ? 'Handing off…' : 'Authorize & hand to Hamilton'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
