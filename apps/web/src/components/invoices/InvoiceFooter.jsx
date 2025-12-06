import React from 'react';

/**
 * Invoice footer with disclaimer and notes
 */
export default function InvoiceFooter({ invoice }) {
  return (
    <div className="pt-6 border-t border-slate-200 text-center">
      <p className="text-xs text-slate-500 mb-2">
        Thank you for your business. If you have any questions about this invoice, 
        please contact us immediately.
      </p>
      {invoice.notes && (
        <div className="mt-4 p-3 bg-slate-50 rounded text-left">
          <p className="text-xs font-semibold text-slate-700 mb-1">Notes:</p>
          <p className="text-sm text-slate-600 whitespace-pre-wrap">{invoice.notes}</p>
        </div>
      )}
      {invoice.contract_terms && (
        <div className="mt-4 p-3 bg-slate-50 rounded text-left">
          <p className="text-xs font-semibold text-slate-700 mb-1">Contract Terms:</p>
          <p className="text-xs text-slate-600 whitespace-pre-wrap">{invoice.contract_terms}</p>
        </div>
      )}
    </div>
  );
}