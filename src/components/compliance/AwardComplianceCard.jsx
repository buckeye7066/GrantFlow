import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import {
  listComplianceRules,
  logSpendEntry,
  reconcileScholarship,
} from '@/api/awardCompliance'
import { ingestDocument } from '@/api/documents'

// ---------------------------------------------------------------------------
// Money helpers — everything on the wire is integer CENTS.
// ---------------------------------------------------------------------------
function fmtCents(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n)) return '$—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100)
}

function dollarsToCents(value) {
  const n = Number(String(value).replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

const STATUS_META = {
  met: { label: 'Met', variant: 'default', Icon: CheckCircle2 },
  on_track: { label: 'On track', variant: 'secondary', Icon: CheckCircle2 },
  short: { label: 'Short', variant: 'destructive', Icon: AlertTriangle },
  over: { label: 'Over', variant: 'destructive', Icon: AlertTriangle },
  overdue: { label: 'Overdue', variant: 'destructive', Icon: Clock },
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.on_track
  const { Icon } = meta
  return (
    <Badge variant={meta.variant} className="inline-flex items-center gap-1">
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// Log-spending form (attaches an uploaded proof document)
// ---------------------------------------------------------------------------
function LogSpendForm({ rule, profileId, onLogged }) {
  const [amount, setAmount] = React.useState('')
  const [spentOn, setSpentOn] = React.useState('')
  const [memo, setMemo] = React.useState('')
  const [file, setFile] = React.useState(null)
  const [error, setError] = React.useState(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const cents = dollarsToCents(amount)
      if (!cents || cents <= 0) throw new Error('Enter a spend amount greater than $0.')

      // Conservative: a spend entry should carry proof. Upload the proof doc
      // first (reusing the existing documents ingest), then attach its id.
      let proofDocumentId = null
      if (file) {
        const fd = new FormData()
        fd.append('document', file)
        fd.append('profile_id', profileId)
        fd.append('type', 'compliance_proof')
        fd.append('skip_parsing', 'true')
        const uploaded = await ingestDocument(fd)
        proofDocumentId = uploaded?.id || null
      }

      return logSpendEntry(rule.id, {
        amount_cents: cents,
        spent_on: spentOn || null,
        category: rule.category || null,
        memo: memo || null,
        proof_document_id: proofDocumentId,
      })
    },
    onSuccess: () => {
      setAmount('')
      setSpentOn('')
      setMemo('')
      setFile(null)
      setError(null)
      onLogged?.()
    },
    onError: (err) => setError(err?.message || String(err)),
  })

  return (
    <form
      className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
    >
      <div>
        <Label htmlFor={`amt-${rule.id}`}>Amount spent</Label>
        <Input
          id={`amt-${rule.id}`}
          placeholder="$0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
        />
      </div>
      <div>
        <Label htmlFor={`date-${rule.id}`}>Date</Label>
        <Input id={`date-${rule.id}`} type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`memo-${rule.id}`}>Memo</Label>
        <Input id={`memo-${rule.id}`} placeholder="e.g. Office Depot receipt" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`proof-${rule.id}`}>Proof document</Label>
        <Input id={`proof-${rule.id}`} type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <p className="mt-1 text-xs text-muted-foreground">
          Attach a receipt or invoice as proof of compliant spending.
        </p>
      </div>
      {error ? <p className="text-sm text-destructive sm:col-span-2">{error}</p> : null}
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Log spending
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// A single restriction row with progress bar
// ---------------------------------------------------------------------------
function RestrictionRow({ rule, profileId, onChanged }) {
  const summary = rule.summary || {}
  const required = summary.required_cents
  const hasRequirement = required !== null && required !== undefined && required > 0
  const pct = typeof summary.pct === 'number' ? summary.pct : 0

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{rule.title}</span>
            {rule.is_draft ? <Badge variant="outline">Draft — confirm</Badge> : null}
            <StatusBadge status={summary.status} />
          </div>
          {rule.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{rule.description}</p>
          ) : null}
        </div>
        {rule.category ? <Badge variant="secondary">{rule.category}</Badge> : null}
      </div>

      {hasRequirement ? (
        <div className="mt-3">
          <Progress value={pct} />
          <div className="mt-1 flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {fmtCents(summary.spent_cents)} of {fmtCents(required)} spent
            </span>
            {summary.over_cents > 0 ? (
              <span className="text-destructive">{fmtCents(summary.over_cents)} over</span>
            ) : (
              <span>{fmtCents(summary.remaining_cents)} remaining</span>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {fmtCents(summary.spent_cents)} logged{summary.entry_count ? ` (${summary.entry_count} entries)` : ''}.
        </p>
      )}

      {summary.due_date ? (
        <p className={`mt-2 text-sm ${summary.is_overdue ? 'text-destructive' : 'text-muted-foreground'}`}>
          Due {new Date(summary.due_date).toLocaleDateString()}
          {summary.days_left !== null && summary.days_left !== undefined
            ? summary.days_left >= 0
              ? ` — ${summary.days_left} day${summary.days_left === 1 ? '' : 's'} left`
              : ` — ${Math.abs(summary.days_left)} day${Math.abs(summary.days_left) === 1 ? '' : 's'} overdue`
            : ''}
        </p>
      ) : null}

      <LogSpendForm rule={rule} profileId={profileId} onLogged={onChanged} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scholarship reconciliation (bill vs award)
// ---------------------------------------------------------------------------
function ScholarshipReconciliation() {
  const [award, setAward] = React.useState('')
  const [bill, setBill] = React.useState('')
  const [result, setResult] = React.useState(null)

  const mutation = useMutation({
    mutationFn: () =>
      reconcileScholarship({
        awardCents: dollarsToCents(award) || 0,
        schoolBillCents: dollarsToCents(bill) || 0,
      }),
    onSuccess: setResult,
  })

  return (
    <div className="rounded-lg border p-4">
      <h4 className="font-medium">Scholarship reconciliation</h4>
      <p className="text-sm text-muted-foreground">Compare an award against the school bill.</p>
      <form
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate()
        }}
      >
        <div>
          <Label htmlFor="sch-award">Award amount</Label>
          <Input id="sch-award" placeholder="$0.00" value={award} onChange={(e) => setAward(e.target.value)} inputMode="decimal" />
        </div>
        <div>
          <Label htmlFor="sch-bill">School bill</Label>
          <Input id="sch-bill" placeholder="$0.00" value={bill} onChange={(e) => setBill(e.target.value)} inputMode="decimal" />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" variant="secondary" disabled={mutation.isPending}>
            Reconcile
          </Button>
        </div>
      </form>
      {result ? (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">Bill</dt>
          <dd className="text-right">{fmtCents(result.bill_cents)}</dd>
          <dt className="text-muted-foreground">Covered by award</dt>
          <dd className="text-right">{fmtCents(result.covered_cents)}</dd>
          <dt className="text-muted-foreground">Left to pay</dt>
          <dd className="text-right">{fmtCents(result.left_to_pay_cents)}</dd>
          <dt className="text-muted-foreground">Extra (refundable)</dt>
          <dd className="text-right">{fmtCents(result.extra_refund_cents)}</dd>
        </dl>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------
export default function AwardComplianceCard({ profileId, grantId, showScholarship = true }) {
  const qc = useQueryClient()
  const queryKey = ['awardCompliance', 'rules', profileId, grantId || null]

  const q = useQuery({
    queryKey,
    queryFn: () => listComplianceRules({ profileId, grantId }),
    enabled: Boolean(profileId),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey })

  const rules = q.data?.rules || []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Award Compliance &amp; Restrictions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading restrictions…
          </div>
        ) : q.isError ? (
          <p className="text-sm text-destructive">{q.error?.message || 'Failed to load restrictions.'}</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No restrictions captured for this award yet. Add one when an award has spending rules
            (e.g. a portion that must go to supplies, or a spend-by deadline).
          </p>
        ) : (
          rules.map((rule) => (
            <RestrictionRow key={rule.id} rule={rule} profileId={profileId} onChanged={invalidate} />
          ))
        )}

        {showScholarship ? <ScholarshipReconciliation /> : null}
      </CardContent>
    </Card>
  )
}
