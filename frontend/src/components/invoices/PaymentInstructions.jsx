import React from 'react';

/**
 * Payment instructions and mailing information
 */
export default function PaymentInstructions({ invoice }) {
  const paymentTermsLabels = {
    net_15: 'Net 15 Days',
    net_30: 'Net 30 Days',
    net_45: 'Net 45 Days',
    due_on_receipt: 'Due Upon Receipt',
  };

  return (
    <div className="mb-6 p-4 bg-slate-50 border border-slate-200 rounded-lg">
      <h4 className="font-semibold text-slate-900 mb-2">Payment Instructions</h4>
      <div className="text-sm text-slate-700 space-y-2">
        <p>
          <strong>Terms:</strong>{' '}
          {paymentTermsLabels[invoice.payment_terms] || invoice.payment_terms || 'Net 30 Days'}
        </p>
        <p>
          <strong>Payment Methods:</strong>
        </p>
        <ul className="space-y-1 ml-4 mt-1">
          <li><strong>Check</strong> - Make payable to: <span className="font-semibold">John White</span></li>
          <li><strong>Venmo:</strong> @John-White-1384</li>
          <li><strong>CashApp:</strong> $jwhiternmba</li>
          <li>ACH / Bank Transfer</li>
          <li>Wire Transfer</li>
          <li>Credit Card (processing fee may apply)</li>
        </ul>
        <div className="mt-3">
          <p className="text-slate-600 text-xs">
            Please include invoice number with payment
          </p>
        </div>
      </div>
    </div>
  );
}