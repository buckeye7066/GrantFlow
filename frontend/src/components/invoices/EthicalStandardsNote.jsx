import React from 'react';
import { Shield } from 'lucide-react';

/**
 * Ethical billing standards notice
 */
export default function EthicalStandardsNote() {
  return (
    <div className="mb-6 p-4 bg-emerald-50 border-l-4 border-l-emerald-600 rounded-r-lg">
      <div className="flex items-start gap-3">
        <Shield className="w-5 h-5 text-emerald-700 mt-0.5 flex-shrink-0" />
        <div>
          <h4 className="font-semibold text-emerald-900 mb-1">Ethical Billing Standards</h4>
          <p className="text-sm text-emerald-800">
            This invoice complies with Grant Professionals Association ethical standards. 
            No percentage-of-award or success fees are charged. All fees are based on time, 
            complexity, and value delivered—never contingent on grant outcomes.
          </p>
        </div>
      </div>
    </div>
  );
}