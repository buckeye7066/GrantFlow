import React from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AlertTriangle } from 'lucide-react'

const fmt = (n) =>
  Number.isFinite(Number(n)) && Number(n) > 0
    ? `$${Math.round(Number(n)).toLocaleString()}`
    : null

/**
 * Top-of-results summary card. Shows match counts and the *potential*
 * funding range — never a guaranteed total.
 *
 * Inputs:
 *   - total_matches:        all matches surfaced
 *   - strong_matches:       count with score >= 0.7
 *   - review_matches:       count needing review (e.g. eligibility unsure)
 *   - potential_low_total:  sum of amount_min over matches with known min
 *   - potential_high_total: sum of amount_max over matches with known max
 *   - amount_unknown_count: matches with no published amount
 */
export function AnyaPotentialFundingSummary({ summary }) {
  if (!summary) return null
  const {
    total_matches = 0,
    strong_matches = 0,
    review_matches = 0,
    potential_low_total = 0,
    potential_high_total = 0,
    amount_unknown_count = 0,
  } = summary

  const lowFmt = fmt(potential_low_total)
  const highFmt = fmt(potential_high_total)
  const rangeText =
    lowFmt && highFmt && potential_low_total !== potential_high_total
      ? `${lowFmt} – ${highFmt}`
      : lowFmt || highFmt || 'Amount varies'

  return (
    <Card data-testid="anya-potential-summary">
      <CardHeader>
        <CardTitle>Possible funding matches</CardTitle>
        <CardDescription>
          Anya found {total_matches} {total_matches === 1 ? 'opportunity' : 'opportunities'} that look relevant.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant="default">{strong_matches} strong matches</Badge>
          <Badge variant="secondary">{review_matches} need review</Badge>
          {amount_unknown_count > 0 ? (
            <Badge variant="outline">{amount_unknown_count} with amount varies</Badge>
          ) : null}
        </div>
        <div>
          <div className="text-sm text-muted-foreground">Potential funding range</div>
          <div className="text-2xl font-semibold">{rangeText}</div>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Potential funding amounts are based on published opportunity information and are not guaranteed.
            We don&apos;t add up unknown amounts as if they were guaranteed money.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export default AnyaPotentialFundingSummary
