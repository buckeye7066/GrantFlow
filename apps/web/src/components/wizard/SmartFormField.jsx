import React, { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Sparkles, 
  Loader2, 
  Copy, 
  CheckCircle2,
  Wand2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Info
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { base44 } from '@/api/base44Client';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function SmartFormField({
  label,
  value,
  onChange,
  placeholder,
  fieldName,
  questionType = 'general',
  wordLimit = null,
  helpText = '',
  showAI = true,
  grant = null,
  organization = null,
  error = null,
  rows = 6
}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  // Refinement options
  const [focus, setFocus] = useState('clarity');
  const [tone, setTone] = useState('professional');
  
  const { toast } = useToast();

  const wordCount = value ? value.split(/\s+/).filter(w => w).length : 0;
  const isOverLimit = wordLimit && wordCount > wordLimit;
  const isNearLimit = wordLimit && wordCount > wordLimit * 0.9;

  const handleGenerateDraft = async () => {
    if (!grant || !organization) {
      toast({
        variant: 'destructive',
        title: 'Missing Data',
        description: 'Grant and organization information required',
      });
      return;
    }

    setIsGenerating(true);

    try {
      console.log('[SmartFormField] Using InvokeLLM for generation...');
      
      // Use InvokeLLM directly instead of backend function
      const llmResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `You are a professional grant writer. Generate a compelling response to the following question for a grant application.

QUESTION: ${label}
QUESTION TYPE: ${questionType}

ORGANIZATION: ${organization.name}
MISSION: ${organization.mission || 'Not provided'}
FOCUS AREAS: ${organization.focus_areas?.join(', ') || 'Not provided'}

GRANT: ${grant.title}
FUNDER: ${grant.funder}
PROGRAM: ${grant.program_description || 'See grant listing'}

${wordLimit ? `WORD LIMIT: ${wordLimit} words maximum` : ''}

Write a professional, compelling response. Be specific and factual. Return ONLY the response text.`,
        add_context_from_internet: false
      });

      const responseText = typeof llmResponse === 'string' ? llmResponse : (llmResponse?.content || llmResponse?.response || '');
      
      if (responseText) {
        onChange(responseText);
        
        toast({
          title: '✨ Draft Generated',
          description: `Created ${responseText.split(/\s+/).length} word response`,
          duration: 4000,
        });
      } else {
        throw new Error('Failed to generate response');
      }
    } catch (error) {
      console.error('[SmartFormField] Generation error:', error);
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message || 'Could not generate draft. Please try again.',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRefineText = async () => {
    if (!value || value.trim().length < 10) {
      toast({
        variant: 'destructive',
        title: 'No Text to Refine',
        description: 'Enter some text first, then use AI to improve it',
      });
      return;
    }

    setIsRefining(true);

    try {
      console.log('[SmartFormField] Using InvokeLLM for refinement...');
      
      // Use InvokeLLM directly instead of backend function
      const llmResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `You are an expert grant writer. Refine the following text to improve its ${focus} while maintaining a ${tone} tone.

ORIGINAL TEXT:
${value}

${wordLimit ? `WORD LIMIT: ${wordLimit} words maximum` : ''}

Improve the text for grant application purposes. Focus on ${focus}. Use a ${tone} tone.
Return ONLY the refined text, no explanations.`,
        add_context_from_internet: false
      });

      const refinedText = typeof llmResponse === 'string' ? llmResponse : (llmResponse?.content || llmResponse?.response || '');
      
      if (refinedText) {
        onChange(refinedText);
        
        toast({
          title: '✨ Text Refined',
          description: 'Text has been improved',
          duration: 5000,
        });
      } else {
        throw new Error('Failed to refine text');
      }
    } catch (error) {
      console.error('[SmartFormField] Refinement error:', error);
      toast({
        variant: 'destructive',
        title: 'Refinement Failed',
        description: error.message || 'Could not refine text. Please try again.',
      });
    } finally {
      setIsRefining(false);
    }
  };

  const handleCopy = () => {
    if (value) {
      navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      
      toast({
        title: 'Copied to Clipboard',
        description: 'Text has been copied',
      });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-base font-semibold text-slate-900">
          {label}
          {helpText && (
            <span className="ml-2 text-xs font-normal text-slate-500">
              <Info className="w-3 h-3 inline mb-0.5" /> {helpText}
            </span>
          )}
        </Label>
        <div className="flex items-center gap-2">
          {wordLimit && (
            <Badge 
              variant={isOverLimit ? 'destructive' : isNearLimit ? 'outline' : 'secondary'}
              className={isNearLimit && !isOverLimit ? 'border-amber-400 text-amber-700' : ''}
            >
              {wordCount}/{wordLimit} words
            </Badge>
          )}
          {value && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleCopy}
              className="h-7"
            >
              {copied ? (
                <>
                  <CheckCircle2 className="w-3 h-3 mr-1 text-green-600" />
                  <span className="text-xs">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3 mr-1" />
                  <span className="text-xs">Copy</span>
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {showAI && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={handleGenerateDraft}
              disabled={isGenerating || isRefining}
              size="sm"
              variant="outline"
              className="border-purple-300 text-purple-700 hover:bg-purple-50"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4 mr-2" />
                  AI Draft
                </>
              )}
            </Button>

            {value && value.trim().length > 10 && (
              <Button
                type="button"
                onClick={handleRefineText}
                disabled={isGenerating || isRefining}
                size="sm"
                variant="outline"
                className="border-amber-300 text-amber-700 hover:bg-amber-50"
              >
                {isRefining ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Refining...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refine Text
                  </>
                )}
              </Button>
            )}

            {value && value.trim().length > 10 && (
              <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-slate-600"
                  >
                    {showAdvanced ? (
                      <>
                        <ChevronUp className="w-4 h-4 mr-1" />
                        Hide Options
                      </>
                    ) : (
                      <>
                        <ChevronDown className="w-4 h-4 mr-1" />
                        Advanced
                      </>
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs text-slate-600">Focus On:</Label>
                      <Select value={focus} onValueChange={setFocus}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="clarity">Clarity</SelectItem>
                          <SelectItem value="conciseness">Conciseness</SelectItem>
                          <SelectItem value="impact">Impact</SelectItem>
                          <SelectItem value="professionalism">Professionalism</SelectItem>
                          <SelectItem value="grammar">Grammar</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs text-slate-600">Tone:</Label>
                      <Select value={tone} onValueChange={setTone}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="professional">Professional</SelectItem>
                          <SelectItem value="compassionate">Compassionate</SelectItem>
                          <SelectItem value="academic">Academic</SelectItem>
                          <SelectItem value="persuasive">Persuasive</SelectItem>
                          <SelectItem value="technical">Technical</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </div>
      )}

      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={`${error ? 'border-red-500' : ''} ${isOverLimit ? 'border-red-500' : ''}`}
      />

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}

      {isOverLimit && (
        <Alert variant="destructive" className="py-2">
          <AlertDescription className="text-sm">
            ⚠️ Over word limit by {wordCount - wordLimit} words. Please shorten your response.
          </AlertDescription>
        </Alert>
      )}

      {!value && showAI && (
        <p className="text-xs text-slate-500 flex items-center gap-1">
          <Sparkles className="w-3 h-3" />
          Click "AI Draft" to generate a complete response, or start typing and use "Refine" to improve it
        </p>
      )}
    </div>
  );
}