import React from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * Client classification box showing category and special pricing
 */
export default function ClientClassification({ invoice }) {
  if (!invoice.client_category) return null;

  const categoryLabels = {
    individual_household: 'Individual/Household',
    small_ministry_nonprofit: 'Small Ministry/Nonprofit',
    midsize_org: 'Mid-Size Organization',
    large_org: 'Large Organization',
  };

  const getClassificationColor = (category) => {
    switch (category) {
      case 'individual_household':
        return 'bg-purple-50 border-purple-200 text-purple-800';
      case 'small_ministry_nonprofit':
        return 'bg-blue-50 border-blue-200 text-blue-800';
      case 'midsize_org':
        return 'bg-emerald-50 border-emerald-200 text-emerald-800';
      case 'large_org':
        return 'bg-slate-50 border-slate-200 text-slate-800';
      default:
        return 'bg-slate-50 border-slate-200 text-slate-800';
    }
  };

  return (
    <div className={`mb-6 p-4 border-2 rounded-lg ${getClassificationColor(invoice.client_category)}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider mb-1">Client Category</p>
          <p className="font-bold text-lg">
            {categoryLabels[invoice.client_category] || invoice.client_category}
          </p>
        </div>
        <div className="text-right">
          {invoice.qualifies_for_hardship && (
            <Badge className="bg-amber-100 text-amber-800 mb-1">Hardship Pricing</Badge>
          )}
          {invoice.qualifies_for_ministry_discount && (
            <Badge className="bg-green-100 text-green-800">Ministry Discount</Badge>
          )}
        </div>
      </div>
    </div>
  );
}