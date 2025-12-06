import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Loader2, Mail, Copy, Save, AlertCircle, CheckCircle } from 'lucide-react';
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from '@/components/ui/use-toast';
import { formatISO } from 'date-fns';

/**
 * EmailComposer - AI-powered email draft generator for grant updates
 * 
 * Features:
 * - AI-generated subject and body based on grant and organization data
 * - Editable recipient email address
 * - Character count with warning for long emails
 * - Copy to clipboard functionality
 * - Save draft to localStorage
 * - Status-aware prompt generation
 * - AI disclaimer for transparency
 * - Telemetry logging
 */
export default function EmailComposer({ grant, organization, open, onClose }) {
  const [recipientEmail, setRecipientEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const { toast } = useToast();

  // Initialize recipient email from organization
  useEffect(() => {
    if (open && organization) {
      setRecipientEmail(organization.email || '');
      setSubject('');
      setBody('');
      setError(null);
      setCopySuccess(false);
    }
  }, [open, organization]);

  /**
   * Generate status-specific instructions for the AI prompt
   */
  const getStatusInstructions = (status) => {
    switch (status) {
      case 'discovered':
        return 'This opportunity was recently discovered. Introduce it and gauge their interest.';
      case 'interested':
        return 'The client has expressed interest. Outline next steps to start the application.';
      case 'drafting':
        return 'The application is in progress. Provide a progress update and mention any upcoming needs.';
      case 'portal':
      case 'application_prep':
        return 'We are preparing the application portal submission. Confirm any final details needed.';
      case 'submitted':
        return 'The application has been submitted. Confirm the submission date and mention next steps (e.g., waiting for decision).';
      case 'awarded':
        return 'Congratulations! The grant was awarded. Mention next steps for award acceptance and reporting.';
      case 'declined':
        return 'Unfortunately, this application was not successful. Offer encouragement and discuss alternative opportunities.';
      default:
        return 'Provide an update on the current status of this opportunity.';
    }
  };

  /**
   * Generate AI draft email
   */
  const handleGenerateDraft = async () => {
    setIsGenerating(true);
    setError(null);

    try {
      // Parse deadline to ISO format for better AI reasoning
      const deadlineISO = grant.deadline 
        ? formatISO(new Date(grant.deadline), { representation: 'date' })
        : null;

      const statusInstructions = getStatusInstructions(grant.status);

      const prompt = `
You are an expert grant writer's assistant. Generate a professional, friendly, and concise email draft to send to a client about a grant opportunity.

CLIENT / ORGANIZATION: ${organization.name}
GRANT TITLE: ${grant.title}
FUNDER: ${grant.funder}
${grant.funder_type ? `FUNDER TYPE: ${grant.funder_type}` : ''}
DEADLINE: ${deadlineISO || 'Not specified'}
CURRENT STATUS: ${grant.status}
${grant.award_floor || grant.award_ceiling ? `AWARD RANGE: $${grant.award_floor || 0} - $${grant.award_ceiling || 'Not specified'}` : ''}

${grant.program_description ? `PROGRAM SUMMARY:\n${grant.program_description.substring(0, 500)}${grant.program_description.length > 500 ? '...' : ''}` : ''}

${grant.eligibility_summary ? `ELIGIBILITY NOTES:\n${grant.eligibility_summary.substring(0, 300)}${grant.eligibility_summary.length > 300 ? '...' : ''}` : ''}

STATUS-SPECIFIC INSTRUCTIONS:
${statusInstructions}

GENERAL INSTRUCTIONS:
1. Create a clear, professional subject line (max 10 words)
2. Write a warm opening that references the specific grant opportunity
3. Provide a brief update based on the current status
4. If there's a deadline, clearly state it as a call to action
5. Mention 1-2 key benefits or highlights of this opportunity if relevant
6. End with a clear next step (e.g., "Please reply with any questions" or "Let's schedule a call to discuss")
7. Keep the total email under 250 words
8. Use a friendly but professional tone
9. CRITICAL: Do NOT include any signature block, closing phrase (like "Best regards"), or sender name. The email client will add this automatically.
10. CRITICAL: Do NOT use placeholder text like [Organization Name]. Use the actual names provided.

Return a JSON object with "subject" and "body" keys.
      `.trim();

      const response = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["subject", "body"],
        },
      });

      // Validate response
      if (!response.subject || !response.body) {
        throw new Error('AI response missing required fields');
      }

      // Auto-trim whitespace and remove any signature blocks
      let cleanBody = response.body.trim();
      
      // Remove common closing phrases that might slip through
      const closingPatterns = [
        /Best regards,?[\s\S]*$/i,
        /Sincerely,?[\s\S]*$/i,
        /Warm regards,?[\s\S]*$/i,
        /Kind regards,?[\s\S]*$/i,
        /Thanks,?[\s\S]*$/i,
        /Cheers,?[\s\S]*$/i,
      ];

      closingPatterns.forEach(pattern => {
        cleanBody = cleanBody.replace(pattern, '').trim();
      });

      setSubject(response.subject.trim());
      setBody(cleanBody);

      // Log telemetry event
      try {
        await base44.integrations.Core.InvokeLLM({
          prompt: `Log telemetry event: email_draft_generated for grant ${grant.id}`,
          response_json_schema: { type: "object", properties: {} }
        });
      } catch (telemetryError) {
        console.warn('[EmailComposer] Telemetry logging failed:', telemetryError);
      }

      toast({
        title: '✅ Draft Generated',
        description: 'AI has created your email draft. Please review before sending.',
      });

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
      setError(`Failed to generate AI draft: ${errorMessage}`);
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: errorMessage,
      });
    } finally {
      setIsGenerating(false);
    }
  };

  /**
   * Copy email content to clipboard
   */
  const handleCopyToClipboard = async () => {
    const fullEmail = `To: ${recipientEmail}\nSubject: ${subject}\n\n${body}`;
    
    try {
      await navigator.clipboard.writeText(fullEmail);
      setCopySuccess(true);
      toast({
        title: 'Copied to Clipboard',
        description: 'Email draft copied successfully.',
      });
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Copy Failed',
        description: 'Could not copy to clipboard.',
      });
    }
  };

  /**
   * Save draft to localStorage
   */
  const handleSaveDraft = () => {
    const draftKey = `email_draft_${grant.id}_${Date.now()}`;
    const draftData = {
      grantId: grant.id,
      grantTitle: grant.title,
      organizationId: organization.id,
      organizationName: organization.name,
      recipientEmail,
      subject,
      body,
      savedAt: new Date().toISOString(),
    };

    try {
      localStorage.setItem(draftKey, JSON.stringify(draftData));
      toast({
        title: 'Draft Saved',
        description: 'Email draft saved to browser storage.',
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Save Failed',
        description: 'Could not save draft to browser storage.',
      });
    }
  };

  // Character count
  const bodyCharCount = body.length;
  const isBodyTooLong = bodyCharCount > 2000;

  // Build mailto link
  const mailtoHref = recipientEmail 
    ? `mailto:${recipientEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` 
    : '';

  const canSend = recipientEmail && subject && body && !isBodyTooLong;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-600" />
            AI-Powered Email Composer
          </DialogTitle>
          <DialogDescription>
            Draft an update for <strong>{organization.name}</strong> about "{grant.title}"
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {/* AI Disclaimer */}
          <Alert className="bg-purple-50 border-purple-200">
            <AlertCircle className="h-4 w-4 text-purple-600" />
            <AlertDescription className="text-purple-900 text-xs">
              <strong>AI-Generated Content:</strong> This draft is created by AI and should be carefully reviewed before sending. 
              Verify all details for accuracy.
            </AlertDescription>
          </Alert>

          {/* Generate Button */}
          <div className="flex justify-between items-center">
            <div className="text-sm text-slate-600">
              Click to generate a draft based on the grant's current status
            </div>
            <Button 
              variant="outline" 
              onClick={handleGenerateDraft} 
              disabled={isGenerating}
              className="bg-purple-50 hover:bg-purple-100 border-purple-200"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Generate AI Draft
                </>
              )}
            </Button>
          </div>

          {/* Recipient Email (Editable) */}
          <div className="space-y-2">
            <Label htmlFor="to-email-grant">
              To <span className="text-red-500">*</span>
            </Label>
            <Input
              id="to-email-grant"
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="recipient@example.com"
              className={!recipientEmail ? 'border-amber-300 bg-amber-50' : ''}
            />
            {!recipientEmail && (
              <p className="text-xs text-amber-700">
                ⚠️ No email address saved for this profile. Please enter one to proceed.
              </p>
            )}
          </div>

          {/* Subject */}
          <div className="space-y-2">
            <Label htmlFor="subject">
              Subject <span className="text-red-500">*</span>
            </Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject line"
            />
          </div>

          {/* Body */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="body">
                Body <span className="text-red-500">*</span>
              </Label>
              <Badge 
                variant={isBodyTooLong ? 'destructive' : bodyCharCount > 1500 ? 'outline' : 'secondary'}
                className="text-xs"
              >
                {bodyCharCount.toLocaleString()} chars
                {isBodyTooLong && ' (too long!)'}
              </Badge>
            </div>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Email content will appear here after generation..."
              className="h-64 font-mono text-sm"
            />
            {isBodyTooLong && (
              <p className="text-xs text-red-600">
                ⚠️ Email is too long ({bodyCharCount} chars). Most email clients work best with under 2,000 characters. Please shorten the message.
              </p>
            )}
          </div>

          {/* Error Display */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        {/* Footer Actions */}
        <DialogFooter className="flex flex-col sm:flex-row gap-2">
          <div className="flex gap-2 flex-1">
            <Button 
              variant="outline" 
              onClick={handleCopyToClipboard}
              disabled={!subject || !body}
              className="flex-1"
            >
              {copySuccess ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-2" />
                  Copy
                </>
              )}
            </Button>
            <Button 
              variant="outline" 
              onClick={handleSaveDraft}
              disabled={!subject || !body}
              className="flex-1"
            >
              <Save className="w-4 h-4 mr-2" />
              Save Draft
            </Button>
          </div>
          
          <div className="flex gap-2 flex-1 sm:flex-initial">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <a 
              href={mailtoHref} 
              target="_blank" 
              rel="noopener noreferrer"
              className={!canSend ? 'pointer-events-none opacity-50' : ''}
            >
              <Button
                disabled={!canSend}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Mail className="w-4 h-4 mr-2" />
                Open in Email
              </Button>
            </a>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}