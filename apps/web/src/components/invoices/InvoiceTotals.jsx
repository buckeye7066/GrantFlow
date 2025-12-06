import React, { useMemo } from 'react';

/** Safe toFixed with fallback */
const safeToFixed = (val, decimals = 2) => {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return '0.00';
  try {
    return num.toFixed(decimals);
  } catch {
    return '0.00';
  }
};

/**
 * Invoice totals section with subtotal, discount, tax, and balance due
 */
export default function InvoiceTotals({ invoice = {} }) {
  const { subtotal, discountAmount, taxAmount, total, amountPaid, balanceDue, discountDescription } = useMemo(() => ({
    subtotal: typeof invoice?.subtotal === 'number' ? invoice.subtotal : 0,
    discountAmount: typeof invoice?.discount_amount === 'number' ? invoice.discount_amount : 0,
    taxAmount: typeof invoice?.tax_amount === 'number' ? invoice.tax_amount : 0,
    total: typeof invoice?.total === 'number' ? invoice.total : 0,
    amountPaid: typeof invoice?.amount_paid === 'number' ? invoice.amount_paid : 0,
    balanceDue: typeof invoice?.balance_due === 'number' ? invoice.balance_due : 0,
    discountDescription: invoice?.discount_description || '',
  }), [invoice]);

  return (
    <div className="mb-8" role="region" aria-label="Invoice totals">
      <dl className="max-w-md ml-auto space-y-2">
        <div className="flex justify-between py-2 border-b border-slate-200">
          <dt className="text-slate-600">Subtotal:</dt>
          <dd className="font-medium">${safeToFixed(subtotal)}</dd>
        </div>

        {discountAmount > 0 && (
          <div className="flex justify-between py-2 border-b border-slate-200">
            <dt className="text-emerald-600">
              Discount{discountDescription ? ` (${discountDescription})` : ''}:
            </dt>
            <dd className="font-medium text-emerald-600">
              -${safeToFixed(discountAmount)}
            </dd>
          </div>
        )}

        {taxAmount > 0 && (
          <div className="flex justify-between py-2 border-b border-slate-200">
            <dt className="text-slate-600">Tax:</dt>
            <dd className="font-medium">${safeToFixed(taxAmount)}</dd>
          </div>
        )}

        <div className="flex justify-between py-3 border-b-2 border-slate-300">
          <dt className="text-lg font-semibold text-slate-900">Total:</dt>
          <dd className="text-lg font-bold text-slate-900">${safeToFixed(total)}</dd>
        </div>

        {amountPaid > 0 && (
          <div className="flex justify-between py-2">
            <dt className="text-slate-600">Amount Paid:</dt>
            <dd className="font-medium text-emerald-600">-${safeToFixed(amountPaid)}</dd>
          </div>
        )}

        <div className="flex justify-between py-3 bg-blue-50 rounded-lg px-4">
          <dt className="text-xl font-bold text-blue-900">Balance Due:</dt>
          <dd className="text-xl font-bold text-blue-900">${safeToFixed(balanceDue)}</dd>
        </div>
      </dl>
    </div>
  );
}