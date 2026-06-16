import React, { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

import { pricingApi } from '@/api/pricing'
import { PricingQuoteDetail } from './PricingQuoteDetail'
import { formatMoney, categoryLabel, statusLabel } from './pricingFormatters'

const STATUS_FILTERS = [
  { id: 'pending_admin_review', label: 'Pending admin review' },
  { id: 'internal_recommendation', label: 'Internal recommendation' },
  { id: 'approved', label: 'Approved' },
  { id: 'presented_to_client', label: 'Presented' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'declined', label: 'Declined' },
  { id: 'all', label: 'All' },
]

/**
 * Top-level panel that lists pricing quotes and pivots into the detail view.
 * Drop into the admin dashboard.
 */
export function PricingRecommendationPanel() {
  const [quotes, setQuotes] = useState([])
  const [filter, setFilter] = useState('pending_admin_review')
  const [selectedId, setSelectedId] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  function refresh() {
    setLoading(true)
    pricingApi
      .listQuotes({ status: filter === 'all' ? undefined : filter, limit: 100 })
      .then((r) => setQuotes(r?.items || []))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [filter])

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>Pricing recommendations</CardTitle>
          <CardDescription>Background quotes generated after Anya intake.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((s) => (
              <Button
                key={s.id}
                variant={filter === s.id ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter(s.id)}
              >
                {s.label}
              </Button>
            ))}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : quotes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No quotes match this filter.</p>
          ) : (
            <ul className="space-y-2">
              {quotes.map((q) => (
                <li
                  key={q.id}
                  className={`cursor-pointer rounded-md border p-3 text-sm transition hover:bg-muted/40 ${selectedId === q.id ? 'border-primary' : ''}`}
                  onClick={() => setSelectedId(q.id)}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{q.recommended_package_name || q.id}</span>
                    <Badge variant="outline">{statusLabel(q.quote_status)}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {categoryLabel(q.client_category)} · {formatMoney(q.total)}
                    {q.admin_review_required ? ' · admin review' : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="lg:col-span-2">
        {selectedId ? (
          <PricingQuoteDetail quoteId={selectedId} onClose={() => setSelectedId(null)} />
        ) : (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Select a quote on the left to review or approve.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

export default PricingRecommendationPanel
