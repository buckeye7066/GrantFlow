import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatMoney, categoryLabel } from './pricingFormatters'

/**
 * Read-only line-items table. Editing flows through the parent component
 * via `onEdit(lineItemId, updates)`.
 */
export function PricingQuoteLineItems({ lineItems = [], category }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Line items {category ? `· ${categoryLabel(category)}` : ''}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {lineItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No line items recommended.</p>
        ) : (
          <div className="space-y-2">
            {lineItems.map((li) => (
              <div key={li.id || li.service_key} className="rounded-md border p-3 text-sm">
                <div className="flex justify-between">
                  <span className="font-medium">{li.service_name}</span>
                  <span>{formatMoney(li.subtotal)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatMoney(li.base_price)} × {Number(li.quantity || 1)} ({categoryLabel(li.client_category)})
                </div>
                {li.reason ? (
                  <div className="mt-1 text-xs italic text-muted-foreground">{li.reason}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default PricingQuoteLineItems
