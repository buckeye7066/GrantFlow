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
import {
  Building2,
  Mail,
  Phone,
  MapPin,
  DollarSign,
  Calendar,
  ExternalLink,
  Globe,
  Info,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { createPageUrl, formatAddress } from '@/utils'
import { formatAmount, formatDeadline } from './fundingLibraryFormatters'

/**
 * Human-readable definitions for the funding types GrantFlow tracks.
 * Keyed by the normalized (lowercased) value of opportunity_type / funding_type
 * stored on funding_opportunities + grants. Used to explain what a funding type
 * means in the funder detail view. We do NOT invent type values here — we only
 * attach a definition to a type that already exists on a row.
 */
const FUNDING_TYPE_DEFINITIONS = {
  grant: 'A grant is funding awarded for a specific purpose that does not need to be repaid.',
  scholarship: 'A scholarship is an award (usually for education) that does not need to be repaid.',
  fellowship: 'A fellowship is a funded position or stipend, typically for research, study, or training.',
  loan: 'A loan is funding that must be repaid, usually with interest.',
  loan_program: 'A loan program offers funding that must be repaid, often on favorable terms.',
  microloan: 'A microloan is a small loan that must be repaid, typically for individuals or small ventures.',
  benefit: 'A benefit is ongoing assistance or a service program (e.g. a public assistance benefit).',
  prize: 'A prize or competition award is granted to winners and does not need to be repaid.',
  award: 'An award is recognition-based funding that does not need to be repaid.',
  contract: 'A contract pays for specific deliverables or services rendered to the funder.',
  cooperative_agreement:
    'A cooperative agreement is like a grant but the funder is substantially involved in the work.',
  voucher: 'A voucher is a credit that can be redeemed toward an eligible good or service.',
  rebate: 'A rebate is a partial refund issued after a qualifying purchase or action.',
  tax_credit: 'A tax credit reduces the amount of tax owed for qualifying activity.',
  in_kind: 'In-kind support is a non-cash contribution of goods, services, or resources.',
}

function defineFundingType(type) {
  if (!type) return null
  const key = String(type).trim().toLowerCase().replace(/\s+/g, '_')
  return FUNDING_TYPE_DEFINITIONS[key] || null
}

function prettyType(type) {
  if (!type) return null
  return String(type)
    .trim()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

const NA = 'Not available'

function Field({ icon: Icon, label, children }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
        {Icon ? <Icon className="w-3.5 h-3.5" /> : null}
        {label}
      </div>
      <div className="text-sm text-slate-800 mt-0.5">{children || NA}</div>
    </div>
  )
}

/**
 * Detail view for a single funder. `funder` is the aggregated object built in
 * Funder.jsx (name, contact fields, fundingTypes, amount range, nextDeadline,
 * url, grants[], opportunities[]). Every field renders "Not available" rather
 * than blank when the underlying rows did not carry it.
 */
export default function FunderDetailDialog({ funder, open, onClose }) {
  if (!funder) return null

  const items = [...(funder.grants || []), ...(funder.opportunities || [])]
  const fundingTypes = Array.isArray(funder.fundingTypes) ? funder.fundingTypes : []
  const definedTypes = fundingTypes
    .map((t) => ({ type: t, definition: defineFundingType(t) }))

  const amountLabel = formatAmount(funder.amountMin, funder.amountMax, funder.amountDescription)
  const deadlineLabel = funder.nextDeadline
    ? formatDeadline(funder.nextDeadline, funder.deadlineType)
    : null

  return (
    <Dialog open={Boolean(open)} onOpenChange={(o) => (o ? null : onClose?.())}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Building2 className="w-5 h-5 text-slate-500" />
            {funder.name}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            {funder.totalAwarded > 0 ? (
              <Badge className="bg-green-600">${funder.totalAwarded.toLocaleString()} awarded</Badge>
            ) : null}
            {funder.grants?.length ? (
              <Badge variant="secondary">
                {funder.grants.length} grant{funder.grants.length !== 1 ? 's' : ''}
              </Badge>
            ) : null}
            {funder.opportunities?.length ? (
              <Badge variant="secondary" className="bg-purple-50 text-purple-700">
                {funder.opportunities.length} opportunit{funder.opportunities.length !== 1 ? 'ies' : 'y'}
              </Badge>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Contact info */}
          <section>
            <h4 className="text-sm font-semibold text-slate-900 mb-2">Contact</h4>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field icon={Mail} label="Email">
                {funder.email ? (
                  <a href={`mailto:${funder.email}`} className="text-blue-600 hover:underline break-all">
                    {funder.email}
                  </a>
                ) : null}
              </Field>
              <Field icon={Phone} label="Phone">
                {funder.phone ? (
                  <a href={`tel:${funder.phone}`} className="text-blue-600 hover:underline">
                    {funder.phone}
                  </a>
                ) : null}
              </Field>
              <Field icon={MapPin} label="Address">
                {funder.address ? formatAddress(funder.address) : null}
              </Field>
              <Field icon={Globe} label="Website / Apply URL">
                {funder.url ? (
                  <a
                    href={funder.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline inline-flex items-center gap-1 break-all"
                  >
                    {funder.url} <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : null}
              </Field>
            </div>
          </section>

          {/* Funding summary */}
          <section>
            <h4 className="text-sm font-semibold text-slate-900 mb-2">Funding</h4>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field icon={DollarSign} label="Amount / Range">
                {amountLabel !== '—' ? amountLabel : null}
              </Field>
              <Field icon={Calendar} label="Next Deadline">
                {deadlineLabel}
              </Field>
            </div>

            <div className="mt-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Funding Type</div>
              {definedTypes.length ? (
                <div className="mt-1 space-y-2">
                  {definedTypes.map(({ type, definition }) => (
                    <div key={type} className="flex flex-col gap-0.5">
                      <Badge variant="outline" className="w-fit">{prettyType(type)}</Badge>
                      {definition ? (
                        <p className="text-xs text-slate-600 flex items-start gap-1">
                          <Info className="w-3 h-3 mt-0.5 shrink-0 text-slate-400" />
                          {definition}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-400">No definition available for this type.</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-slate-800 mt-0.5">{NA}</div>
              )}
            </div>
          </section>

          {/* Grants / opportunities list */}
          <section>
            <h4 className="text-sm font-semibold text-slate-900 mb-2">
              Grants &amp; Opportunities ({items.length})
            </h4>
            {items.length ? (
              <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {items.map((item, i) => {
                  const url = item.url || item.application_url || item.apply_url || item.source_url
                  const amt = formatAmount(item.amount_min, item.amount_max, item.amount_description)
                  const dl = item.deadline ? formatDeadline(item.deadline, item.deadline_type) : null
                  const type = item.opportunity_type || item.funding_type
                  return (
                    <li
                      key={item.id || `${item.title}-${i}`}
                      className="rounded-md border border-slate-200 p-3 text-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate">
                            {item.title || 'Untitled'}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
                            {type ? <span>{prettyType(type)}</span> : null}
                            {amt !== '—' ? <span>{amt}</span> : null}
                            {dl ? <span>Due {dl}</span> : null}
                            {item.status ? <span className="capitalize">{String(item.status).replace(/_/g, ' ')}</span> : null}
                          </div>
                        </div>
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline inline-flex items-center gap-1 text-xs shrink-0"
                          >
                            Open <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">{NA}</p>
            )}
          </section>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button asChild>
            <Link to={`${createPageUrl('Pipeline')}?funder=${encodeURIComponent(funder.name)}`}>
              View Grants
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
