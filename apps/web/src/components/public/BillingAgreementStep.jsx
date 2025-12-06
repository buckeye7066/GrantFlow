import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft, Send, Shield, AlertTriangle } from 'lucide-react';

export default function BillingAgreementStep({ 
  totalMonthly, 
  selectedServices, 
  onBack, 
  onSubmit, 
  isSubmitting 
}) {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="space-y-6">
      {/* Cost Summary */}
      <Card className="border-2 border-green-600">
        <CardHeader className="bg-green-50">
          <CardTitle className="text-xl">Your Service Agreement Summary</CardTitle>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <div>
            <h3 className="font-semibold text-slate-900 mb-2">Selected Services:</h3>
            <ul className="list-disc list-inside space-y-1 text-sm text-slate-700">
              {selectedServices.map((service, idx) => (
                <li key={idx}>{service.name}</li>
              ))}
            </ul>
          </div>
          <div className="pt-4 border-t flex justify-between items-center">
            <span className="text-lg font-semibold text-slate-900">Estimated Monthly Cost:</span>
            <span className="text-3xl font-bold text-green-700">${totalMonthly.toLocaleString()}</span>
          </div>
        </CardContent>
      </Card>

      {/* Billing Terms */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="w-5 h-5" />
            Billing Agreement & Terms of Service
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-slate-700">
          <div>
            <h4 className="font-bold text-slate-900 mb-2">Billing Structure</h4>
            <ul className="space-y-2 list-disc list-inside">
              <li><strong>Monthly Billing:</strong> Services are billed on a monthly basis based on the application types you've selected</li>
              <li><strong>Weekly Invoices:</strong> You will receive detailed invoices every Sunday evening showing work completed, progress updates, and outstanding balances</li>
              <li><strong>Payment Methods:</strong> Payment accepted via check (made payable to John White), cash, or electronic payment</li>
              <li><strong>Work Authorization:</strong> Work begins only after initial consultation and agreement approval</li>
            </ul>
          </div>

          <div>
            <h4 className="font-bold text-slate-900 mb-2">Service Terms</h4>
            <ul className="space-y-2 list-disc list-inside">
              <li>Costs accumulate based on actual work performed and complexity encountered</li>
              <li>The estimates provided are based on typical applications; final costs may vary based on actual complexity</li>
              <li>You will be notified if additional work beyond the initial scope is required</li>
              <li>Progress reports are included with weekly invoices</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* Disclaimers */}
      <Card className="border-2 border-amber-300 bg-amber-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-900">
            <AlertTriangle className="w-5 h-5" />
            Required Disclaimers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-700">
          <div>
            <strong className="text-amber-900">1. No Funding Guarantee:</strong>
            <p>GrantFlow does not guarantee grant approval, award amounts, or funding of any kind. Grant awards are determined solely by the funding organizations.</p>
          </div>
          
          <div>
            <strong className="text-amber-900">2. Billing:</strong>
            <p>Monthly billing applies based on the application type. Work performed is invoiced weekly. By submitting this application you consent to recurring billing according to the fee structure presented.</p>
          </div>
          
          <div>
            <strong className="text-amber-900">3. Accuracy of Information:</strong>
            <p>Applicants are responsible for the accuracy of all information provided. GrantFlow is not liable for errors in applicant-submitted content.</p>
          </div>
          
          <div>
            <strong className="text-amber-900">4. Confidentiality:</strong>
            <p>All submitted information is securely stored and used only for application preparation and related services.</p>
          </div>
          
          <div>
            <strong className="text-amber-900">5. No Legal or Financial Advice:</strong>
            <p>GrantFlow is not a law firm or CPA service. All grant-related support is strictly administrative and advisory.</p>
          </div>
        </CardContent>
      </Card>

      {/* Agreement Checkbox */}
      <Card className="border-2 border-blue-600">
        <CardContent className="p-6">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={agreed}
              onCheckedChange={setAgreed}
              className="mt-1"
            />
            <div className="flex-1">
              <p className="font-semibold text-slate-900 mb-2">
                Required Agreement
              </p>
              <p className="text-sm text-slate-700 leading-relaxed">
                I have read and agree to the billing terms, service structure, and all disclaimers presented above. 
                I understand that:
              </p>
              <ul className="text-sm text-slate-700 mt-2 space-y-1 list-disc list-inside">
                <li>Services are billed monthly with weekly invoicing</li>
                <li>Funding is NOT guaranteed regardless of application quality</li>
                <li>I am responsible for the accuracy of information I provide</li>
                <li>This constitutes a professional services agreement</li>
                <li>Work begins only after consultation and mutual agreement</li>
              </ul>
            </div>
          </label>
        </CardContent>
      </Card>

      {/* Warning if not agreed */}
      {!agreed && (
        <Alert variant="destructive">
          <AlertDescription>
            You must read and agree to the billing terms and disclaimers before submitting your application.
          </AlertDescription>
        </Alert>
      )}

      {/* Action Buttons */}
      <div className="flex gap-4">
        <Button
          onClick={onBack}
          variant="outline"
          size="lg"
          className="flex-1"
        >
          <ArrowLeft className="w-5 h-5 mr-2" />
          Back to Form
        </Button>
        <Button
          onClick={onSubmit}
          disabled={!agreed || isSubmitting}
          size="lg"
          className="flex-1 bg-blue-600 hover:bg-blue-700"
        >
          {isSubmitting ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
              Submitting...
            </>
          ) : (
            <>
              <Send className="w-5 h-5 mr-2" />
              Submit Application
            </>
          )}
        </Button>
      </div>
    </div>
  );
}