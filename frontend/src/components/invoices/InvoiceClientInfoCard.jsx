import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Building2, CheckCircle2, AlertCircle } from 'lucide-react';

export default function InvoiceClientInfoCard({ 
  organizations, 
  selectedOrgId, 
  onOrgChange, 
  selectedOrg,
  pricingInfo,
  unbilledHours,
  unbilledAmount 
}) {
  return (
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
          <Label htmlFor="organization">Client / Organization *</Label>
          <Select
            value={selectedOrgId}
            onValueChange={onOrgChange}
            required
          >
            <SelectTrigger id="organization">
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

        {selectedOrgId && unbilledHours > 0 && (
          <Alert className="border-blue-200 bg-blue-50">
            <AlertCircle className="h-4 w-4 text-blue-600" />
            <AlertDescription className="text-blue-900">
              <strong>Unbilled Time Available:</strong> {unbilledHours.toFixed(2)} hours (${unbilledAmount.toFixed(2)})
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}