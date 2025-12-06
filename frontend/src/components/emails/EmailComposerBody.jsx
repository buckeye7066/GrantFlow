import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Loader2, Wand2 } from 'lucide-react';

/**
 * Email composer form fields
 * Separated for better maintainability
 */
export default function EmailComposerBody({
  emails,
  recipient,
  onRecipientChange,
  subject,
  onSubjectChange,
  body,
  onBodyChange,
  onGenerate,
  isGenerating,
  isSending,
}) {
  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-4 py-4">
      {/* Recipient Select */}
      <div className="space-y-2">
        <Label htmlFor="recipient">Recipient *</Label>
        <Select 
          value={recipient} 
          onValueChange={onRecipientChange}
          disabled={isSending}
        >
          <SelectTrigger id="recipient">
            <SelectValue placeholder="Select an email" />
          </SelectTrigger>
          <SelectContent>
            {emails.map((email, index) => (
              <SelectItem key={index} value={email.value}>
                {email.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Subject */}
      <div className="space-y-2">
        <Label htmlFor="subject">Subject *</Label>
        <Input
          id="subject"
          value={subject}
          onChange={(e) => onSubjectChange(e.target.value)}
          disabled={isSending}
          aria-required="true"
        />
      </div>

      {/* Message Body */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <Label htmlFor="body">Message *</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={onGenerate}
            disabled={isGenerating || isSending}
            type="button"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4 mr-2" />
                Generate Update
              </>
            )}
          </Button>
        </div>
        <Textarea
          id="body"
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          className="h-64 font-mono text-sm"
          placeholder="Click 'Generate Update' to create a status email..."
          disabled={isSending}
          aria-required="true"
        />
        <div className="flex justify-between items-center">
          <p className="text-xs text-slate-500">
            💡 Tip: The AI will include all pipeline grants, profile info, and request for updates
          </p>
          {wordCount > 0 && (
            <p className="text-xs text-slate-400">
              {wordCount} words
            </p>
          )}
        </div>
      </div>
    </div>
  );
}