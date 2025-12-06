import React from 'react';
import { Card } from '@/components/ui/card';

/**
 * Wrapper for conditional fields that show/hide based on parent checkbox
 * Provides consistent styling and animation
 */
export default function ConditionalField({ 
  condition, 
  children,
  borderColor = 'border-slate-200' 
}) {
  if (!condition) return null;

  return (
    <div className={`space-y-2 p-3 bg-white rounded border ${borderColor} mt-3 animate-in fade-in-50 slide-in-from-top-2 duration-200`}>
      {children}
    </div>
  );
}