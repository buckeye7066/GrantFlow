import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useMemo } from 'react';

/**
 * Custom hook for fetching and managing invoice data with RLS support
 * @param {string} invoiceId - Invoice ID to fetch
 * @param {Object} options - Optional config { user, isAdmin }
 * @returns {Object} Invoice data with loading and error states
 */
export function useInvoiceData(invoiceId, options = {}) {
  const { user, isAdmin } = options;

  // Fetch current user if not provided
  const { data: currentUser, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
    enabled: !user,
  });

  const activeUser = user || currentUser;
  const activeIsAdmin = isAdmin ?? (activeUser?.email === 'buckeye7066@gmail.com');

  const { data: invoice, isLoading: isLoadingInvoice, error: invoiceError } = useQuery({
    queryKey: ['invoice', invoiceId, activeUser?.email, activeIsAdmin],
    queryFn: async () => {
      if (activeIsAdmin) {
        return base44.entities.Invoice.get(invoiceId);
      }
      const results = await base44.entities.Invoice.filter({ id: invoiceId, created_by: activeUser.email });
      return results?.[0] || null;
    },
    enabled: !!invoiceId && !!activeUser?.email,
  });

  const { data: organization, isLoading: isLoadingOrg } = useQuery({
    queryKey: ['organization', invoice?.organization_id, activeUser?.email, activeIsAdmin],
    queryFn: async () => {
      if (activeIsAdmin) {
        return base44.entities.Organization.get(invoice.organization_id);
      }
      const results = await base44.entities.Organization.filter({
        id: invoice.organization_id,
        created_by: activeUser.email,
      });
      return results?.[0] || null;
    },
    enabled: !!invoice?.organization_id && !!activeUser?.email,
  });

  const { data: project, isLoading: isLoadingProject } = useQuery({
    queryKey: ['project', invoice?.project_id, activeUser?.email],
    queryFn: () => base44.entities.Project.get(invoice.project_id),
    enabled: !!invoice?.project_id && !!activeUser?.email,
  });

  const { data: lineItems = [], isLoading: isLoadingLines } = useQuery({
    queryKey: ['invoiceLines', invoiceId, activeUser?.email],
    queryFn: () => base44.entities.InvoiceLine.filter({ invoice_id: invoiceId }),
    enabled: !!invoiceId && !!activeUser?.email && !!invoice,
  });

  // Memoized sorted line items
  const sortedLineItems = useMemo(() => 
    [...lineItems].sort((a, b) => (a.line_order || 0) - (b.line_order || 0)),
    [lineItems]
  );

  const isLoading = isLoadingUser || isLoadingInvoice || isLoadingOrg || isLoadingProject || isLoadingLines;

  return {
    invoice,
    organization,
    project,
    lineItems: sortedLineItems,
    isLoading,
    error: invoiceError,
    user: activeUser,
    isAdmin: activeIsAdmin,
  };
}