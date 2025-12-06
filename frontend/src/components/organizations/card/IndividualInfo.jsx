import React from 'react';
import { Badge } from '@/components/ui/badge';
import TagList from './TagList';

/**
 * Individual assistance profile information
 * Shows assistance categories and financial need level
 */
export default function IndividualInfo({ 
  organization, 
  assistanceCategoryLabels 
}) {
  return (
    <div className="space-y-2">
      {assistanceCategoryLabels.length > 0 && (
        <TagList 
          items={assistanceCategoryLabels} 
          limit={2} 
          variant="outline"
          className="bg-rose-50 text-rose-700"
        />
      )}
      
      {organization.financial_need_level && (
        <p className="text-xs text-slate-600">
          <strong>Need Level:</strong> {organization.financial_need_level}
        </p>
      )}
    </div>
  );
}