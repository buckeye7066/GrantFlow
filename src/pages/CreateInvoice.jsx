
import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import client from '@/api/client';
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, AlertCircle, DollarSign, Building2, FileText, CheckCircle2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

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

  // Get organization_id from URL if provided
  const urlParams = new URLSearchParams(window.location.search);
  const preselectedOrgId = urlParams.get('organization_id');

  const [formData, setFormData] = useState({
    organization_id: preselectedOrgId || "",
    project_id: "",
    payment_terms: "net_15",
    payment_option: "organization_pays",
    milestone_type: "kickoff",
    notes: "",
    issue_date: new Date().toISOString().split('T')[0],
    service_description: "",
    service_type: "",
    // Override fields
    rate_override: "",
    fee_override: "",
    discount_override: "",
  });

  // Update formData when preselectedOrgId changes
  React.useEffect(() => {
    if (preselectedOrgId) {
      setFormData(prev => ({ ...prev, organization_id: preselectedOrgId }));
    }
  }, [preselectedOrgId]);

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list('name'),
  });

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => client.entities.Project.list('-created_date'),
  });

  const { data: settings } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: async () => {
      const results = await client.entities.BillingSettings.list();
      return results[0] || {};
    },
  });

  const { data: timeEntries = [] } = useQuery({
    queryKey: ['unbilledTime', formData.organization_id],
    queryFn: () => client.entities.TimeEntry.filter({
      organization_id: formData.organization_id,
      invoiced: false,
    }),
    enabled: !!formData.organization_id,
  });

  const createInvoiceMutation = useMutation({
    mutationFn: (data) => client.entities.Invoice.create(data),
    onSuccess: (invoice) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast({
        title: "Invoice Created",
        description: `Invoice ${invoice.invoice_number} has been created successfully.`,
      });
      navigate(createPageUrl("InvoiceView", { id: invoice.id }));
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to Create Invoice",
        description: error.message,
      });
    }
  });

  const selectedOrg = organizations.find(o => o.id === formData.organization_id);

  // Calculate client category and pricing
  const pricingInfo = useMemo(() => {
    if (!selectedOrg || !settings) return null;

    const result = {
      category: 'large_org',
      qualifiesForHardship: false,
      qualifiesForMinistryDiscount: false,
      qualifiesForProBono: selectedOrg.pro_bono || false,
      baseRate: settings.hourly_rates?.large_org || 150,
      calculatedFee: 0,
      discountAmount: 0,
      discountDescription: '',
      finalFee: 0,
    };

    // Determine category
    if (['individual_need', 'medical_assistance', 'family', 'high_school_student', 'college_student', 'graduate_student'].includes(selectedOrg.applicant_type)) {
      result.category = 'individual_household';
      result.baseRate = settings.hourly_rates?.individual_household || 85;
    } else if (selectedOrg.annual_budget && selectedOrg.annual_budget < 250000) {
      result.category = 'small_ministry_nonprofit';
      result.baseRate = settings.hourly_rates?.small_ministry_nonprofit || 85;
    } else if (selectedOrg.annual_budget && selectedOrg.annual_budget <= 2000000) {
      result.category = 'midsize_org';
      result.baseRate = settings.hourly_rates?.midsize_org || 115;
    }

    // Check hardship qualifications
    const hardshipQualifiers = [
      selectedOrg.ssi_recipient,
      selectedOrg.ssdi_recipient,
      selectedOrg.medicaid_enrolled && selectedOrg.medicaid_waiver_program === 'ecf_choices',
      selectedOrg.cancer_survivor && selectedOrg.cancer_diagnosis_year && (new Date().getFullYear() - selectedOrg.cancer_diagnosis_year <= 5),
      selectedOrg.medicaid_enrolled,
      selectedOrg.household_income && selectedOrg.household_size && (selectedOrg.household_income / selectedOrg.household_size < 25000), // Rough 250% FPL estimate
      selectedOrg.domestic_violence_survivor,
      selectedOrg.trafficking_survivor,
      selectedOrg.disaster_survivor,
      selectedOrg.clergy && selectedOrg.household_income && selectedOrg.household_income < 40000,
    ];

    result.qualifiesForHardship = hardshipQualifiers.some(q => q === true);

    // Check ministry discount
    result.qualifiesForMinistryDiscount = 
      (selectedOrg.faith_based || selectedOrg.clergy || selectedOrg.missionary) && 
      (!selectedOrg.annual_budget || selectedOrg.annual_budget < 250000);

    // Calculate fee based on service type
    const serviceType = formData.service_type;
    if (serviceType && settings.flat_fees) {
      const fees = settings.flat_fees;
      
      switch (serviceType) {
        case 'quick_scan':
          if (result.category === 'individual_household') {
            result.calculatedFee = fees.quick_eligibility_scan_individual || 149;
          } else if (result.category === 'small_ministry_nonprofit') {
            result.calculatedFee = fees.quick_eligibility_scan_small || 349;
          } else {
            result.calculatedFee = fees.quick_eligibility_scan_large || 750;
          }
          break;
        
        case 'comprehensive_dossier':
          if (result.category === 'individual_household') {
            result.calculatedFee = fees.comprehensive_dossier_individual || 399;
          } else if (result.category === 'small_ministry_nonprofit') {
            result.calculatedFee = fees.comprehensive_dossier_small || 1250;
          } else if (result.category === 'midsize_org') {
            result.calculatedFee = fees.comprehensive_dossier_mid || 2400;
          } else {
            result.calculatedFee = fees.comprehensive_dossier_large || 3800;
          }
          break;
        
        case 'micro_grant':
          result.calculatedFee = fees.micro_grant_min || 600;
          break;
        
        case 'standard_foundation':
          result.calculatedFee = fees.standard_foundation_min || 2000;
          break;
        
        case 'complex_federal':
          result.calculatedFee = fees.complex_federal_min || 5000;
          break;
        
        case 'scholarship_pack':
          result.calculatedFee = fees.transfer_scholarship_pack || 450;
          break;
        
        case 'hourly_time': {
          // Calculate from unbilled time
          const totalMinutes = timeEntries.reduce((sum, entry) => sum + (entry.rounded_minutes || 0), 0);
          const totalHours = totalMinutes / 60;
          result.calculatedFee = totalHours * result.baseRate;
          break;
        }
        
        default:
          result.calculatedFee = 0;
      }
    }

    // Apply hardship caps if applicable
    if (result.qualifiesForHardship && settings.hardship_caps) {
      const caps = settings.hardship_caps;
      
      switch (serviceType) {
        case 'quick_scan':
          if (result.calculatedFee > caps.quick_scan_max) {
            result.discountAmount = result.calculatedFee - caps.quick_scan_max;
            result.calculatedFee = caps.quick_scan_max;
            result.discountDescription = 'Hardship Cap Applied';
          }
          break;
        
        case 'comprehensive_dossier':
          if (result.calculatedFee > caps.dossier_max) {
            result.discountAmount = result.calculatedFee - caps.dossier_max;
            result.calculatedFee = caps.dossier_max;
            result.discountDescription = 'Hardship Cap Applied';
          }
          break;
        
        case 'micro_grant':
          if (result.calculatedFee > caps.micro_grant_max) {
            result.discountAmount = result.calculatedFee - caps.micro_grant_max;
            result.calculatedFee = caps.micro_grant_max;
            result.discountDescription = 'Hardship Cap Applied';
          }
          break;
        
        case 'scholarship_pack':
          if (result.calculatedFee > caps.scholarship_pack_max) {
            result.discountAmount = result.calculatedFee - caps.scholarship_pack_max;
            result.calculatedFee = caps.scholarship_pack_max;
            result.discountDescription = 'Hardship Cap Applied';
          }
          break;
      }
    }

    // Apply ministry discount if no hardship discount already applied
    if (result.qualifiesForMinistryDiscount && result.discountAmount === 0) {
      const ministryDiscount = result.calculatedFee * ((settings.ministry_discount_percent || 25) / 100);
      result.discountAmount = ministryDiscount;
      result.calculatedFee -= ministryDiscount;
      result.discountDescription = `Ministry Discount ${settings.ministry_discount_percent || 25}%`;
    }

    // Apply Pro Bono 100% discount (overrides all other discounts for display, but tracks original amount)
    if (result.qualifiesForProBono && result.calculatedFee > 0) {
      result.discountAmount = result.calculatedFee; // Original fee as discount for tax write-off
      result.calculatedFee = 0; // Final fee becomes 0
      result.discountDescription = 'Pro Bono Service (100% Discount for Tax Write-Off)';
    }

    result.finalFee = result.calculatedFee;

    return result;
  }, [selectedOrg, settings, formData.service_type, timeEntries]);

  // Apply overrides
  const finalPricing = useMemo(() => {
    if (!pricingInfo) return null;

    const result = { ...pricingInfo };

    // Apply manual overrides
    if (formData.fee_override && !isNaN(parseFloat(formData.fee_override))) {
      result.finalFee = parseFloat(formData.fee_override);
    }

    if (formData.discount_override && !isNaN(parseFloat(formData.discount_override))) {
      result.discountAmount = parseFloat(formData.discount_override);
      result.discountDescription = 'Manual Discount Override';
    }

    return result;
  }, [pricingInfo, formData.fee_override, formData.discount_override]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!finalPricing) {
      toast({
        variant: "destructive",
        title: "Cannot Create Invoice",
        description: "Please select an organization and service type.",
      });
      return;
    }

    // Generate invoice number
    const nextNumber = (settings?.last_invoice_number || 0) + 1;
    const now = new Date();
    const invoiceNumber = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${String(nextNumber).padStart(3, '0')}`;

    // Calculate due date
    const dueDate = new Date(formData.issue_date);
    const termsDays = formData.payment_terms === 'net_15' ? 15 : formData.payment_terms === 'net_30' ? 30 : formData.payment_terms === 'net_45' ? 45 : 0;
    dueDate.setDate(dueDate.getDate() + termsDays);

    // Determine milestone description for contract
    const milestoneDescriptions = {
      kickoff: '40% due at project kickoff (scope locked; calendar set)',
      draft_delivery: '40% due at complete draft delivery',
      final_submission: '20% due at submission and handoff package delivery',
      full_payment: 'Full payment due',
    };

    const contractTerms = CONTRACT_TERMS
      .replace('{{milestone_description}}', milestoneDescriptions[formData.milestone_type])
      .replace('{{payment_terms}}', formData.payment_terms.replace('_', ' ').replace('net', 'Net'));

    const invoiceData = {
      organization_id: formData.organization_id,
      project_id: formData.project_id || null,
      invoice_number: invoiceNumber,
      issue_date: formData.issue_date,
      due_date: dueDate.toISOString().split('T')[0],
      payment_terms: formData.payment_terms,
      payment_option: formData.payment_option,
      subtotal: (finalPricing.finalFee + finalPricing.discountAmount),
      discount_amount: finalPricing.discountAmount,
      discount_description: finalPricing.discountDescription,
      tax_amount: 0,
      total: finalPricing.finalFee,
      balance_due: finalPricing.finalFee,
      amount_paid: 0,
      status: finalPricing.qualifiesForProBono ? 'Paid' : 'Draft', // Auto-mark pro bono as paid since balance is $0
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
      await client.entities.BillingSettings.update(settings.id, {
        last_invoice_number: nextNumber,
      });
    }

    // Mark time entries as invoiced if applicable
    if (formData.service_type === 'hourly_time' && timeEntries.length > 0) {
      await Promise.all(
        timeEntries.map(entry =>
          client.entities.TimeEntry.update(entry.id, { invoiced: true })
        )
      );
    }
  };

  const unbilledHours = timeEntries.reduce((sum, entry) => sum + (entry.rounded_minutes || 0), 0) / 60;
  const unbilledAmount = unbilledHours * (pricingInfo?.baseRate || 0);

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Create Invoice</h1>
          <p className="text-slate-600 mt-2">Generate an ethical, contract-based invoice for services rendered</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Client Selection */}
          <Card className="border-l-4 border-l-blue-600">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="w-5 h-5" />
                Client Information
              </CardTitle>
              <CardDescription>Select the organization or individual being invoiced</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Client / Organization *</Label>
                <Select
                  value={formData.organization_id}
                  onValueChange={(value) => setFormData({ ...formData, organization_id: value })}
                  required
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select client..." />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedOrg && pricingInfo && (
                <Alert className={pricingInfo.qualifiesForProBono ? "border-emerald-600 bg-emerald-50" : "border-emerald-200 bg-emerald-50"}>
                  <CheckCircle2 className={`h-4 w-4 ${pricingInfo.qualifiesForProBono ? 'text-emerald-700' : 'text-emerald-600'}`} />
                  <AlertDescription className="text-emerald-900">
                    <div className="space-y-2">
                      {pricingInfo.qualifiesForProBono && (
                        <div className="font-bold text-emerald-800 mb-2 pb-2 border-b border-emerald-300">
                          ✓ PRO BONO CLIENT - Invoice will be generated for tax write-off with 100% discount
                        </div>
                      )}
                      <p><strong>Client Category:</strong> {pricingInfo.category.replace(/_/g, ' ').toUpperCase()}</p>
                      <p><strong>Base Rate:</strong> ${pricingInfo.baseRate}/hour</p>
                      {pricingInfo.qualifiesForHardship && !pricingInfo.qualifiesForProBono && (
                        <Badge className="bg-amber-100 text-amber-900 border-amber-300">
                          Qualifies for Hardship Pricing
                        </Badge>
                      )}
                      {pricingInfo.qualifiesForMinistryDiscount && !pricingInfo.qualifiesForProBono && (
                        <Badge className="bg-purple-100 text-purple-900 border-purple-300">
                          Qualifies for Ministry Discount
                        </Badge>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {formData.organization_id && unbilledHours > 0 && (
                <Alert className="border-blue-200 bg-blue-50">
                  <AlertCircle className="h-4 w-4 text-blue-600" />
                  <AlertDescription className="text-blue-900">
                    <strong>Unbilled Time Available:</strong> {unbilledHours.toFixed(2)} hours (${unbilledAmount.toFixed(2)})
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* Service Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5" />
                Service Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Service Type *</Label>
                <Select
                  value={formData.service_type}
                  onValueChange={(value) => setFormData({ ...formData, service_type: value })}
                  required
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select service..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="quick_scan">Quick Eligibility Scan</SelectItem>
                    <SelectItem value="comprehensive_dossier">Comprehensive Funding Dossier</SelectItem>
                    <SelectItem value="micro_grant">Micro/Assistance Grant Application</SelectItem>
                    <SelectItem value="standard_foundation">Standard Foundation Application</SelectItem>
                    <SelectItem value="complex_federal">Complex/Federal Application</SelectItem>
                    <SelectItem value="scholarship_pack">Transfer Scholarship Pack</SelectItem>
                    <SelectItem value="hourly_time">Hourly Time (from time log)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Service Description</Label>
                <Textarea
                  value={formData.service_description}
                  onChange={(e) => setFormData({ ...formData, service_description: e.target.value })}
                  placeholder="Detailed description of services provided..."
                  rows={3}
                />
              </div>

              <div>
                <Label>Project (Optional)</Label>
                <Select
                  value={formData.project_id || '__none__'}
                  onValueChange={(value) => setFormData({ ...formData, project_id: value === '__none__' ? '' : value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Link to project..." />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Radix forbids value=""; sentinel maps back to '' (no project linked). */}
                    <SelectItem value="__none__">No Project</SelectItem>
                    {projects.filter(p => p.organization_id === formData.organization_id).map(project => (
                      <SelectItem key={project.id} value={project.id}>{project.project_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Milestone *</Label>
                <Select
                  value={formData.milestone_type}
                  onValueChange={(value) => setFormData({ ...formData, milestone_type: value })}
                  required
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kickoff">Kickoff - 40% (Scope Locked)</SelectItem>
                    <SelectItem value="draft_delivery">Draft Delivery - 40%</SelectItem>
                    <SelectItem value="final_submission">Final Submission - 20%</SelectItem>
                    <SelectItem value="full_payment">Full Payment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Pricing & Overrides */}
          {finalPricing && (
            <Card className={`border-l-4 ${finalPricing.qualifiesForProBono ? 'border-l-emerald-600' : 'border-l-emerald-600'}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="w-5 h-5" />
                  Pricing & Overrides
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className={`p-4 rounded-lg space-y-2 ${finalPricing.qualifiesForProBono ? 'bg-emerald-50 border-2 border-emerald-300' : 'bg-slate-50'}`}>
                  <div className="flex justify-between">
                    <span>Calculated Fee:</span>
                    <span className="font-bold">${(finalPricing.finalFee + finalPricing.discountAmount).toFixed(2)}</span>
                  </div>
                  {finalPricing.discountAmount > 0 && (
                    <div className={`flex justify-between ${finalPricing.qualifiesForProBono ? 'text-emerald-700 font-semibold' : 'text-emerald-600'}`}>
                      <span>{finalPricing.discountDescription}:</span>
                      <span className="font-bold">-${finalPricing.discountAmount.toFixed(2)}</span>
                    </div>
                  )}
                  <div className={`flex justify-between text-lg font-bold border-t pt-2 ${finalPricing.qualifiesForProBono ? 'border-emerald-400 text-emerald-800' : ''}`}>
                    <span>Total Due:</span>
                    <span>${finalPricing.finalFee.toFixed(2)}</span>
                  </div>
                  {finalPricing.qualifiesForProBono && (
                    <div className="text-xs text-emerald-700 mt-2 pt-2 border-t border-emerald-300">
                      <strong>Tax Write-Off Documentation:</strong> Full service value (${(finalPricing.discountAmount).toFixed(2)}) will be documented on invoice with 100% discount applied.
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                  <div>
                    <Label>Fee Override ($)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={formData.fee_override}
                      onChange={(e) => setFormData({ ...formData, fee_override: e.target.value })}
                      placeholder={`Default: ${finalPricing.finalFee.toFixed(2)}`}
                      disabled={finalPricing.qualifiesForProBono}
                    />
                    <p className="text-xs text-slate-500 mt-1">Leave blank to use calculated fee</p>
                  </div>

                  <div>
                    <Label>Discount Override ($)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={formData.discount_override}
                      onChange={(e) => setFormData({ ...formData, discount_override: e.target.value })}
                      placeholder={finalPricing.discountAmount > 0 ? `Default: ${finalPricing.discountAmount.toFixed(2)}` : 'No discount'}
                      disabled={finalPricing.qualifiesForProBono}
                    />
                    <p className="text-xs text-slate-500 mt-1">Manual discount amount</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Payment Terms */}
          <Card>
            <CardHeader>
              <CardTitle>Payment Terms</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Payment Terms *</Label>
                  <Select
                    value={formData.payment_terms}
                    onValueChange={(value) => setFormData({ ...formData, payment_terms: value })}
                    required
                    disabled={finalPricing?.qualifiesForProBono}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="due_on_receipt">Due on Receipt</SelectItem>
                      <SelectItem value="net_15">Net 15</SelectItem>
                      <SelectItem value="net_30">Net 30</SelectItem>
                      <SelectItem value="net_45">Net 45</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Issue Date *</Label>
                  <Input
                    type="date"
                    value={formData.issue_date}
                    onChange={(e) => setFormData({ ...formData, issue_date: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div>
                <Label>Payment Option *</Label>
                <Select
                  value={formData.payment_option}
                  onValueChange={(value) => setFormData({ ...formData, payment_option: value })}
                  required
                  disabled={finalPricing?.qualifiesForProBono}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="organization_pays">Organization Pays Directly</SelectItem>
                    <SelectItem value="bill_to_grant">Bill to Grant (if allowable)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Notes (Optional)</Label>
                <Textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Additional notes or special instructions..."
                  rows={3}
                />
              </div>
            </CardContent>
          </Card>

          {/* Ethical Standards Notice */}
          <Alert className="border-emerald-600 bg-emerald-50">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <AlertDescription className="text-emerald-900">
              <strong>Ethical Billing Standards:</strong> This invoice will include contract terms stating that compensation is for professional services rendered, not contingent on award outcomes. No percentage-based fees. All terms comply with grant writing ethics.
            </AlertDescription>
          </Alert>

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(createPageUrl('Billing'))}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createInvoiceMutation.isPending || !formData.organization_id || !formData.service_type}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {createInvoiceMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Invoice'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
