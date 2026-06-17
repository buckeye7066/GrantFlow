import React, { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, Send, X, Check } from 'lucide-react'

import { pricingApi } from '@/api/pricing'
import { PricingQuoteLineItems } from './PricingQuoteLineItems'
import { PricingDiscountEditor } from './PricingDiscountEditor'
import { formatMoney, formatMoneyDecimal, categoryLabel, statusLabel } from './pricingFormatters'

/**
 * Quote detail panel. Loads a single quote, lets the admin approve,
 * approve/remove/add discounts, edit category, and mark presented /
 * accepted / declined.
 */
export function PricingQuoteDetail({ quoteId, onClose }) {
  const [quote, setQuote] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  function refresh() {
    if (!quoteId) return
    setLoading(true)
    pricingApi
      .getQuote(quoteId)
      .then((r) => setQuote(r?.quote || null))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [quoteId])

  async function safe(action) {
    try {
      await action()
      refresh()
    } catch (e) {
      setError(e?.message || String(e))
    }
  }

  if (!quoteId) return null
  if (loading && !quote) return <Card><CardContent className="p-6">Loading quote…</CardContent></Card>
  if (error) return <Card><CardContent className="p-6 text-destructive">{error}</CardContent></Card>
  if (!quote) return <Card><CardContent className="p-6">Quote not found.</CardContent></Card>

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>{quote.recommended_package_name || 'GrantFlow service quote'}</CardTitle>
            <CardDescription>
              Catalog {quote.pricing_catalog_version} · {categoryLabel(quote.client_category)} ·{' '}
              <Badge variant="outline">{statusLabel(quote.quote_status)}</Badge>
              {quote.admin_review_required ? (
                <Badge className="ml-2" variant="default">Admin review required</Badge>
              ) : null}
            </CardDescription>
          </div>
          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Stat label="Subtotal" value={formatMoney(quote.subtotal)} />
          <Stat label="Discounts" value={`-${formatMoney(quote.discount_total)}`} />
          <Stat label="Total" value={formatMoneyDecimal(quote.total)} highlight />
        </CardContent>
      </Card>

      <PricingQuoteLineItems lineItems={quote.line_items} category={quote.client_category} />

      <PricingDiscountEditor
        discounts={quote.discounts || []}
        onApprove={(id) => safe(() => pricingApi.approveDiscount(quoteId, id))}
        onRemove={(id) => safe(() => pricingApi.removeDiscount(quoteId, id))}
        onAdd={(d) => safe(() => pricingApi.addManualDiscount(quoteId, d))}
      />

      <Card>
        <CardHeader>
          <CardTitle>Reasons</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {(quote.reasons || []).length === 0 ? (
            <p className="text-muted-foreground">No reasons recorded.</p>
          ) : (
            <ul className="list-disc pl-5">
              {(quote.reasons || []).map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
          {quote.missing_inputs?.length ? (
            <p className="text-xs text-amber-700">
              Missing inputs: {quote.missing_inputs.join(', ')}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="default" onClick={() => safe(() => pricingApi.approveQuote(quoteId))}>
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Approve quote
          </Button>
          <Button variant="secondary" onClick={() => safe(() => pricingApi.markPresented(quoteId))}>
            <Send className="mr-2 h-4 w-4" />
            Mark presented
          </Button>
          <Button variant="outline" onClick={() => safe(() => pricingApi.markAccepted(quoteId))}>
            <Check className="mr-2 h-4 w-4" />
            Mark accepted
          </Button>
          <Button variant="ghost" onClick={() => safe(() => pricingApi.markDeclined(quoteId))}>
            <X className="mr-2 h-4 w-4" />
            Mark declined
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value, highlight }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={highlight ? 'text-2xl font-semibold' : 'text-base font-medium'}>{value}</div>
    </div>
  )
}

export default PricingQuoteDetail
