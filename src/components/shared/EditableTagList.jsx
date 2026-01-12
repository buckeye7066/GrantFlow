import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { X, Sparkles, Loader2 } from 'lucide-react';

export default function EditableTagList({ 
  title = 'Tags', 
  description = '', 
  tags, 
  onTagsChange,
  onUpdate,  // Legacy prop name for backwards compatibility
  onSuggest, 
  isSuggesting,
  placeholder,  // Legacy prop (ignored, use title/description instead)
  disabled,  // Legacy prop (ignored)
}) {
  const [newTag, setNewTag] = useState('');
  
  // Support both prop names for backwards compatibility
  const handleTagsUpdate = onTagsChange || onUpdate;

  // Sanitize tags: filter out null, undefined, and empty strings, ensure all are strings
  const sanitizedTags = (tags || []).filter(
    (tag) => tag != null && typeof tag === 'string' && tag.trim() !== ''
  );

  // Safely get lowercase title with fallback
  const safeTitle = typeof title === 'string' && title.length > 0 ? title : 'Tags';
  const safeTitleLower = safeTitle.toLowerCase();
  
  // Create singular form: remove trailing 's' if present
  const singularTitle = safeTitleLower.endsWith('s') 
    ? safeTitleLower.slice(0, -1) 
    : safeTitleLower;

  const handleAddTag = () => {
    const trimmedTag = newTag.trim();
    if (trimmedTag && handleTagsUpdate) {
      // Filter existing tags to remove any invalid values, then add the new tag
      const validExistingTags = (tags || []).filter(
        (tag) => tag != null && typeof tag === 'string' && tag.trim() !== ''
      );
      const updatedTags = [...new Set([...validExistingTags, trimmedTag])];
      handleTagsUpdate(updatedTags);
      setNewTag('');
    }
  };

  const handleRemoveTag = (tagToRemove) => {
    if (tagToRemove == null || !handleTagsUpdate) return;
    
    // Filter out the tag to remove and any invalid values
    const updatedTags = (tags || []).filter(
      (tag) => tag != null && typeof tag === 'string' && tag.trim() !== '' && tag !== tagToRemove
    );
    handleTagsUpdate(updatedTags);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-semibold text-slate-800">{safeTitle}</h4>
        {/* Only show AI button if onSuggest handler is provided */}
        {onSuggest && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSuggest}
            disabled={isSuggesting}
            className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
          >
            {isSuggesting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-2" />
            )}
            Suggest with AI
          </Button>
        )}
      </div>
      {description && (
        <p className="text-sm text-slate-500 mb-4">{description}</p>
      )}
      
      <div className="flex gap-2 mb-4">
        <Input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Add a ${singularTitle}...`}
        />
        <Button type="button" variant="outline" onClick={handleAddTag}>Add</Button>
      </div>
      
      <div className="flex flex-wrap gap-2">
        {sanitizedTags.map((tag) => (
          <Badge key={tag} variant="secondary" className="text-base py-1 px-3">
            {tag}
            <button
              type="button"
              onClick={() => handleRemoveTag(tag)}
              className="ml-2 rounded-full hover:bg-black/10 p-0.5"
              aria-label={`Remove ${tag}`}
            >
              <X className="w-3 h-3" />
            </button>
          </Badge>
        ))}
        {sanitizedTags.length === 0 && !isSuggesting && (
          <p className="text-sm text-slate-400 italic">No {safeTitleLower} added yet.</p>
        )}
      </div>
    </div>
  );
}