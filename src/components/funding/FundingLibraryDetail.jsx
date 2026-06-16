import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ExternalLink } from 'lucide-react'
import { formatAmount, formatDeadline } from './fundingLibraryFormatters'

export default function FundingLibraryDetail({ item, open, onClose }) {
  if (!item) return null
  const applyUrl = item.apply_url || item.application_url || item.source_url
  const showApply = Boolean(applyUrl)

  return (
    <Dialog open={Boolean(open)} onOpenChange={(o) => (o ? null : onClose?.())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{item.title || 'Untitled'}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5 text-xs">
            {item.is_national ? (
              <Badge variant="outline">National</Badge>
            ) : item.state ? (
              <Badge variant="outline">{item.state}</Badge>
            ) : null}
            {item.source_trust_tier ? (
              <Badge variant="secondary">{item.source_trust_tier}</Badge>
            ) : null}
            {item.opportunity_kind ? (
              <Badge variant="outline" className="uppercase">{item.opportunity_kind}</Badge>
            ) : null}
            {item.record_origin ? (
              <Badge variant="outline">{item.record_origin}</Badge>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {item.description ? (
            <p className="text-slate-700 dark:text-slate-300">{item.description}</p>
          ) : null}

          <div className="grid grid-cols-2 gap-3 text-xs">
            <Field label="Sponsor" value={item.sponsor || '—'} />
            <Field label="Source" value={item.source || '—'} />
            <Field
              label="Amount"
              value={formatAmount(item.amount_min, item.amount_max, item.amount_description)}
            />
            <Field label="Deadline" value={formatDeadline(item.deadline, item.deadline_type)} />
            <Field label="Type" value={item.opportunity_type || item.funding_type || '—'} />
            <Field label="Discovered" value={item.discovered_at ? new Date(item.discovered_at).toLocaleString() : '—'} />
            <Field
              label="Last verified"
              value={item.last_verified_at ? new Date(item.last_verified_at).toLocaleString() : 'never'}
            />
            <Field label="Link status" value={item.link_status || 'unverified'} />
          </div>

          {Array.isArray(item.categories) && item.categories.length ? (
            <div>
              <div className="text-xs font-semibold text-slate-500">Categories</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {item.categories.map((c) => (
                  <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {showApply ? (
            <Button asChild>
              <a href={applyUrl} target="_blank" rel="noreferrer">
                Open application <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm">{value || '—'}</div>
    </div>
  )
}
