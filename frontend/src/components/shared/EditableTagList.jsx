import React, { useState, useCallback, useMemo, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { X, Sparkles, Loader2, AlertCircle } from 'lucide-react';

/**
 * Normalize a tag value: trim, collapse internal whitespace, lowercase for comparison
 */
const collapseSpaces = (s) => (s || '').replace(/\s+/g, ' ').trim();
const normalizeTag = (tag) => {
  if (!tag || typeof tag !== 'string') return '';
  return collapseSpaces(tag).toLowerCase();
};

/**
 * Human display cleanup (keep original casing but collapse spaces & trim)
 */
const displayClean = (tag) => {
  if (!tag || typeof tag !== 'string') return '';
  return collapseSpaces(tag);
};

/**
 * Generate a placeholder from the title, handling edge cases
 */
const generatePlaceholder = (title) => {
  if (!title || typeof title !== 'string') return 'Add a tag...';
  const lowerTitle = title.toLowerCase().trim();
  if (!lowerTitle) return 'Add a tag...';
  if (lowerTitle.endsWith('s') && lowerTitle.length > 1) {
    return `Add a ${lowerTitle.slice(0, -1)}...`;
  }
  return `Add a ${lowerTitle}...`;
};

// Soft constraints
const MAX_TAG_LEN = 64;
const MAX_TAGS = 200;

/**
 * EditableTagList - Tag management with AI suggestion support
 * @param {Object} props
 * @param {string} props.title - List title
 * @param {string} props.description - Optional description
 * @param {string[]} props.tags - Current tags
 * @param {Function} props.onTagsChange - Change handler (legacy)
 * @param {Function} props.onUpdate - Change handler (new standard)
 * @param {Function} props.onSuggest - AI suggestion handler
 * @param {boolean} props.isSuggesting - Suggestion loading state
 * @param {boolean} props.disabled - Disabled state
 * @param {string} props.placeholder - Input placeholder
 */
export default function EditableTagList({
  title = '',
  description,
  tags,
  onTagsChange,
  onUpdate,
  onSuggest,
  isSuggesting = false,
  disabled = false,
  placeholder,
}) {
  // Safe defaults to prevent crashes
  const safeTags = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
  // Support both onTagsChange (legacy) and onUpdate (new standard)
  const safeOnTagsChange = typeof onUpdate === 'function' ? onUpdate : (typeof onTagsChange === 'function' ? onTagsChange : () => {});

  const [newTag, setNewTag] = useState('');
  const [validationError, setValidationError] = useState(null);
  const descId = useId();

  // Memoized sanitized tags - filter out any undefined/null/empty values & collapse spaces
  const sanitizedTags = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const t of safeTags) {
      const shown = displayClean(t);
      const key = normalizeTag(shown);
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(shown);
      }
    }
    return out;
  }, [safeTags]);

  // Memoized normalized tags for duplicate checking
  const normalizedExistingTags = useMemo(
    () => sanitizedTags.map((tag) => normalizeTag(tag)),
    [sanitizedTags]
  );

  // Memoized placeholder
  const finalPlaceholder = useMemo(
    () => placeholder || generatePlaceholder(title),
    [placeholder, title]
  );

  // Check if a tag already exists (case-insensitive)
  const tagExists = useCallback(
    (tag) => normalizedExistingTags.includes(normalizeTag(tag)),
    [normalizedExistingTags]
  );

  const setError = (msg) => setValidationError(msg || null);

  const canAddMore = () => sanitizedTags.length < MAX_TAGS;

  // Adds one cleaned tag with validation (length/duplicate/capacity)
  const addOne = useCallback((raw) => {
    const cleanedForDisplay = displayClean(raw);
    const key = normalizeTag(raw);

    if (!key) return 'Tag cannot be empty';
    if (cleanedForDisplay.length > MAX_TAG_LEN) return `Tag too long (max ${MAX_TAG_LEN} chars)`;
    if (tagExists(cleanedForDisplay)) return 'This tag already exists';
    if (!canAddMore()) return `Too many tags (max ${MAX_TAGS})`;

    const updated = [...sanitizedTags, cleanedForDisplay];
    safeOnTagsChange(updated);
    return null;
  }, [sanitizedTags, safeOnTagsChange, tagExists]);

  // Adds potentially multiple tags (comma/semicolon/newline separated)
  const addBatch = useCallback((rawInput) => {
    setError(null);
    if (!rawInput || !collapseSpaces(rawInput)) {
      setError('Tag cannot be empty');
      return;
    }
    const parts = rawInput
      .split(/[,;\n]/g)
      .map((p) => displayClean(p))
      .filter(Boolean);

    if (parts.length === 0) {
      setError('Tag cannot be empty');
      return;
    }

    let err = null;
    for (const p of parts) {
      // short-circuit but attempt each add until error; stop on first error
      err = addOne(p);
      if (err) break;
    }

    if (err) {
      setError(err);
      return;
    }

    setNewTag('');
  }, [addOne]);

  // Handle adding a tag with validation
  const handleAddTag = useCallback(() => addBatch(newTag), [newTag, addBatch]);

  // Handle removing a tag
  const handleRemoveTag = useCallback(
    (tagToRemove) => {
      const updatedTags = sanitizedTags.filter((tag) => tag !== tagToRemove);
      safeOnTagsChange(updatedTags);
    },
    [sanitizedTags, safeOnTagsChange]
  );

  // Keyboard events
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addBatch(newTag);
        return;
      }
      if (e.key === 'Escape') {
        // clear error or input on escape
        if (validationError) setError(null);
        else setNewTag('');
        return;
      }
      if (e.key === 'Backspace' && !newTag) {
        // remove last tag for convenience
        const last = sanitizedTags[sanitizedTags.length - 1];
        if (last) handleRemoveTag(last);
      }
      // Clear error on typing
      if (validationError) setError(null);
    },
    [newTag, sanitizedTags, handleRemoveTag, validationError, addBatch]
  );

  // Handle input change
  const handleInputChange = useCallback(
    (e) => {
      const val = e.target.value ?? '';
      if (validationError) setError(null);
      setNewTag(val);
    },
    [validationError]
  );

  // Paste support: batch add
  const handlePaste = useCallback(
    (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (/[,\n;]/.test(text)) {
        e.preventDefault();
        addBatch(text);
      }
    },
    [addBatch]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-semibold text-slate-800">{title}</h4>
        {typeof onSuggest === 'function' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSuggest}
            disabled={isSuggesting}
            className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
            aria-label={`Generate ${title} suggestions with AI`}
          >
            {isSuggesting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" aria-hidden="true" />
                Suggest with AI
              </>
            )}
          </Button>
        )}
      </div>

      {description && <p className="text-sm text-slate-500 mb-4">{description}</p>}

      <div className="flex gap-2 mb-4">
        <div className="flex-1">
          <Input
            value={newTag}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={finalPlaceholder}
            disabled={isSuggesting || disabled}
            aria-label={`Add new ${title?.toLowerCase().replace(/s$/, '') || 'tag'}`}
            aria-invalid={!!validationError}
            aria-describedby={validationError ? descId : undefined}
            className={validationError ? 'border-red-500' : ''}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={handleAddTag}
          disabled={isSuggesting || disabled || !collapseSpaces(newTag)}
          aria-label="Add tag"
        >
          Add
        </Button>
      </div>

      {/* Validation Error Alert */}
      {validationError && (
        <Alert variant="destructive" className="mb-4" id={descId}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      )}

      {/* Tags Display */}
      <div className="flex flex-wrap gap-2" role="list" aria-label={`Current ${title?.toLowerCase() || 'tags'}`}>
        {sanitizedTags.map((tag, index) => (
          <Badge key={`${tag}-${index}`} variant="secondary" className="text-base py-1 px-3" role="listitem">
            {tag}
            <button
              type="button"
              onClick={() => handleRemoveTag(tag)}
              disabled={disabled}
              className="ml-2 rounded-full hover:bg-black/10 p-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={`Remove ${tag}`}
              tabIndex={0}
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </Badge>
        ))}

        {/* Empty State */}
        {sanitizedTags.length === 0 && !isSuggesting && (
          <p className="text-sm text-slate-400 italic" role="status">
            No {title?.toLowerCase() || 'tags'} added yet.
          </p>
        )}

        {/* Loading State */}
        {isSuggesting && (
          <p className="text-sm text-blue-600 italic flex items-center gap-2" role="status" aria-live="polite">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            Generating suggestions...
          </p>
        )}
      </div>
    </div>
  );
}