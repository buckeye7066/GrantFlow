
import React, { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import client from '@/api/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Send } from 'lucide-react';

export default function SendInvoiceModal({ invoice, organization, onClose }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const { data: contacts = [] } = useQuery({
    queryKey: ['contacts', organization.id],
    queryFn: () => client.entities.Contact.filter({ organization_id: organization.id }),
    enabled: !!organization.id,
  });

  // DIAGNOSIS: The email modal was not using the templating defaults from settings.
  // FIX: Fetch BillingSettings and populate the subject and body with templates.
  const { data: billingSettings } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: () => client.entities.BillingSettings.list().then(res => res[0]),
  });

  useEffect(() => {
    const primaryEmail = organization.email?.[0] || '';
    setTo(primaryEmail);

    let emailSubject = billingSettings?.default_email_subject || "Invoice {{invoiceNumber}} – {{clientName}}";
    emailSubject = emailSubject.replace('{{invoiceNumber}}', invoice.invoice_number);
    emailSubject = emailSubject.replace('{{clientName}}', organization.name);
    setSubject(emailSubject);
    
    let emailBody = billingSettings?.default_email_template || `Hi ${organization.name},\n\nPlease find attached invoice #${invoice.invoice_number} for your review.\n\nThank you!`;
    emailBody = emailBody.replace('{{clientName}}', organization.name);
    emailBody = emailBody.replace('{{invoiceNumber}}', invoice.invoice_number);
    emailBody = emailBody.replace('{{invoiceAmount}}', invoice.balance_due.toLocaleString());
    emailBody = emailBody.replace('{{dueDate}}', new Date(invoice.due_date).toLocaleDateString());
    setBody(emailBody);

  }, [invoice, organization, billingSettings]);

  const sendMutation = useMutation({
    mutationFn: () => client.functions.invoke('sendInvoice', {
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
              <Select value={to} onValueChange={setTo}>
                <SelectTrigger id="to">
                  <SelectValue placeholder="Select a recipient" />
                </SelectTrigger>
                <SelectContent>
                  {(Array.isArray(organization.email) ? organization.email : []).map((e, index) => <SelectItem key={`${e}-${index}`} value={e}>{e} (Org Primary)</SelectItem>)}
                  {contacts.map(c => <SelectItem key={c.id} value={c.email}>{c.full_name} ({c.email})</SelectItem>)}
                </SelectContent>
              </Select>
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
          <Button onClick={handleSend} disabled={sendMutation.isPending}>
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
