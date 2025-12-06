import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function InvoicePaymentTermsCard({ formData, updateField, isProBono }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment Terms</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="payment_terms">Payment Terms *</Label>
            <Select
              value={formData.payment_terms}
              onValueChange={(value) => updateField('payment_terms', value)}
              required
              disabled={isProBono}
            >
              <SelectTrigger id="payment_terms">
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
            <Label htmlFor="issue_date">Issue Date *</Label>
            <Input
              id="issue_date"
              type="date"
              value={formData.issue_date}
              onChange={(e) => updateField('issue_date', e.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <Label htmlFor="payment_option">Payment Option *</Label>
          <Select
            value={formData.payment_option}
            onValueChange={(value) => updateField('payment_option', value)}
            required
            disabled={isProBono}
          >
            <SelectTrigger id="payment_option">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="organization_pays">Organization Pays Directly</SelectItem>
              <SelectItem value="bill_to_grant">Bill to Grant (if allowable)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="notes">Notes (Optional)</Label>
          <Textarea
            id="notes"
            value={formData.notes}
            onChange={(e) => updateField('notes', e.target.value)}
            placeholder="Additional notes or special instructions..."
            rows={3}
          />
        </div>
      </CardContent>
    </Card>
  );
}