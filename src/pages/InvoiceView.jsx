
import React, { useRef, useState } from "react";
import client from '@/api/client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createPageUrl, formatAddress } from "@/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, Printer, Mail, Trash2 } from "lucide-react";
import { format } from "date-fns";
import SendInvoiceModal from "../components/billing/SendInvoiceModal";
import { useToast } from "@/components/ui/use-toast";

export default function InvoiceView() {
  const navigate = useNavigate();
  const printRef = useRef();
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const urlParams = new URLSearchParams(window.location.search);
  const invoiceId = urlParams.get('id');

  const { data: invoice } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: async () => {
      if (!invoiceId) return null;
      return await client.entities.Invoice.get(invoiceId);
    },
    enabled: !!invoiceId
  });

  const { data: organization } = useQuery({
    queryKey: ['organization', invoice?.organization_id],
    queryFn: async () => {
      if (!invoice?.organization_id) return null;
      return await client.entities.Organization.get(invoice.organization_id);
    },
    enabled: !!invoice?.organization_id
  });

  const { data: project } = useQuery({
    queryKey: ['project', invoice?.project_id],
    queryFn: async () => {
      if (!invoice?.project_id) return null;
      return await client.entities.Project.get(invoice.project_id);
    },
    enabled: !!invoice?.project_id
  });

  const { data: lineItems = [] } = useQuery({
    queryKey: ['invoice-lines', invoiceId],
    queryFn: async () => {
      if (!invoiceId) return [];
      const allLines = await client.entities.InvoiceLine.list({ invoice_id: invoiceId });
      return allLines.sort((a, b) => (a.line_order || 0) - (b.line_order || 0));
    },
    enabled: !!invoiceId
  });

  const deleteMutation = useMutation({
    mutationFn: (invoiceIdToDelete) => client.entities.Invoice.delete(invoiceIdToDelete),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast({
        title: 'Invoice Deleted',
        description: 'The invoice has been successfully deleted.',
      });
      navigate(createPageUrl('Billing'));
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Delete Failed',
        description: error.message || 'Failed to delete the invoice.',
      });
    }
  });

  const handleDelete = () => {
    if (invoice && window.confirm(`Are you sure you want to delete invoice ${invoice.invoice_number}? This action cannot be undone.`)) {
      deleteMutation.mutate(invoice.id);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadPdf = () => {
    toast({
      title: "Save as PDF",
      description:
        'In the print dialog, choose "Save as PDF" or "Microsoft Print to PDF" as the destination.',
    });
    window.print();
  };

  if (!invoice) {
    return (
      <div className="p-6">
        <div className="max-w-4xl mx-auto">
          <Button variant="ghost" onClick={() => navigate(createPageUrl("Billing"))}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Billing
          </Button>
          <p className="text-center text-slate-600 mt-8">Invoice not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #printable-invoice,
          #printable-invoice * {
            visibility: visible;
          }
          #printable-invoice {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
          .print\\:hidden {
            display: none !important;
          }
          @page {
            margin: 0.5in;
            size: letter portrait;
          }
        }
      `}</style>

      <div className="print:hidden bg-white border-b border-slate-200 p-4">
        <div className="max-w-4xl mx-auto flex justify-between items-center">
          <Button variant="ghost" onClick={() => navigate(createPageUrl("Billing"))}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Billing
          </Button>
          <div className="flex gap-2">
            <Button 
              variant="outline" 
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </Button>
            <Button variant="outline" onClick={() => setIsSendModalOpen(true)} className="bg-blue-50 text-blue-700 border-blue-200">
              <Mail className="w-4 h-4 mr-2" />
              Send via Email
            </Button>
            <Button variant="outline" onClick={handlePrint}>
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>
            <Button variant="outline" onClick={handleDownloadPdf}>
              <Download className="w-4 h-4 mr-2" />
              Download PDF
            </Button>
          </div>
        </div>
      </div>

      <div className="p-6">
        <Card className="max-w-4xl mx-auto shadow-2xl print:shadow-none" id="printable-invoice" ref={printRef}>
          <CardContent className="p-12">
            {/* Header */}
            <div className="flex justify-between items-start mb-8 pb-4 border-b-2 border-slate-900">
              <div>
                <h1 className="text-4xl font-bold text-slate-900 mb-2">INVOICE</h1>
                <p className="text-slate-600">Invoice #: {invoice.invoice_number}</p>
                <p className="text-slate-600">Date: {invoice.issue_date && !isNaN(new Date(invoice.issue_date).getTime()) ? format(new Date(invoice.issue_date), 'MMM dd, yyyy') : 'N/A'}</p>
                {invoice.due_date && !isNaN(new Date(invoice.due_date)) && (
                  <p className="text-slate-600">Due: {format(new Date(invoice.due_date), 'MMM dd, yyyy')}</p>
                )}
              </div>
              <div className="text-right">
                <h2 className="text-2xl font-bold text-blue-600 mb-2">GrantFlow</h2>
                <p className="text-sm text-gray-600">Professional Grant Writing Services</p>
                <p className="text-xs text-slate-500 mt-2">GrantFlow Consulting</p>
                <p className="text-xs text-slate-500">Address on invoice record</p>
                <p className="text-xs text-slate-500">billing@example.invalid</p>
                <p className="text-xs text-slate-500">+1 555 010 1000</p>
              </div>
            </div>

            {/* Bill To */}
            <div className="mb-8">
              <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Bill To:</h3>
              <div className="text-slate-900">
                <p className="text-xl font-bold mb-1">{organization?.name}</p>
                {organization?.address && (
                  <p>{formatAddress(organization.address)}</p>
                )}
                {organization?.city && organization?.state && organization?.zip && (
                  <p>{organization.city}, {organization.state} {organization.zip}</p>
                )}
                {organization?.email && organization.email[0] && <p className="mt-2">{organization.email[0]}</p>}
                {organization?.phone && organization.phone[0] && <p>{organization.phone[0]}</p>}
              </div>
            </div>

            {/* Client Category & Qualifications */}
            {(invoice.client_category || invoice.qualifies_for_hardship || invoice.qualifies_for_ministry_discount) && (
              <div className="mb-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h3 className="text-sm font-semibold text-blue-900 mb-2">Client Classification</h3>
                {invoice.client_category && (
                  <p className="text-sm text-blue-800">
                    <strong>Category:</strong> {invoice.client_category.replace(/_/g, ' ').toUpperCase()}
                  </p>
                )}
                {invoice.qualifies_for_hardship && (
                  <p className="text-sm text-amber-700">✓ Qualifies for Hardship Pricing</p>
                )}
                {invoice.qualifies_for_ministry_discount && (
                  <p className="text-sm text-purple-700">✓ Qualifies for Ministry Discount</p>
                )}
              </div>
            )}

            {/* Project Info */}
            {project && (
              <div className="mb-8 p-4 bg-slate-50 rounded-lg">
                <h3 className="text-sm font-semibold text-slate-700 mb-1">Project:</h3>
                <p className="text-slate-900 font-medium">{project.project_name}</p>
                {invoice.milestone_type && (
                  <p className="text-sm text-slate-600 mt-1">
                    Milestone: {invoice.milestone_type.replace(/_/g, ' ').charAt(0).toUpperCase() + invoice.milestone_type.replace(/_/g, ' ').slice(1)}
                  </p>
                )}
              </div>
            )}

            {/* Line Items Table */}
            <div className="mb-8">
              <table className="w-full">
                <thead>
                  <tr className="border-b-2 border-slate-300">
                    <th className="text-left py-3 px-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Description</th>
                    <th className="text-center py-3 px-2 text-sm font-semibold text-slate-700 uppercase tracking-wider w-24">Qty</th>
                    <th className="text-right py-3 px-2 text-sm font-semibold text-slate-700 uppercase tracking-wider w-32">Rate</th>
                    <th className="text-right py-3 px-2 text-sm font-semibold text-slate-700 uppercase tracking-wider w-32">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item, index) => (
                    <tr key={index} className="border-b border-slate-200">
                      <td className="py-4 px-2 text-slate-900">
                        {item.description}
                        {item.is_grant_chargeable && (
                          <span className="ml-2 inline-block px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded">
                            Grant Billable
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-2 text-center text-slate-600">
                        {item.quantity || 1}
                      </td>
                      <td className="py-4 px-2 text-right text-slate-600">
                        ${(item.unit_price || 0).toFixed(2)}
                      </td>
                      <td className="py-4 px-2 text-right text-slate-900 font-medium">
                        ${(item.amount || 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="flex justify-end mb-10">
              <div className="w-80">
                <div className="flex justify-between py-2 text-slate-600">
                  <span>Subtotal:</span>
                  <span>${(invoice.subtotal || 0).toFixed(2)}</span>
                </div>
                {invoice.discount_amount > 0 && (
                  <div className="flex justify-between py-2 text-emerald-600">
                    <span>{invoice.discount_description || 'Discount'}:</span>
                    <span>-${invoice.discount_amount.toFixed(2)}</span>
                  </div>
                )}
                {invoice.tax_amount > 0 && (
                  <div className="flex justify-between py-2 text-slate-600">
                    <span>Tax:</span>
                    <span>${(invoice.tax_amount || 0).toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between py-3 border-t-2 border-slate-300 text-xl font-bold text-slate-900">
                  <span>Total:</span>
                  <span>${(invoice.total || 0).toFixed(2)}</span>
                </div>
                {invoice.amount_paid > 0 && (
                  <div className="flex justify-between py-2 text-slate-600">
                    <span>Amount Paid:</span>
                    <span>-${(invoice.amount_paid || 0).toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between py-3 border-t-2 border-slate-300 text-xl font-bold text-blue-600">
                  <span>Balance Due:</span>
                  <span>${(invoice.balance_due || invoice.total || 0).toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Contract Terms */}
            {invoice.contract_terms && (
              <div className="mb-8 p-6 bg-slate-50 border-l-4 border-l-blue-600 rounded">
                <h3 className="font-bold text-slate-900 mb-4 text-lg">SERVICE AGREEMENT & CONTRACT TERMS</h3>
                <div className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">
                  {invoice.contract_terms}
                </div>
              </div>
            )}

            {/* Payment Terms & Notes */}
            <div className="space-y-6 text-sm mb-8">
              {invoice.payment_terms && (
                <div>
                  <h3 className="font-semibold text-slate-700 mb-2">Payment Terms:</h3>
                  <p className="text-slate-600">
                    {invoice.payment_terms === 'net_15' && 'Payment due within 15 days'}
                    {invoice.payment_terms === 'net_30' && 'Payment due within 30 days'}
                    {invoice.payment_terms === 'net_45' && 'Payment due within 45 days'}
                    {invoice.payment_terms === 'due_on_receipt' && 'Payment due upon receipt'}
                  </p>
                </div>
              )}

              {invoice.notes && (
                <div>
                  <h3 className="font-semibold text-slate-700 mb-2">Additional Notes:</h3>
                  <p className="text-slate-600 whitespace-pre-wrap">{invoice.notes}</p>
                </div>
              )}

              {invoice.payment_option === 'bill_to_grant' && (
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <p className="text-emerald-800 text-sm">
                    ✓ This invoice reflects costs that are allowable and billable to the grant award as verified in the grant opportunity documentation.
                  </p>
                </div>
              )}
            </div>

            {/* Ethical Standards Badge */}
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg mb-8">
              <p className="text-blue-900 text-sm">
                <strong>✓ Ethical Billing Standards:</strong> This invoice complies with grant writing ethical standards. 
                Compensation is for professional services rendered and is not contingent on award outcomes. 
                No percentage-based or commission fees are charged.
              </p>
            </div>

            {/* Payment Instructions */}
            <div className="mb-8 p-4 bg-slate-100 rounded-lg">
              <h3 className="font-semibold text-slate-900 mb-2">Payment Instructions:</h3>
              <p className="text-slate-700 text-sm mb-2">Please make checks payable to: <strong>John White</strong></p>
              <p className="text-slate-700 text-sm">Mail payment to address above or contact for electronic payment options.</p>
            </div>

            {/* Footer */}
            <div className="mt-12 pt-6 border-t-2 border-slate-900 text-center">
              <p className="text-slate-600 mb-2 font-semibold">Thank you for your business!</p>
              <p className="text-xs text-slate-500">
                By accepting this invoice, Client agrees to the service agreement and contract terms stated above.
              </p>
              <p className="text-xs text-slate-500 mt-2">
                This invoice was prepared using GrantFlow • Created by John White
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {isSendModalOpen && invoice && organization && (
        <SendInvoiceModal
          invoice={invoice}
          organization={organization}
          onClose={() => setIsSendModalOpen(false)}
        />
      )}
    </div>
  );
}
