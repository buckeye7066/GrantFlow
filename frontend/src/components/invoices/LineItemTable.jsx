import React, { useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FileText } from 'lucide-react';

/** Safe toFixed */
const safeToFixed = (val, decimals = 2) => {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return null;
  try {
    return num.toFixed(decimals);
  } catch {
    return null;
  }
};

/**
 * Invoice line items table
 */
export default function LineItemTable({ lineItems = [] }) {
  const safeItems = useMemo(() => (Array.isArray(lineItems) ? lineItems : []), [lineItems]);

  if (safeItems.length === 0) {
    return (
      <div className="mb-6 p-8 text-center text-slate-500 border border-slate-200 rounded-lg" role="status">
        <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300" aria-hidden="true" />
        No line items for this invoice
      </div>
    );
  }

  return (
    <div className="mb-6" role="region" aria-label="Invoice line items">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="font-bold">Description</TableHead>
            <TableHead className="text-right font-bold">Quantity</TableHead>
            <TableHead className="text-right font-bold">Rate</TableHead>
            <TableHead className="text-right font-bold">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {safeItems.map((item) => {
            const key = item?.id || `item-${item?.description || Math.random()}`;
            const description = item?.description || 'No description';
            const quantityFormatted = safeToFixed(item?.quantity);
            const rateFormatted = safeToFixed(item?.unit_price);
            const amountFormatted = safeToFixed(item?.amount ?? 0);

            return (
              <TableRow key={key}>
                <TableCell>
                  <div>
                    <p className="font-medium">{description}</p>
                    {item?.task_category && (
                      <p className="text-xs text-slate-500 mt-1">
                        Category: {item.task_category}
                      </p>
                    )}
                    {item?.is_grant_chargeable && (
                      <p className="text-xs text-emerald-600 mt-1">
                        ✓ Grant-eligible expense
                      </p>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {quantityFormatted ?? '-'}
                </TableCell>
                <TableCell className="text-right">
                  {rateFormatted ? `$${rateFormatted}` : '-'}
                </TableCell>
                <TableCell className="text-right font-medium">
                  ${amountFormatted ?? '0.00'}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}