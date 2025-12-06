import React from 'react';
import { format } from 'date-fns';

/**
 * Invoice header with logo, number, and dates
 */
export default function InvoiceHeader({ invoice }) {
  const formatSafeDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return 'N/A';
      return format(date, 'MMM d, yyyy');
    } catch (error) {
      return 'N/A';
    }
  };

  return (
    <div className="flex justify-between items-start mb-8">
      <div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2">INVOICE</h1>
        <p className="text-xl text-slate-600">#{invoice?.invoice_number || 'N/A'}</p>
      </div>
      <div className="text-right">
        <div className="w-16 h-16 bg-gradient-to-br from-blue-600 to-blue-800 rounded-xl flex items-center justify-center shadow-lg mb-4">
          <span className="text-2xl font-bold text-white">GW</span>
        </div>
        <div className="space-y-1 text-sm">
          <div>
            <span className="text-slate-500">Issue Date:</span>{' '}
            <span className="font-medium">
              {formatSafeDate(invoice?.issue_date)}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Due Date:</span>{' '}
            <span className="font-medium">
              {formatSafeDate(invoice?.due_date)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}