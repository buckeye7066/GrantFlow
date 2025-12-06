import React, { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Receipt, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useToast } from '@/components/ui/use-toast';

const statusColors = {
  draft: 'bg-slate-100 text-slate-700',
  sent: 'bg-blue-100 text-blue-700',
  paid: 'bg-emerald-100 text-emerald-700',
  overdue: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500'
};

const capitalizeStatus = (status) => {
  if (!status) return '';
  return status.charAt(0).toUpperCase() + status.slice(1);
};

export default function InvoicesTab({ invoices, organizations }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const organizationMap = useMemo(() => {
    const map = new Map();
    organizations.forEach(org => {
      map.set(org.id, org);
    });
    return map;
  }, [organizations]);

  const deleteMutation = useMutation({
    mutationFn: (invoiceId) => base44.entities.Invoice.delete(invoiceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast({
        title: 'Invoice Deleted',
        description: 'The invoice has been successfully deleted.',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Delete Failed',
        description: error.message || 'Failed to delete the invoice.',
      });
    }
  });

  const handleDelete = (invoice) => {
    // TODO: Replace with styled confirmation modal
    if (window.confirm(`Are you sure you want to delete invoice ${invoice.invoice_number}? This action cannot be undone.`)) {
      deleteMutation.mutate(invoice.id);
    }
  };

  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>All Invoices</CardTitle>
      </CardHeader>
      <CardContent>
        {invoices.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <Receipt className="w-16 h-16 mx-auto mb-4 text-slate-300" />
            <p className="font-semibold">No Invoices Found</p>
            <p className="text-sm mb-4">Invoices will appear here once they are generated.</p>
            <Link to={createPageUrl("CreateInvoice")}>
              <Button>Create Your First Invoice</Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {invoices.map(invoice => {
              const org = organizationMap.get(invoice.organization_id);
              return (
                <div 
                  key={invoice.id} 
                  className="p-4 border rounded-lg hover:bg-slate-50 transition-colors"
                  data-testid={`invoice-${invoice.id}`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="font-bold text-lg text-slate-900">{invoice.invoice_number}</h4>
                      <p className="text-sm text-slate-600">{org?.name || 'Unknown Client'}</p>
                    </div>
                    <Badge className={statusColors[invoice.status]}>{capitalizeStatus(invoice.status)}</Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm">
                    <div className="space-x-4">
                      <span className="text-slate-500">
                        Due: <span className="font-medium text-slate-700">
                          {invoice.due_date ? (() => {
                            try {
                              const date = new Date(invoice.due_date);
                              return isNaN(date.getTime()) ? 'N/A' : date.toLocaleDateString();
                            } catch {
                              return 'N/A';
                            }
                          })() : 'N/A'}
                        </span>
                      </span>
                      <span className="text-slate-500">
                        Total: <span className="font-medium text-slate-700">${invoice.total?.toLocaleString()}</span>
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Link to={createPageUrl("InvoiceView") + `?id=${invoice.id}`}>
                        <Button variant="outline" size="sm">View Invoice</Button>
                      </Link>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleDelete(invoice)}
                        disabled={deleteMutation.isPending}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                        data-testid={`delete-invoice-${invoice.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}