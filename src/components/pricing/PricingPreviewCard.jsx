import React from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AlertTriangle } from 'lucide-react'
import { formatMoney } from './pricingFormatters'

/**
 * Limited match preview shown to unpaid users. Mirrors the disclaimer
 * the user query mandates: "Potential funding amounts are based on
 * published opportunity information and are not guaranteed."
 */
export function PricingPreviewCard({ summary, topCategories = [], showAmounts = true }) {
  if (!summary) return null
  const {
    total_matches = 0,
    strong_matches = 0,
    review_matches = 0,
    potential_low_total = 0,
    potential_high_total = 0,
    amount_unknown_count = 0,
  } = summary

  const lowFmt = formatMoney(potential_low_total)
  const highFmt = formatMoney(potential_high_total)
  const range =
    showAmounts && (potential_low_total > 0 || potential_high_total > 0)
      ? potential_low_total !== potential_high_total
        ? `${lowFmt} – ${highFmt}`
        : lowFmt
      : 'Amount varies'

  return (
    <Card>
      <CardHeader>
        <CardTitle>Match preview</CardTitle>
        <CardDescription>
          A quick look at what GrantFlow found for you. Full details unlock after agreement and payment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant="default">{total_matches} {total_matches === 1 ? 'match' : 'matches'}</Badge>
          <Badge variant="secondary">{strong_matches} strong</Badge>
          <Badge variant="outline">{review_matches} need review</Badge>
          {amount_unknown_count > 0 ? (
            <Badge variant="outline">{amount_unknown_count} amount varies</Badge>
          ) : null}
        </div>
        {topCategories.length > 0 ? (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {topCategories.slice(0, 5).map((c, i) => (
              <span key={i} className="rounded-full bg-muted px-2 py-1">{c}</span>
            ))}
          </div>
        ) : null}
        {showAmounts ? (
          <div>
            <div className="text-sm text-muted-foreground">Potential funding range</div>
            <div className="text-2xl font-semibold">{range}</div>
          </div>
        ) : null}
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Potential funding amounts are based on published opportunity information and are not guaranteed.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export default PricingPreviewCard
