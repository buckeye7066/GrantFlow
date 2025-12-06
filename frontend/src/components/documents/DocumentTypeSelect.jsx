import React, { useMemo, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  FileText, File, DollarSign, Mail, FileCheck, User, Building2, Receipt,
  BarChart3, Calendar, FolderOpen
} from 'lucide-react';

export const DOCUMENT_TYPES = [
  { value: 'nofo', label: 'NOFO/RFP', icon: FileText },
  { value: 'proposal', label: 'Proposal', icon: File },
  { value: 'budget', label: 'Budget', icon: DollarSign },
  { value: 'letter_of_support', label: 'Letter of Support', icon: Mail },
  { value: 'mou', label: 'MOU/Agreement', icon: FileCheck },
  { value: 'resume', label: 'Resume/CV', icon: User },
  { value: 'irs_determination', label: 'IRS Determination Letter', icon: Building2 },
  { value: 'financial_statement', label: 'Financial Statement', icon: Receipt },
  { value: 'audit', label: 'Audit Report', icon: BarChart3 },
  { value: 'logic_model', label: 'Logic Model', icon: BarChart3 },
  { value: 'timeline', label: 'Timeline/Gantt Chart', icon: Calendar },
  { value: 'other', label: 'Other', icon: FolderOpen },
];

/**
 * DocumentTypeSelect - Dropdown for selecting document type
 * @param {Object} props
 * @param {string} props.value - Selected document type
 * @param {Function} props.onChange - Change handler
 * @param {boolean} props.disabled - Whether select is disabled
 * @param {string} props.error - Error message
 */
export default function DocumentTypeSelect({ value, onChange, disabled = false, error }) {
  // Build map for quick lookup
  const map = useMemo(() => {
    const m = new Map();
    DOCUMENT_TYPES.forEach(t => m.set(t.value, t));
    return m;
  }, []);

  // Coerce value to known option or undefined
  const normalizedValue = typeof value === 'string' && map.has(value) ? value : undefined;
  const selectedType = normalizedValue ? map.get(normalizedValue) : undefined;

  // Guard onChange to emit only strings and avoid redundant calls
  const handleValueChange = useCallback(
    (val) => {
      if (typeof onChange !== 'function') return;
      if (typeof val !== 'string') return;
      // Emit only if actually changed
      if (val !== normalizedValue) {
        onChange(val);
      }
    },
    [onChange, normalizedValue]
  );

  // Safe icon render helper
  const renderSelectedIcon = () => {
    if (!selectedType) return null;
    const Icon = selectedType.icon;
    if (!Icon || typeof Icon !== 'function') return null;
    return <Icon className="w-4 h-4 text-slate-500" aria-hidden="true" />;
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="document-type" className="text-sm font-semibold">
        Document Type *
      </Label>
      <Select value={normalizedValue} onValueChange={handleValueChange} disabled={disabled}>
        <SelectTrigger
          id="document-type"
          className={error ? 'border-red-500' : ''}
          aria-describedby={error ? 'document-type-error' : undefined}
          aria-invalid={!!error}
        >
          <SelectValue placeholder="Select document type...">
            {selectedType ? (
              <div className="flex items-center gap-2">
                {renderSelectedIcon()}
                <span>{selectedType.label}</span>
              </div>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {DOCUMENT_TYPES.map((type) => {
            const Icon = type.icon;
            const hasValidIcon = Icon && typeof Icon === 'function';
            return (
              <SelectItem key={type.value} value={type.value}>
                <div className="flex items-center gap-2">
                  {hasValidIcon && <Icon className="w-4 h-4 text-slate-500" aria-hidden="true" />}
                  <span>{type.label}</span>
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {error && (
        <p id="document-type-error" className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}