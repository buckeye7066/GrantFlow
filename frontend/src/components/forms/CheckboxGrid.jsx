import React from 'react';
import CheckboxField from './CheckboxField';

/**
 * Grid layout for checkbox fields with responsive columns
 * 
 * @param {Array} fields - Array of field definitions: [{ name, label, checked, onChange }]
 * @param {number} columns - Number of columns (1-4)
 * @param {Array} aiExtractedFields - List of field names that were AI-extracted
 */
export default function CheckboxGrid({ 
  fields, 
  columns = 2,
  aiExtractedFields = [] 
}) {
  const gridClass = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
  }[columns] || 'grid-cols-1 md:grid-cols-2';

  return (
    <div className={`grid ${gridClass} gap-x-6 gap-y-3`}>
      {fields.map(field => (
        <CheckboxField
          key={field.name}
          {...field}
          highlight={aiExtractedFields.includes(field.name)}
        />
      ))}
    </div>
  );
}