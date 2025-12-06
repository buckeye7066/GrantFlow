import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

/**
 * Reusable checkbox field with label
 * Reduces boilerplate for boolean fields
 */
export default function CheckboxField({
  id,
  name,
  label,
  checked,
  onChange,
  disabled = false,
  highlight = false,
}) {
  return (
    <div className={`flex items-center space-x-2 ${highlight ? 'bg-purple-50 p-2 rounded' : ''}`}>
      <Checkbox
        id={id || name}
        name={name}
        checked={checked}
        onCheckedChange={(checkedValue) => onChange({ 
          target: { name, type: 'checkbox', checked: checkedValue } 
        })}
        disabled={disabled}
      />
      <Label 
        htmlFor={id || name} 
        className={`cursor-pointer ${highlight ? 'font-semibold text-purple-900' : ''}`}
      >
        {label}
        {highlight && (
          <span className="ml-2 text-xs bg-purple-200 text-purple-800 px-2 py-0.5 rounded">
            AI
          </span>
        )}
      </Label>
    </div>
  );
}