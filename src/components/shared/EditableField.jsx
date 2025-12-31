import React, { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Check, X, Pencil, AlertCircle } from 'lucide-react';

export default function EditableField({ label, value, onSave, type = 'text', isSubmitting, highlight = false }) {
  const [isEditing, setIsEditing] = useState(false);
  const [currentValue, setCurrentValue] = useState(value);

  useEffect(() => {
    setCurrentValue(value);
  }, [value]);

  const handleSave = () => {
    onSave(currentValue);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setCurrentValue(value);
    setIsEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && type !== 'textarea' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      handleCancel();
    }
  };
  
  const hasValue = currentValue !== null && currentValue !== undefined && currentValue !== '';
  const shouldHighlight = highlight && !hasValue;

  return (
    <div className={shouldHighlight ? 'p-3 bg-rose-50 rounded-lg border border-rose-300' : ''}>
      <p className={`text-sm font-medium mb-1 ${shouldHighlight ? 'text-rose-800 flex items-center gap-1' : 'text-slate-500'}`}>
        {shouldHighlight && <AlertCircle className="w-4 h-4" />}
        {label}
      </p>
      {isEditing ? (
        <div className="flex flex-col gap-2">
          {type === 'textarea' ? (
            <Textarea
              value={currentValue || ''}
              onChange={(e) => setCurrentValue(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              className="h-32 bg-white"
            />
          ) : (
            <Input
              value={currentValue || ''}
              onChange={(e) => setCurrentValue(e.target.value)}
              onKeyDown={handleKeyDown}
              type={type}
              autoFocus
              className="bg-white"
            />
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={isSubmitting}>
              <Check className="w-4 h-4 mr-2" /> {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel} disabled={isSubmitting}>
              <X className="w-4 h-4 mr-2" /> Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div 
          className={`group relative flex items-start justify-between p-2 -ml-2 rounded-lg hover:bg-slate-100 cursor-pointer min-h-[40px] ${shouldHighlight ? 'ring-2 ring-rose-500 rounded-md' : ''}`}
          onClick={() => setIsEditing(true)}
        >
          <p className="text-slate-800 whitespace-pre-wrap flex-1">{value || <span className="text-rose-600 font-medium">Click to add missing info...</span>}</p>
          <div className="absolute top-2 right-2">
            <Pencil className="w-4 h-4 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      )}
    </div>
  );
}