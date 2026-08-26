import React, { useState } from 'react';
import { apiFetch } from '@/api/apiClient';
import { formatAddress } from '@/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Copy, Sparkles, Loader2, AlertCircle, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import { createLogger } from '@/utils/logger';
import { copyTextToClipboard } from '@/utils/clipboard';

const ProfileField = ({ label, value, onCopy }) => {
  if (!value || (Array.isArray(value) && value.length === 0)) {
    return null;
  }
  const displayValue = Array.isArray(value) ? value.join(', ') : value;
  return (
    <div className="flex items-start justify-between gap-4 p-2 border-b">
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{label}</p>
        <p className="text-sm text-slate-800 break-words">{displayValue}</p>
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={() => onCopy(displayValue)}>
        <Copy className="w-4 h-4" />
      </Button>
    </div>
  );
};

export default function GrantPortalAssistant({ open, onClose, grant, organization }) {
  if (!grant || !organization) {
    return null;
  }
  const { toast } = useToast();
  const log = React.useMemo(() => createLogger('GrantPortalAssistant'), []);
  const [portalQuestion, setPortalQuestion] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [showPortal, setShowPortal] = useState(true);
  const [iframeError, setIframeError] = useState(false);

  const portalUrl = grant.url;
  const hasPortalUrl = portalUrl && portalUrl.startsWith('http');

  const handleCopyToClipboard = async (text) => {
    try {
      const copied = await copyTextToClipboard(text);
      if (!copied) throw new Error('Clipboard copy unavailable');
      toast({
        title: "Copied!",
        description: "Text copied to clipboard"
      });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Copy Failed",
        description: e.message
      });
    }
  };

  const handleAskAI = async () => {
    log.debug('generate answer clicked', { hasQuestion: Boolean(portalQuestion?.trim()) });
    
    if (!portalQuestion.trim()) {
      toast({
        variant: "destructive",
        title: "Question Required",
        description: "Please enter a question from the portal first."
      });
      return;
    }
    
    setIsGenerating(true);
    setError(null);
    setAiAnswer('');

    const ALLOWED_PROFILE_KEYS = new Set([
  'name', 'ein', 'uei', 'sam_registered', 'address', 'city', 'state', 'zip',
  'website', 'email', 'phone', 'mission', 'primary_goal', 'target_population',
  'geographic_focus', 'funding_amount_needed', 'timeline', 'past_experience',
  'unique_qualities', 'collaboration_partners', 'sustainability_plan',
  'barriers_faced', 'gpa', 'act_score', 'sat_score', 'student_grade_level',
  'intended_major', 'extracurricular_activities', 'achievements',
  'community_service_hours', 'keywords', 'focus_areas'
]);
const profileContext = Object.entries(organization)
  .filter(([key, value]) =>
    ALLOWED_PROFILE_KEYS.has(key) &&
    value !== null &&
    value !== undefined &&
    value !== '' &&
    (!Array.isArray(value) || value.length > 0)
  )
  .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
  .join('\n');

    const grantContext = `
- Grant Title: ${grant.title}
- Funder: ${grant.funder}
- Program Description: ${grant.program_description || 'N/A'}
    `.trim();

    const prompt = `You are an expert grant writing assistant. Your task is to answer a question from a grant application portal based on the provided context.

CONTEXT - APPLICANT PROFILE:
---
${profileContext}
---

CONTEXT - GRANT OPPORTUNITY:
---
${grantContext}
---

PORTAL QUESTION:
"${portalQuestion}"

INSTRUCTIONS:
1. Synthesize information from BOTH the applicant profile and the grant opportunity context.
2. Draft a clear, concise, and compelling answer to the portal question.
3. The response should be ready to be pasted directly into the application. Do NOT add any extra conversational text, greetings, or explanations.
`;

    log.debug('calling AI');
    
    try {
      const response = await apiFetch('/api/ai/invoke', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });
      log.debug('AI response received', { responseType: typeof response });
      const answerText =
        typeof response === 'string'
          ? response
          : response?.answer ?? response?.text ?? response?.data ?? JSON.stringify(response);
      if (!answerText || !answerText.trim()) {
        throw new Error('AI returned an empty response');
      }
      setAiAnswer(answerText);
      toast({
        title: "Answer Generated!",
        description: "You can now copy and paste this into the portal."
      });
    } catch (err) {
      console.error('[Portal Assistant] AI call failed:', err);
      setError("The AI assistant failed to generate a response. Please try again.");
      toast({
        variant: "destructive",
        title: "Generation Failed",
        description: "Could not generate answer. Please try again."
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const profileFields = [
    { label: 'Legal Name', value: organization.name },
    { label: 'EIN', value: organization.ein },
    { label: 'UEI', value: organization.uei },
    { label: 'SAM Registered', value: organization.sam_registered ? 'Yes' : 'No' },
    { label: 'Address', value: (() => {
    const parts = [
      formatAddress(organization.address),
      organization.city,
      organization.state,
      organization.zip
    ].map(p => (p ?? '').trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const cityStateZip = [organization.city, organization.state, organization.zip]
      .map(p => (p ?? '').trim()).filter(Boolean).join(' ');
    const street = (formatAddress(organization.address) ?? '').trim();
    return [street, cityStateZip].filter(Boolean).join(', ');
  })() },
    { label: 'Website', value: organization.website },
    { label: 'Emails', value: organization.email },
    { label: 'Phone Numbers', value: organization.phone },
    { label: 'Mission Statement', value: organization.mission },
    { label: 'Primary Goal (Q1)', value: organization.primary_goal },
    { label: 'Target Population (Q2)', value: organization.target_population },
    { label: 'Geographic Focus (Q3)', value: organization.geographic_focus },
    { label: 'Funding Need (Q4)', value: organization.funding_amount_needed },
    { label: 'Timeline (Q5)', value: organization.timeline },
    { label: 'Track Record (Q6)', value: organization.past_experience },
    { label: 'Unique Qualities (Q7)', value: organization.unique_qualities },
    { label: 'Collaborations (Q8)', value: organization.collaboration_partners },
    { label: 'Competitive Advantage (Q9)', value: organization.sustainability_plan },
    { label: 'Organizational Capacity (Q10)', value: organization.barriers_faced },
    { label: 'GPA', value: organization.gpa },
    { label: 'ACT Score', value: organization.act_score },
    { label: 'SAT Score', value: organization.sat_score },
    { label: 'Grade Level', value: organization.student_grade_level },
    { label: 'Intended Major', value: organization.intended_major },
    { label: 'Extracurricular Activities', value: organization.extracurricular_activities },
    { label: 'Achievements', value: organization.achievements },
    { label: 'Community Service Hours', value: organization.community_service_hours },
    { label: 'Keywords', value: organization.keywords },
    { label: 'Focus Areas', value: organization.focus_areas },
  ];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] h-[90vh] flex flex-col p-0">
        <DialogHeader className="p-6 border-b">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-2xl font-bold flex items-center gap-3">
                <Sparkles className="w-6 h-6 text-blue-600" />
                AI Portal Assistant
              </DialogTitle>
              <DialogDescription className="mt-1">
                Use this assistant to quickly fill out the application on the funder's portal for "{grant.title}".
              </DialogDescription>
            </div>
            
            {hasPortalUrl && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPortal(!showPortal)}
                  className="gap-2"
                >
                  {showPortal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  {showPortal ? 'Hide' : 'Show'} Portal
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(portalUrl, '_blank')}
                  className="gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open in New Tab
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>
        
        <div className="flex-1 overflow-hidden flex">
          {/* Portal View (if URL exists and shown) */}
          {hasPortalUrl && showPortal && (
            <div className="w-1/2 border-r flex flex-col bg-slate-50">
              <div className="p-3 bg-slate-100 border-b flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-xs font-medium text-slate-600">Portal:</span>
                  <span className="text-xs text-slate-500 truncate">{portalUrl}</span>
                </div>
              </div>
              <div className="flex-1 relative">
                {!iframeError ? (
                  <iframe
                    src={portalUrl}
                    className="w-full h-full border-0"
                    title="Application Portal"
                    sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
                    onError={() => setIframeError(true)}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full p-8 text-center">
                    <AlertCircle className="w-12 h-12 text-amber-500 mb-4" />
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">Portal Cannot Be Embedded</h3>
                    <p className="text-sm text-slate-600 mb-4 max-w-md">
                      This portal blocks embedding for security reasons. Use the "Open in New Tab" button above to access it in a separate window.
                    </p>
                    <Button
                      onClick={() => window.open(portalUrl, '_blank')}
                      className="gap-2"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Open Portal in New Tab
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Assistant Tools */}
          <div className={`${hasPortalUrl && showPortal ? 'w-1/2' : 'w-full'} flex`}>
            <div className="w-1/2 border-r overflow-hidden flex flex-col">
              <div className="p-4 bg-slate-50 border-b">
                <h3 className="font-semibold text-slate-900">Profile Data Cheatsheet</h3>
                <p className="text-xs text-slate-500 mt-1">Click copy icons to copy values</p>
              </div>
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-2">
                  {profileFields.map((field, i) => (
                    <ProfileField key={i} {...field} onCopy={handleCopyToClipboard} />
                  ))}
                </div>
              </ScrollArea>
            </div>

            <div className="w-1/2 flex flex-col">
              <div className="p-4 bg-slate-50 border-b">
                <h3 className="font-semibold text-slate-900">AI Answer Generator</h3>
                <p className="text-xs text-slate-500 mt-1">Paste questions, get AI-generated answers</p>
              </div>
              
              <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
                <div className="space-y-2">
                  <Label htmlFor="portal-question">Paste a question from the portal</Label>
                  <Textarea
                    id="portal-question"
                    placeholder="e.g., 'In 500 words or less, describe your academic achievements and future goals...'"
                    value={portalQuestion}
                    onChange={(e) => setPortalQuestion(e.target.value)}
                    className="h-24"
                  />
                </div>
                
                <Button 
                  onClick={handleAskAI} 
                  disabled={isGenerating || !portalQuestion.trim()}
                  className="w-full"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Generate Answer
                    </>
                  )}
                </Button>
                
                <div className="flex-1 flex flex-col border rounded-lg overflow-hidden relative bg-slate-50">
                  {isGenerating && (
                    <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                      <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                    </div>
                  )}
                  <div className="p-3 bg-slate-100 border-b flex items-center justify-between">
                    <Label className="text-sm font-semibold">AI Generated Answer</Label>
                    {aiAnswer && (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={() => handleCopyToClipboard(aiAnswer)}
                        className="h-7 gap-1"
                      >
                        <Copy className="w-3 h-3" /> Copy
                      </Button>
                    )}
                  </div>
                  <ScrollArea className="flex-1 p-4">
                    {aiAnswer ? (
                      <p className="text-sm whitespace-pre-wrap">{aiAnswer}</p>
                    ) : (
                      <p className="text-sm text-slate-400 italic">Your generated answer will appear here...</p>
                    )}
                  </ScrollArea>
                </div>
                
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="p-4 border-t">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
