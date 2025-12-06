import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Wand2, ExternalLink } from 'lucide-react';

/**
 * Dialog for selecting and adding AI-suggested partners
 */
export default function AISuggestionsDialog({ 
  open, 
  onOpenChange, 
  onGetSuggestions,
  onAddSuggestions,
  isLoading,
  isAdding,
  suggestions = [],
  error 
}) {
  const [selectedSuggestions, setSelectedSuggestions] = useState([]);

  // Load suggestions when dialog opens
  useEffect(() => {
    if (open) {
      onGetSuggestions();
      setSelectedSuggestions([]);
    }
  }, [open, onGetSuggestions]);

  const handleToggleSuggestion = (suggestion) => {
    setSelectedSuggestions(prev => {
      const isSelected = prev.find(s => s.name === suggestion.name);
      if (isSelected) {
        return prev.filter(s => s.name !== suggestion.name);
      } else {
        return [...prev, suggestion];
      }
    });
  };

  const handleAddSelected = () => {
    if (selectedSuggestions.length > 0) {
      onAddSuggestions(selectedSuggestions);
      setSelectedSuggestions([]);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    setSelectedSuggestions([]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-blue-500" />
            AI Partner Suggestions
          </DialogTitle>
          <DialogDescription>
            Select one or more potential funding sources to add to your registry.
          </DialogDescription>
        </DialogHeader>
        
        <div className="py-4">
          {isLoading && (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
            </div>
          )}

          {!isLoading && suggestions.length > 0 && (
            <ul className="space-y-3">
              {suggestions.map((suggestion, index) => {
                const isSelected = selectedSuggestions.find(s => s.name === suggestion.name);
                
                return (
                  <li
                    key={index}
                    className={`border rounded-lg p-4 transition-all cursor-pointer ${
                      isSelected 
                        ? 'border-blue-500 bg-blue-50' 
                        : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                    onClick={() => handleToggleSuggestion(suggestion)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex items-center pt-1">
                        <input
                          type="checkbox"
                          checked={!!isSelected}
                          onChange={() => handleToggleSuggestion(suggestion)}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                      <div className="flex-1">
                        <div className="font-semibold text-slate-900">{suggestion.name}</div>
                        <p className="text-sm text-slate-600 mt-1">{suggestion.reason || ''}</p>
                        {suggestion.api_base_url && (
                          <a
                            href={suggestion.api_base_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline mt-2 inline-flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="w-3 h-3" />
                            {suggestion.api_base_url}
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!isLoading && suggestions.length === 0 && !error && (
            <div className="text-center text-slate-500 py-10">
              <p className="font-semibold">No new suggestions found.</p>
              <p className="text-sm">The AI couldn't find any new partners based on your current list.</p>
            </div>
          )}

          {error && (
            <div className="text-center text-red-500 py-10">
              <p className="font-semibold">Could not load suggestions.</p>
              <p className="text-sm">{error.message}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-6 pt-4 border-t">
          <div className="text-sm text-slate-600">
            {selectedSuggestions.length > 0 && (
              <span className="font-medium text-slate-900">
                {selectedSuggestions.length} selected
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={handleAddSelected}
              disabled={selectedSuggestions.length === 0 || isAdding}
            >
              {isAdding ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  Add {selectedSuggestions.length > 0 ? `${selectedSuggestions.length} ` : ''}
                  Partner{selectedSuggestions.length !== 1 ? 's' : ''}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}