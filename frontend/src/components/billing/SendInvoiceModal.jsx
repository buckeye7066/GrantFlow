import React, { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Send } from 'lucide-react';

const replaceTemplateTokens = (template, tokens) => {
  if (!template) return '';
  let result = template;
  Object.keys(tokens).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, tokens[key] || '');
  });
  return result;
};

export default function SendInvoiceModal({ invoice, organization, onClose }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const { data: contacts = [] } = useQuery({
    queryKey: ['contacts', organization.id],
    queryFn: () => base44.entities.Contact.filter({ organization_id: organization.id }),
    enabled: !!organization.id,
  });

  const { data: billingSettings } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: () => base44.entities.BillingSettings.list().then(res => res[0]),
  });

  const emailOptions = React.useMemo(() => {
    const options = [];
    if (organization.email && organization.email.length > 0) {
      organization.email.forEach(e => {
        options.push({ value: e, label: `${e} (Org Primary)` });
      });
    }
    contacts.forEach(c => {
      if (c.email) {
        options.push({ value: c.email, label: `${c.full_name} (${c.email})` });
      }
    });
    return options;
  }, [organization.email, contacts]);

  useEffect(() => {
    const tokens = {
      invoiceNumber: invoice.invoice_number || '',
      clientName: organization.name || '',
      invoiceAmount: invoice.balance_due ? invoice.balance_due.toLocaleString() : '0',
      dueDate: invoice.due_date ? new Date(invoice.due_date).toLocaleDateString() : '',
    };

    const defaultSubject = billingSettings?.default_email_subject || "Invoice {{invoiceNumber}} – {{clientName}}";
    const defaultBody = billingSettings?.default_email_template || `Hi {{clientName}},\n\nPlease find attached invoice #{{invoiceNumber}} for your review.\n\nThank you!`;

    setTo(emailOptions.length > 0 ? emailOptions[0].value : '');
    setSubject(replaceTemplateTokens(defaultSubject, tokens));
    setBody(replaceTemplateTokens(defaultBody, tokens));
  }, [invoice, organization, billingSettings, emailOptions]);

  const sendMutation = useMutation({
    mutationFn: () => base44.functions.invoke('sendInvoice', {
      invoiceId: invoice.id,
      to,
      subject,
      body,
    }),
    onSuccess: () => {
      onClose();
    },
  });

  const handleSend = () => {
    sendMutation.mutate();
  };

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Send Invoice {invoice.invoice_number}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="to" className="text-right">
              To
            </Label>
            <div className="col-span-3">
              {emailOptions.length === 0 ? (
                <p className="text-sm text-slate-500 italic">No email addresses available for this organization.</p>
              ) : (
                <Select value={to} onValueChange={setTo}>
                  <SelectTrigger id="to">
                    <SelectValue placeholder="Select a recipient" />
                  </SelectTrigger>
                  <SelectContent>
                    {emailOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="subject" className="text-right">
              Subject
            </Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="col-span-3"
            />
          </div>
          <div className="grid grid-cols-4 items-start gap-4">
            <Label htmlFor="body" className="text-right pt-2">
              Body
            </Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="col-span-3 h-48"
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={handleSend} disabled={sendMutation.isPending || !to}>
            {sendMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}