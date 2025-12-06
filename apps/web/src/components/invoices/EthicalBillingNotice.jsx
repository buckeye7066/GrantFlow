import React from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2 } from 'lucide-react';

export default function EthicalBillingNotice() {
  return (
    <Alert className="border-emerald-600 bg-emerald-50">
      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      <AlertDescription className="text-emerald-900">
        <strong>Ethical Billing Standards:</strong> This invoice will include contract terms stating that compensation is for professional services rendered, not contingent on award outcomes. No percentage-based fees. All terms comply with grant writing ethics.
      </AlertDescription>
    </Alert>
  );
}