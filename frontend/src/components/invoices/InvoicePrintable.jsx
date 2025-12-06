import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import InvoiceHeader from './InvoiceHeader';
import BillToInfo from './BillToInfo';
import ClientClassification from './ClientClassification';
import LineItemTable from './LineItemTable';
import InvoiceTotals from './InvoiceTotals';
import EthicalStandardsNote from './EthicalStandardsNote';
import PaymentInstructions from './PaymentInstructions';
import InvoiceFooter from './InvoiceFooter';

/**
 * Complete printable invoice layout
 */
const InvoicePrintable = React.forwardRef(({ 
  invoice, 
  organization, 
  lineItems 
}, ref) => {
  return (
    <div ref={ref} className="max-w-4xl mx-auto p-6">
      <Card className="shadow-xl border-0">
        <CardContent className="p-8">
          <InvoiceHeader invoice={invoice} />
          <BillToInfo organization={organization} />
          <ClientClassification invoice={invoice} />
          <LineItemTable lineItems={lineItems} />
          <InvoiceTotals invoice={invoice} />
          <EthicalStandardsNote />
          <PaymentInstructions invoice={invoice} />
          <InvoiceFooter invoice={invoice} />
        </CardContent>
      </Card>
    </div>
  );
});

InvoicePrintable.displayName = 'InvoicePrintable';

export default InvoicePrintable;