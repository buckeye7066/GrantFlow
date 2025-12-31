import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { X, Sparkles, Loader2 } from 'lucide-react';

export default function EditableTagList({ title, description, tags, onTagsChange, onSuggest, isSuggesting }) {
  const [newTag, setNewTag] = useState('');

  const handleAddTag = () => {
    if (newTag.trim()) {
      const updatedTags = [...new Set([...(tags || []), newTag.trim()])];
      onTagsChange(updatedTags);
      setNewTag('');
    }
  };

  const handleRemoveTag = (tagToRemove) => {
    const updatedTags = (tags || []).filter(tag => tag !== tagToRemove);
    onTagsChange(updatedTags);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-semibold text-slate-800">{title}</h4>
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
      </div>
      <p className="text-sm text-slate-500 mb-4">{description}</p>
      
      <div className="flex gap-2 mb-4">
        <Input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyPress={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAddTag();
            }
          }}
          placeholder={`Add a ${title.toLowerCase().slice(0, -1)}...`}
        />
        <Button type="button" variant="outline" onClick={handleAddTag}>Add</Button>
      </div>
      
      <div className="flex flex-wrap gap-2">
        {(tags || []).map((tag, index) => (
          <Badge key={index} variant="secondary" className="text-base py-1 px-3">
            {tag}
            <button
              type="button"
              onClick={() => handleRemoveTag(tag)}
              className="ml-2 rounded-full hover:bg-black/10 p-0.5"
            >
              <X className="w-3 h-3" />
            </button>
          </Badge>
        ))}
        {(!tags || tags.length === 0) && !isSuggesting && (
             <p className="text-sm text-slate-400 italic">No {title.toLowerCase()} added yet.</p>
        )}
      </div>
    </div>
  );
}