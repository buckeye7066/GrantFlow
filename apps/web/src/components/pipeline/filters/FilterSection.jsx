import React, { useId } from 'react';
import { Label } from '@/components/ui/label';

/**
 * FilterSection - Reusable container for filter groups
 * @param {Object} props
 * @param {string|React.ReactNode} props.label - Section label
 * @param {React.ReactNode} props.children - Filter content
 * @param {string} [props.className] - Additional CSS classes
 */
export default function FilterSection({ label, children, className = '' }) {
  const autoId = useId();
  const hasLabel = typeof label === 'string' ? label.trim().length > 0 : !!label;
  const labelId = hasLabel ? `filter-section-label-${autoId}` : undefined;

  return (
    <div
      className={`space-y-2 ${className || ''}`}
      role="group"
      aria-labelledby={labelId}
      aria-label={!hasLabel ? 'Filter section' : undefined}
    >
      {hasLabel && (
        <Label id={labelId} className="text-sm font-semibold">
          {label}
        </Label>
      )}
      {children}
    </div>
  );
}