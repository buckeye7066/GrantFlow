import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

/**
 * Ethical billing standards banner
 */
export default function EthicalBillingBanner() {
  return (
    <Card className="border-l-4 border-l-emerald-600 bg-emerald-50 border-emerald-200">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-emerald-700 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-semibold text-emerald-900 mb-1">Ethical Billing Standards</h3>
            <p className="text-sm text-emerald-800">
              This system enforces ethical grant writing practices: <strong>No percentage-of-award fees</strong>. 
              Only fixed-fee, hourly, or milestone billing. All costs must comply with funder rules.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}