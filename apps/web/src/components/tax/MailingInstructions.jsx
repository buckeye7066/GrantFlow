import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  Mail, 
  CheckSquare, 
  AlertTriangle, 
  Calendar,
  MapPin,
  Printer,
  CheckCircle2,
  DollarSign
} from 'lucide-react';

/**
 * Mailing Instructions Component
 * Displays step-by-step instructions for mailing tax returns
 */
export default function MailingInstructions({ mailingInfo, taxYear, refundAmount, paymentAmount }) {
  if (!mailingInfo) return null;

  const { federal_filing, state_filing, important_notes } = mailingInfo;
  const hasPayment = paymentAmount > 0;

  return (
    <div className="space-y-6">
      {/* Critical Timeline Alert */}
      <Alert className="bg-red-50 border-red-400 border-2">
        <Calendar className="h-5 w-5 text-red-600" />
        <AlertDescription className="text-red-900">
          <strong className="text-xl block mb-2">📅 FILING DEADLINE: {federal_filing.deadline}</strong>
          <p className="text-base">
            Your return must be <strong>postmarked by {federal_filing.deadline}</strong>.
            {hasPayment && ' Use certified mail with return receipt for proof of filing.'}
          </p>
          <p className="text-sm mt-2">
            Extension available until {federal_filing.extension_deadline} if you file Form 4868 by April 15.
          </p>
        </AlertDescription>
      </Alert>

      {/* Payment Warning */}
      {hasPayment && (
        <Alert className="bg-amber-50 border-amber-400 border-2">
          <DollarSign className="h-5 w-5 text-amber-600" />
          <AlertDescription className="text-amber-900">
            <strong className="text-lg block mb-2">💰 PAYMENT REQUIRED: ${paymentAmount.toLocaleString()}</strong>
            <ul className="list-disc list-inside space-y-1 text-sm mt-2">
              <li>Make check or money order payable to: <strong>"United States Treasury"</strong></li>
              <li>Write your SSN and "{taxYear} Form 1040" in memo line</li>
              <li>DO NOT STAPLE check to return - use paperclip</li>
              <li><strong>Use CERTIFIED MAIL</strong> for proof of payment and filing</li>
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Federal Filing Instructions */}
      <Card className="border-2 border-blue-500">
        <CardHeader className="bg-gradient-to-r from-blue-50 to-blue-100">
          <CardTitle className="flex items-center gap-2">
            <Mail className="w-6 h-6 text-blue-600" />
            Federal Tax Return Mailing Instructions
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6 space-y-6">
          {/* Mailing Address */}
          <div className="p-4 bg-blue-50 rounded-lg border-2 border-blue-300">
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-blue-600 mt-1" />
              <div>
                <p className="font-semibold text-slate-900 mb-2">Mail Your Return To:</p>
                <p className="font-mono text-sm bg-white p-3 rounded border border-blue-200">
                  {federal_filing.mail_to}
                </p>
              </div>
            </div>
          </div>

          {/* Step-by-Step Checklist */}
          <div>
            <h4 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
              <CheckSquare className="w-5 h-5 text-blue-600" />
              Step-by-Step Filing Checklist
            </h4>
            <div className="space-y-3">
              {federal_filing.checklist.map((item, idx) => (
                <div key={idx} className="flex items-start gap-3 p-3 bg-white rounded-lg border border-slate-200">
                  <div className="w-6 h-6 rounded-full border-2 border-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-blue-600">{idx + 1}</span>
                  </div>
                  <p className="text-sm text-slate-700 flex-1">{item}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Certified Mail Recommendation */}
          {hasPayment && (
            <Alert className="bg-green-50 border-green-400">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-900">
                <strong>✅ HIGHLY RECOMMENDED: Use Certified Mail</strong>
                <p className="text-sm mt-1">
                  When sending payment, always use USPS Certified Mail with Return Receipt. This provides:
                </p>
                <ul className="list-disc list-inside text-sm mt-2 space-y-1">
                  <li>Proof of mailing date (postmark)</li>
                  <li>Tracking number</li>
                  <li>Signature confirmation of delivery</li>
                  <li>Protection if IRS claims non-receipt</li>
                </ul>
                <p className="text-sm mt-2 font-semibold">
                  Cost: ~$4-8 at post office. Worth it for peace of mind!
                </p>
              </AlertDescription>
            </Alert>
          )}

          {/* Print Button */}
          <Button
            onClick={() => window.print()}
            className="w-full"
            size="lg"
          >
            <Printer className="w-5 h-5 mr-2" />
            Print Mailing Instructions
          </Button>
        </CardContent>
      </Card>

      {/* State Filing (if applicable) */}
      {state_filing && (
        <Card className="border-2 border-purple-500">
          <CardHeader className="bg-gradient-to-r from-purple-50 to-purple-100">
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-6 h-6 text-purple-600" />
              State Tax Return Mailing Instructions
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-4">
            <div className="p-4 bg-purple-50 rounded-lg border-2 border-purple-300">
              <div className="flex items-start gap-3">
                <MapPin className="w-5 h-5 text-purple-600 mt-1" />
                <div>
                  <p className="font-semibold text-slate-900 mb-2">Mail State Return To:</p>
                  <p className="font-mono text-sm bg-white p-3 rounded border border-purple-200">
                    {state_filing.mail_to}
                  </p>
                </div>
              </div>
            </div>

            <div>
              <p className="font-semibold text-slate-900 mb-2">Required Form: {state_filing.form_required}</p>
              <p className="text-sm text-slate-600">Deadline: {state_filing.deadline}</p>
            </div>

            <div>
              <h4 className="font-bold text-slate-900 mb-3">State Filing Checklist:</h4>
              <div className="space-y-2">
                {state_filing.checklist.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <div className="w-5 h-5 border-2 border-purple-600 rounded flex items-center justify-center">
                      <span className="text-xs">☐</span>
                    </div>
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Important Notes */}
      <Card className="bg-gradient-to-br from-slate-50 to-blue-50 border-slate-300">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-slate-700" />
            Important Mailing Tips
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {important_notes.map((note, idx) => (
              <li key={idx} className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                <span className="text-slate-700">{note}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Mailing Label Generator */}
      <Card>
        <CardHeader>
          <CardTitle>📬 Printable Mailing Label</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border-4 border-black p-6 bg-white max-w-md" style={{ fontFamily: 'Courier New, monospace' }}>
            <div className="mb-6">
              <p className="font-bold">FROM:</p>
              <p>{org.name}</p>
              <p>{org.address}</p>
              <p>{org.city}, {org.state} {org.zip}</p>
            </div>
            <div>
              <p className="font-bold">TO:</p>
              <p className="text-sm leading-relaxed" style={{ whiteSpace: 'pre-line' }}>
                {federal_filing.mail_to}
              </p>
            </div>
            <div className="mt-4 pt-4 border-t-2 border-dashed border-slate-400">
              <p className="text-xs text-slate-600">Tax Return for {taxYear}</p>
              {hasPayment && (
                <p className="text-xs font-bold text-red-600">CERTIFIED MAIL - RETURN RECEIPT REQUESTED</p>
              )}
            </div>
          </div>
          <p className="text-sm text-slate-500 mt-4">
            💡 Tip: Print this label and tape it to your envelope, or copy the address carefully
          </p>
        </CardContent>
      </Card>
    </div>
  );
}