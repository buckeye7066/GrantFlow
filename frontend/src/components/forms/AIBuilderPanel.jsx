import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Wand2, Sparkles, Loader2 } from 'lucide-react';

/**
 * Reusable AI Builder Panel for any form
 * Provides consistent UI for AI-powered form population
 */
export default function AIBuilderPanel({
  inputText,
  onInputChange,
  onExtract,
  isHarvesting,
  placeholder,
  title = "AI Profile Builder",
  description = "Paste or describe information, and AI will automatically extract and populate the form fields below.",
}) {
  return (
    <Card className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wand2 className="w-5 h-5 text-purple-600" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ai-input">
            Describe the Profile (paste bio, website text, resume, etc.)
          </Label>
          <Textarea
            id="ai-input"
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={placeholder || "Example: John Smith is a high school senior from Nashville, TN with a 3.8 GPA who wants to study forensic science..."}
            rows={6}
            className="font-mono text-sm"
            aria-describedby="ai-input-help"
          />
          <p id="ai-input-help" className="text-xs text-slate-500">
            The more detail you provide, the better AI can populate your form
          </p>
        </div>
        <Button
          type="button"
          onClick={onExtract}
          disabled={isHarvesting || !inputText.trim()}
          className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
          aria-busy={isHarvesting}
        >
          {isHarvesting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Extracting Information...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Extract & Populate Profile
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}