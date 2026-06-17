import React, { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, Trash2, Plus } from 'lucide-react'
import { formatMoney } from './pricingFormatters'

/**
 * Discount approve/edit/add panel. Stateless except for the manual-add form;
 * everything else is driven through props so the parent quote view stays the
 * source of truth.
 */
export function PricingDiscountEditor({ discounts = [], onApprove, onRemove, onAdd }) {
  const [form, setForm] = useState({ amount: '', reason: '', discount_key: 'manual_admin' })

  function submit(e) {
    e?.preventDefault?.()
    if (!onAdd) return
    const amount = Number(form.amount)
    if (!Number.isFinite(amount) || amount <= 0) return
    onAdd({ ...form, amount })
    setForm({ amount: '', reason: '', discount_key: 'manual_admin' })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discounts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {discounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No discounts on this quote.</p>
        ) : (
          <ul className="space-y-2">
            {discounts.map((d) => (
              <li
                key={d.id || `${d.discount_key}_${d.amount}`}
                className="flex items-start justify-between rounded-md border p-3 text-sm"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{d.label || d.discount_key}</span>
                    {d.approved ? (
                      <Badge variant="default">Approved</Badge>
                    ) : (
                      <Badge variant="outline">Pending approval</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{d.reason || ''}</div>
                  <div className="text-xs">{formatMoney(d.amount)}</div>
                </div>
                <div className="flex gap-2">
                  {!d.approved && onApprove ? (
                    <Button variant="outline" size="sm" onClick={() => onApprove(d.id)}>
                      <CheckCircle2 className="mr-1 h-4 w-4" />
                      Approve
                    </Button>
                  ) : null}
                  {onRemove ? (
                    <Button variant="ghost" size="sm" onClick={() => onRemove(d.id)}>
                      <Trash2 className="mr-1 h-4 w-4" />
                      Remove
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {onAdd ? (
          <form onSubmit={submit} className="grid gap-2 rounded-md border p-3 sm:grid-cols-3">
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="Amount"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              required
            />
            <Input
              placeholder="Reason (required)"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              required
            />
            <Button type="submit" variant="default">
              <Plus className="mr-1 h-4 w-4" />
              Add manual discount
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}

export default PricingDiscountEditor
