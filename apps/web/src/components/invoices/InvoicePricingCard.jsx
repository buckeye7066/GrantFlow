import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DollarSign } from 'lucide-react';

export default function InvoicePricingCard({ pricingInfo, formData, updateField }) {
  if (!pricingInfo) return null;

  const finalFee = formData.fee_override && !isNaN(parseFloat(formData.fee_override))
    ? parseFloat(formData.fee_override)
    : pricingInfo.finalFee;

  const finalDiscount = formData.discount_override && !isNaN(parseFloat(formData.discount_override))
    ? parseFloat(formData.discount_override)
    : pricingInfo.discountAmount;

  return (
    <Card className={`border-l-4 ${pricingInfo.qualifiesForProBono ? 'border-l-emerald-600' : 'border-l-emerald-600'}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="w-5 h-5" />
          Pricing & Overrides
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`p-4 rounded-lg space-y-2 ${pricingInfo.qualifiesForProBono ? 'bg-emerald-50 border-2 border-emerald-300' : 'bg-slate-50'}`}>
          <div className="flex justify-between">
            <span>Calculated Fee:</span>
            <span className="font-bold">${(finalFee + finalDiscount).toFixed(2)}</span>
          </div>
          {finalDiscount > 0 && (
            <div className={`flex justify-between ${pricingInfo.qualifiesForProBono ? 'text-emerald-700 font-semibold' : 'text-emerald-600'}`}>
              <span>{pricingInfo.discountDescription}:</span>
              <span className="font-bold">-${finalDiscount.toFixed(2)}</span>
            </div>
          )}
          <div className={`flex justify-between text-lg font-bold border-t pt-2 ${pricingInfo.qualifiesForProBono ? 'border-emerald-400 text-emerald-800' : ''}`}>
            <span>Total Due:</span>
            <span>${finalFee.toFixed(2)}</span>
          </div>
          {pricingInfo.qualifiesForProBono && (
            <div className="text-xs text-emerald-700 mt-2 pt-2 border-t border-emerald-300">
              <strong>Tax Write-Off Documentation:</strong> Full service value (${finalDiscount.toFixed(2)}) will be documented on invoice with 100% discount applied.
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 pt-4 border-t">
          <div>
            <Label htmlFor="fee_override">Fee Override ($)</Label>
            <Input
              id="fee_override"
              type="number"
              step="0.01"
              value={formData.fee_override}
              onChange={(e) => updateField('fee_override', e.target.value)}
              placeholder={`Default: ${pricingInfo.finalFee.toFixed(2)}`}
              disabled={pricingInfo.qualifiesForProBono}
            />
            <p className="text-xs text-slate-500 mt-1">Leave blank to use calculated fee</p>
          </div>

          <div>
            <Label htmlFor="discount_override">Discount Override ($)</Label>
            <Input
              id="discount_override"
              type="number"
              step="0.01"
              value={formData.discount_override}
              onChange={(e) => updateField('discount_override', e.target.value)}
              placeholder={pricingInfo.discountAmount > 0 ? `Default: ${pricingInfo.discountAmount.toFixed(2)}` : 'No discount'}
              disabled={pricingInfo.qualifiesForProBono}
            />
            <p className="text-xs text-slate-500 mt-1">Manual discount amount</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}