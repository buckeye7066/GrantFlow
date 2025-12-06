import React, { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuthContext } from "@/components/hooks/useAuthRLS";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useToast } from "@/components/ui/use-toast";
import { Loader2 } from "lucide-react";

// Hooks
import { useInvoiceForm } from "@/components/hooks/useInvoiceForm";
import { useInvoicePricing } from "@/components/hooks/useInvoicePricing";

// Components
import InvoiceClientInfoCard from "@/components/invoices/InvoiceClientInfoCard";
import InvoiceServiceDetailsCard from "@/components/invoices/InvoiceServiceDetailsCard";
import InvoicePricingCard from "@/components/invoices/InvoicePricingCard";
import InvoicePaymentTermsCard from "@/components/invoices/InvoicePaymentTermsCard";
import EthicalBillingNotice from "@/components/invoices/EthicalBillingNotice";
import InvoiceActionBar from "@/components/invoices/InvoiceActionBar";

// Helpers
import { 
  generateInvoiceNumber, 
  validateInvoice, 
  calculateDueDate,
  getMilestoneDescription 
} from "@/components/invoices/invoiceHelpers";

// Contract terms template
const CONTRACT_TERMS = `SERVICE AGREEMENT

This invoice serves as a binding contract between John White (Consultant) and the Client listed above.

COMPENSATION TERMS:
• Compensation is for professional services rendered and is not contingent on award outcomes
• No percentage-based or commission compensation will ever be accepted
• Fees are based on time, expertise, and deliverables as outlined in the scope of work

PAYMENT TERMS:
• {{milestone_description}}
• Payment is due {{payment_terms}}
• Late payments subject to 1.5% monthly interest

FUNDER COMPLIANCE:
• Client understands some funders prohibit consultant payment from grant funds
• In such cases, invoices are paid by Client from non-grant funds
• Consultant will identify allowable costs where applicable

CONFIDENTIALITY:
• Health, immigration, and financial data will be safeguarded
• Records released only with written consent or as required by law

BENEVOLENCE POLICY:
• At Consultant's discretion, fees may be reduced or waived for hardship cases
• Any such reduction will not alter scope quality
• This reflects "The worker is worthy of his wages" (Luke 10:7) and mercy for those in need

CANCELLATION & REFUNDS:
• Client cancels before first draft → refund unworked portion (pro-rata)
• Consultant misses mutually agreed deadline due to error → full refund of that milestone

By accepting this invoice, Client agrees to these terms.`;

