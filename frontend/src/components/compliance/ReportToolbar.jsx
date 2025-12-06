import React from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles, Save, Send } from 'lucide-react';

/**
 * Toolbar for report actions (generate, save, submit)
 */
export default function ReportToolbar({ 
  isDraft, 
  hasContent,
  isGenerating, 
  isSaving,
  onGenerate, 
  onSave, 
  onSubmit 
}) {
  // Show generate button if draft and no content
  if (isDraft && !hasContent) {
    return (
      <Button 
        onClick={onGenerate}
        disabled={isGenerating}
        className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
      >
        {isGenerating ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Generating...
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4 mr-2" />
            Generate with AI
          </>
        )}
      </Button>
    );
  }

  // Show save/submit buttons if draft with content
  if (isDraft && hasContent) {
    return (
      <div className="flex gap-2">
        <Button 
          variant="outline" 
          onClick={onSave} 
          disabled={isSaving}
        >
          <Save className="w-4 h-4 mr-2" />
          Save Draft
        </Button>
        <Button 
          onClick={onSubmit} 
          disabled={isSaving}
        >
          <Send className="w-4 h-4 mr-2" />
          Submit Report
        </Button>
      </div>
    );
  }

  return null;
}