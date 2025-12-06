import React from 'react';
import { Textarea } from '@/components/ui/textarea';
import ReactMarkdown from 'react-markdown';

/**
 * Editable markdown field that switches between edit and view modes
 */
export default function EditableMarkdown({ 
  value, 
  onChange, 
  isDraft, 
  rows = 6,
  placeholder = '' 
}) {
  if (isDraft) {
    return (
      <Textarea
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="font-serif"
        placeholder={placeholder}
      />
    );
  }

  return (
    <div className="prose max-w-none">
      <ReactMarkdown>{value || '*No content*'}</ReactMarkdown>
    </div>
  );
}