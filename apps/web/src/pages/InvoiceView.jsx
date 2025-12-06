import React from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Loader2, AlertCircle, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import InvoiceActionBar from '@/components/invoices/InvoiceActionBar';
import InvoicePrintable from '@/components/invoices/InvoicePrintable';
import { useToast } from '@/components/ui/use-toast';
import { createPageUrl } from '@/utils';

export default function InvoiceView() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const rawId = searchParams.get('id');
  const invoiceId = rawId && rawId !== 'undefined' && rawId !== 'null' ? rawId : null;
  const { toast } = useToast();

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // Admin-safe helper (WHY: avoid throwing on not-found)
  const safeGet = async (entity, id) => {
    if (!id) return null;
    try {
      return await entity.get(id);
    } catch {
      return null;
    }
  };

  // Fetch invoice with RLS filtering
  const {
    data: invoice,
    isLoading: isLoadingInvoice,
    error: invoiceError,
  } = useQuery({
    queryKey: ['invoice', invoiceId, user?.email, isAdmin],
    queryFn: async () => {
      if (!invoiceId) return null;
      if (isAdmin) {
        return safeGet(base44.entities.Invoice, invoiceId);
      }
      const results = await base44.entities.Invoice.filter({
        id: invoiceId,
        created_by: user?.email,
      });
      return results?.[0] || null;
    },
    enabled: !!invoiceId && !!user?.email,
  });

  // Fetch organization with RLS filtering
  const { data: organization, isLoading: isLoadingOrg } = useQuery({
    queryKey: ['organization', invoice?.organization_id, user?.email, isAdmin],
    queryFn: async () => {
      if (!invoice?.organization_id) return null;
      if (isAdmin) {
        return safeGet(base44.entities.Organization, invoice.organization_id);
      }
      const results = await base44.entities.Organization.filter({
        id: invoice.organization_id,
        created_by: user?.email,
      });
      return results?.[0] || null;
    },
    enabled: !!invoice?.organization_id && !!user?.email,
  });

  // Fetch line items
  const { data: lineItems = [], isLoading: isLoadingLines } = useQuery({
    queryKey: ['invoiceLines', invoiceId, user?.email],
    queryFn: () => base44.entities.InvoiceLine.filter({ invoice_id: invoiceId }),
    enabled: !!invoiceId && !!user?.email && !!invoice,
  });

  // Sorted line items
  const sortedLineItems = React.useMemo(
    () => [...lineItems].sort((a, b) => (a.line_order || 0) - (b.line_order || 0)),
    [lineItems]
  );

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = () => {
    toast({
      title: 'Feature Coming Soon',
      description: 'PDF download functionality will be available in a future update.',
    });
  };

  const isLoading = isLoadingUser || isLoadingInvoice || isLoadingOrg || isLoadingLines;

  // Guard: invalid/missing id param
  if (!invoiceId && !isLoadingUser) {
    return (
      <div className="p-6 md:p-8">
        <Card className="max-w-lg mx-auto">
          <CardContent className="p-12 text-center">
            <ShieldAlert className="w-16 h-16 mx-auto text-amber-400 mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">No Invoice Selected</h3>
            <p className="text-slate-600 mb-6">
              Please select an invoice from Billing to view its details.
            </p>
            <Button onClick={() => navigate(createPageUrl('Billing'))}>
              Back to Billing
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading invoice...</p>
        </div>
      </div>
    );
  }

  // Access denied - invoice not found or user doesn't own it
  if (!invoice) {
    return (
      <div className="p-6 md:p-8">
        <Card className="max-w-lg mx-auto">
          <CardContent className="p-12 text-center">
            <ShieldAlert className="w-16 h-16 mx-auto text-red-400 mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">Access Denied</h3>
            <p className="text-slate-600 mb-6">
              You do not have permission to view this invoice, or it does not exist.
            </p>
            <Button onClick={() => navigate(createPageUrl('Billing'))}>
              Back to Billing
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Organization access check
  if (!organization && invoice?.organization_id) {
    return (
      <div className="p-6 md:p-8">
        <Card className="max-w-lg mx-auto">
          <CardContent className="p-12 text-center">
            <ShieldAlert className="w-16 h-16 mx-auto text-red-400 mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">Access Denied</h3>
            <p className="text-slate-600 mb-6">
              You do not have permission to view the organization associated with this invoice.
            </p>
            <Button onClick={() => navigate(createPageUrl('Billing'))}>
              Back to Billing
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state
  if (invoiceError) {
    return (
      <div className="p-6 md:p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {invoiceError?.message || 'Invoice could not be loaded.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="no-print">
        <InvoiceActionBar onPrint={handlePrint} onDownload={handleDownload} />
      </div>

      <InvoicePrintable invoice={invoice} organization={organization} lineItems={sortedLineItems} />

      {/* Print styles */}
      <style>{`
        @media print {
          body { background: white; }
          .no-print { display: none !important; }
          @page { margin: 0.5in; }
        }
      `}</style>
    </div>
  );
}