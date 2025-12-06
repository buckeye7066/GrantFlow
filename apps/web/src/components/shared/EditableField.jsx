import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Check, X, Pencil, AlertCircle } from 'lucide-react';

const normalizeValue = (val) => (val ?? '');

/**
 * EditableField - Inline editable field with async save support
 * @param {Object} props
 * @param {string} props.label - Field label
 * @param {any} props.value - Current value
 * @param {Function} props.onSave - Save handler (can be async)
 * @param {string} props.type - Input type
 * @param {boolean} props.isSubmitting - External submitting state
 * @param {boolean} props.highlight - Highlight missing values
 */
export default function EditableField({
  label,
  value,
  onSave,
  type = 'text',
  isSubmitting,
  highlight = false
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [currentValue, setCurrentValue] = useState(() => normalizeValue(value));
  const [localPending, setLocalPending] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // Sync when external value changes and we're not actively saving
    if (!localPending && !isSubmitting) {
      setCurrentValue(normalizeValue(value));
    }
  }, [value, localPending, isSubmitting]);

  const trimmedCurrent = useMemo(() => String(normalizeValue(currentValue)).trim(), [currentValue]);
  const trimmedOriginal = useMemo(() => String(normalizeValue(value)).trim(), [value]);

  const hasValue = useMemo(() => trimmedCurrent !== '', [trimmedCurrent]);
  const shouldHighlight = useMemo(() => highlight && !hasValue, [highlight, hasValue]);
  const hasChanged = useMemo(() => trimmedCurrent !== trimmedOriginal, [trimmedCurrent, trimmedOriginal]);

  const canInteract = useMemo(() => !(isSubmitting || localPending), [isSubmitting, localPending]);

  const finishEdit = useCallback(() => {
    if (mountedRef.current) setIsEditing(false);
  }, []);

  const handleSave = useCallback(async () => {
    // Avoid no-op saves; allow explicit clearing (empty string) if it differs
    if (!hasChanged) {
      finishEdit();
      return;
    }
    if (!canInteract) return;
    if (typeof onSave !== 'function') {
      finishEdit();
      return;
    }

    try {
      setLocalPending(true);
      const maybePromise = onSave(trimmedCurrent);
      if (maybePromise && typeof maybePromise.then === 'function') {
        await maybePromise;
      }
      // Only exit edit mode on success
      finishEdit();
    } catch (err) {
      // Stay in editing on error; optionally could surface error via toast upstream
      // No UI change here per requirement
    } finally {
      if (mountedRef.current) setLocalPending(false);
    }
  }, [hasChanged, canInteract, onSave, trimmedCurrent, finishEdit]);

  const handleCancel = useCallback(() => {
    if (!canInteract) return;
    setCurrentValue(normalizeValue(value));
    finishEdit();
  }, [value, canInteract, finishEdit]);

  const handleKeyDown = useCallback((e) => {
    if (type !== 'textarea') {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSave();
      }
    } else {
      const isCmdEnter = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
      if (isCmdEnter) {
        e.preventDefault();
        handleSave();
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }, [type, handleSave, handleCancel]);

  const handleEditClick = useCallback(() => {
    if (canInteract) setIsEditing(true);
  }, [canInteract]);

  const handleEditKeyDown = useCallback((e) => {
    if (!canInteract) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsEditing(true);
    }
  }, [canInteract]);

  return (
    <div className={shouldHighlight ? 'p-3 bg-rose-50 rounded-lg border border-rose-300' : ''}>
      <p className={`text-sm font-medium mb-1 ${shouldHighlight ? 'text-rose-800 flex items-center gap-1' : 'text-slate-500'}`}>
        {shouldHighlight && <AlertCircle className="w-4 h-4" aria-hidden="true" />}
        {label}
      </p>
      {isEditing ? (
        <div className="flex flex-col gap-2">
          {type === 'textarea' ? (
            <Textarea
              value={normalizeValue(currentValue)}
              onChange={(e) => setCurrentValue(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              className="h-32 bg-white"
              aria-label={`Edit ${label}`}
              disabled={!canInteract}
            />
          ) : (
            <Input
              value={normalizeValue(currentValue)}
              onChange={(e) => setCurrentValue(e.target.value)}
              onKeyDown={handleKeyDown}
              type={type}
              autoFocus
              className="bg-white"
              aria-label={`Edit ${label}`}
              disabled={!canInteract}
            />
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={!canInteract} aria-label="Save changes">
              <Check className="w-4 h-4 mr-2" /> {(isSubmitting || localPending) ? 'Saving...' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel} disabled={!canInteract} aria-label="Cancel editing">
              <X className="w-4 h-4 mr-2" /> Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={`group relative flex items-start justify-between p-2 -ml-2 rounded-lg hover:bg-slate-100 cursor-pointer min-h-[40px] ${shouldHighlight ? 'ring-2 ring-rose-500 rounded-md' : ''}`}
          onClick={handleEditClick}
          onKeyDown={handleEditKeyDown}
          role="button"
          tabIndex={0}
          aria-label={`Edit ${label}. Current value: ${trimmedOriginal || 'empty'}`}
        >
          <p className="text-slate-800 whitespace-pre-wrap flex-1">
            {trimmedOriginal || <span className="text-rose-600 font-medium">Click to add missing info...</span>}
          </p>
          <div className="absolute top-2 right-2 pointer-events-none">
            <Pencil className="w-4 h-4 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
          </div>
        </div>
      )}
    </div>
  );
}