export default function CreateInvoice() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // M5 FIX: Use centralized auth context instead of duplicate query
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // Get organization_id from URL if provided
  const urlParams = new URLSearchParams(window.location.search);
  const preselectedOrgId = urlParams.get('organization_id');

  // Form state management
  const { formData, updateField } = useInvoiceForm({
    organization_id: preselectedOrgId || "",
    project_id: "",
    payment_terms: "net_15",
    payment_option: "organization_pays",
    milestone_type: "kickoff",
    notes: "",
    issue_date: new Date().toISOString().split('T')[0],
    service_description: "",
    service_type: "",
    rate_override: "",
    fee_override: "",
    discount_override: "",
  });

  // Update formData when preselectedOrgId changes
  useEffect(() => {
    if (preselectedOrgId) {
      updateField('organization_id', preselectedOrgId);
    }
  }, [preselectedOrgId, updateField]);

  // Data queries with RLS filtering
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Organization.list()
        : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const { data: projects = [] } = useQuery({
    queryKey: ['projects', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Project.list()
        : base44.entities.Project.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const { data: settings } = useQuery({
    queryKey: ['billingSettings', user?.email],
    queryFn: async () => {
      const results = await base44.entities.BillingSettings.list();
      return results[0] || {};
    },
    enabled: !!user?.email,
  });

  const { data: timeEntries = [] } = useQuery({
    queryKey: ['unbilledTime', user?.email, isAdmin, formData.organization_id],
    queryFn: () =>
      isAdmin
        ? base44.entities.TimeEntry.filter({
            organization_id: formData.organization_id,
            invoiced: false,
          })
        : base44.entities.TimeEntry.filter({
            organization_id: formData.organization_id,
            invoiced: false,
            created_by: user?.email,
          }),
    enabled: !!user?.email && !!formData.organization_id,
  });

  // Get selected organization
  const selectedOrg = organizations.find(o => o.id === formData.organization_id);

  // Calculate pricing using custom hook
  const pricingInfo = useInvoicePricing(formData, selectedOrg, settings, timeEntries);

  // Apply overrides to pricing
  const finalPricing = React.useMemo(() => {
    if (!pricingInfo) return null;

    const result = { ...pricingInfo };

    if (formData.fee_override && !isNaN(parseFloat(formData.fee_override))) {
      result.finalFee = parseFloat(formData.fee_override);
    }

    if (formData.discount_override && !isNaN(parseFloat(formData.discount_override))) {
      result.discountAmount = parseFloat(formData.discount_override);
      result.discountDescription = 'Manual Discount Override';
    }

    return result;
  }, [pricingInfo, formData.fee_override, formData.discount_override]);

  // Invoice creation mutation - H8 FIX: Await invalidation and refetch before navigation
  const createInvoiceMutation = useMutation({
    mutationFn: (data) => base44.entities.Invoice.create(data),
    onSuccess: async (invoice) => {
      await queryClient.invalidateQueries({ queryKey: ['invoices', user?.email, isAdmin] });
      await queryClient.refetchQueries({ queryKey: ['invoice', invoice.id, user?.email, isAdmin] });
      
      toast({
        title: "Invoice Created",
        description: `Invoice ${invoice.invoice_number} has been created successfully.`,
      });
      navigate(createPageUrl('InvoiceView') + `?id=${invoice.id}`);
    },
    onError: (error) => {
      const message =
        error instanceof Error
          ? error.message
          : error?.message || "Unknown error occurred while creating invoice.";
      toast({
        variant: "destructive",
        title: "Failed to Create Invoice",
        description: message,
      });
    }
  });

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Check finalPricing is ready
    if (!finalPricing) {
      toast({
        variant: "destructive",
        title: "Pricing Not Ready",
        description: "Unable to calculate invoice totals. Please review pricing settings.",
      });
      return;
    }

    // Validate form
    const validation = validateInvoice(formData, finalPricing);
    if (!validation.isValid) {
      toast({
        variant: "destructive",
        title: "Invalid Input",
        description: validation.error,
      });
      return;
    }

    // Generate invoice number
    const invoiceNumber = generateInvoiceNumber(settings?.last_invoice_number || 0);

    // Calculate due date
    const dueDate = calculateDueDate(formData.issue_date, formData.payment_terms);

    // Build contract terms
    const contractTerms = CONTRACT_TERMS
      .replace('{{milestone_description}}', getMilestoneDescription(formData.milestone_type))
      .replace('{{payment_terms}}', formData.payment_terms.replace('_', ' ').replace('net', 'Net'));

    // Build invoice data
    const invoiceData = {
      organization_id: formData.organization_id,
      project_id: formData.project_id || null,
      invoice_number: invoiceNumber,
      issue_date: formData.issue_date,
      due_date: dueDate,
      payment_terms: formData.payment_terms,
      payment_option: formData.payment_option,
      subtotal: (finalPricing.finalFee + finalPricing.discountAmount),
      discount_amount: finalPricing.discountAmount,
      discount_description: finalPricing.discountDescription,
      tax_amount: 0,
      total: finalPricing.finalFee,
      balance_due: finalPricing.finalFee,
      amount_paid: 0,
      status: finalPricing.qualifiesForProBono ? 'Paid' : 'Draft',
      notes: formData.notes,
      contract_terms: contractTerms,
      client_category: finalPricing.category,
      qualifies_for_hardship: finalPricing.qualifiesForHardship,
      qualifies_for_ministry_discount: finalPricing.qualifiesForMinistryDiscount,
      rate_override: formData.rate_override ? parseFloat(formData.rate_override) : null,
      fee_override: formData.fee_override ? parseFloat(formData.fee_override) : null,
      milestone_type: formData.milestone_type,
    };

    // Create invoice
    await createInvoiceMutation.mutateAsync(invoiceData);

    // Update billing settings with new invoice number
    if (settings?.id) {
      const nextNumber = (settings.last_invoice_number || 0) + 1;
      await base44.entities.BillingSettings.update(settings.id, {
        last_invoice_number: nextNumber,
      });
    }

    // Mark time entries as invoiced if applicable
    if (formData.service_type === 'hourly_time' && timeEntries.length > 0) {
      await Promise.all(
        timeEntries.map(entry =>
          base44.entities.TimeEntry.update(entry.id, { invoiced: true })
        )
      );
    }
  };

  const unbilledHours = timeEntries.reduce((sum, entry) => sum + (entry.rounded_minutes || 0), 0) / 60;
  const unbilledAmount = unbilledHours * (pricingInfo?.baseRate || 0);

  // Loading state
  if (isLoadingUser || isLoadingOrgs) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Create Invoice</h1>
          <p className="text-slate-600 mt-2">Generate ethical invoices for services</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <InvoiceClientInfoCard
            organizations={organizations}
            selectedOrgId={formData.organization_id}
            onOrgChange={(value) => updateField('organization_id', value)}
            selectedOrg={selectedOrg}
            pricingInfo={pricingInfo}
            unbilledHours={unbilledHours}
            unbilledAmount={unbilledAmount}
          />

          <InvoiceServiceDetailsCard
            formData={formData}
            updateField={updateField}
            projects={projects}
            selectedOrgId={formData.organization_id}
          />

          <InvoicePricingCard
            pricingInfo={pricingInfo}
            formData={formData}
            updateField={updateField}
          />

          <InvoicePaymentTermsCard
            formData={formData}
            updateField={updateField}
            isProBono={finalPricing?.qualifiesForProBono}
          />

          <EthicalBillingNotice />

          <InvoiceActionBar
            isSubmitting={createInvoiceMutation.isPending}
            isValid={!!formData.organization_id && !!formData.service_type}
          />
        </form>
      </div>
    </div>
  );
}