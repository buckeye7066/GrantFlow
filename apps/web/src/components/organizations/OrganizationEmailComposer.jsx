import React, { useMemo, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Send } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

// Custom hooks
import { useOrganizationEmailData } from '@/components/hooks/useOrganizationEmailData';
import { useEmailComposerState } from '@/components/hooks/useEmailComposerState';
import { useGeneratePipelineEmail } from '@/components/hooks/useGeneratePipelineEmail';
import { useSendEmail } from '@/components/hooks/useSendEmail';

// Components
import PipelinePreview from '@/components/emails/PipelinePreview';
import EmailComposerBody from '@/components/emails/EmailComposerBody';

/**
 * OrganizationEmailComposer - Dialog for composing and sending pipeline updates
 * 
 * Refactored for:
 * - Clear separation of concerns (data, state, generation, sending)
 * - Reusable hooks for email operations
 * - Better testability and maintainability
 * - Performance optimizations with memoization
 * 
 * @param {boolean} open - Dialog open state
 * @param {Function} onClose - Close handler
 * @param {Object} organization - Organization data
 * @param {Array} emails - Deprecated - now fetched internally
 */
export default function OrganizationEmailComposer({ 
  open, 
  onClose, 
  organization, 
  emails: deprecatedEmails = [] // Keep for backwards compatibility
}) {
  // Fetch email-related data
  const { 
    grants, 
    contactMethods, 
    emails, 
    isLoading 
  } = useOrganizationEmailData(organization?.id, open);

  // Manage form state
  const {
    recipient,
    setRecipient,
    subject,
    setSubject,
    body,
    setBody,
    isValid,
  } = useEmailComposerState(organization, emails.length > 0 ? emails : deprecatedEmails, '', grants);

  // Email generation
  const { generate, isGenerating } = useGeneratePipelineEmail();

  // Email sending
  const { send, isSending } = useSendEmail(onClose);

  // Handle generation
  const handleGenerate = async () => {
    const result = await generate({
      organization,
      grants,
      contactMethods,
    });

    if (result.body) {
      setBody(result.body);
    }
  };

  // Handle send
  const handleSend = () => {
    send({
      to: recipient,
      subject,
      body,
      fromName: 'Dr. John White',
    });
  };

  // Memoized available emails
  const availableEmails = useMemo(() => {
    return emails.length > 0 ? emails : deprecatedEmails;
  }, [emails, deprecatedEmails]);

  // Prefill recipient if exactly one email and none selected yet
  useEffect(() => {
    if (open && availableEmails.length === 1 && !recipient) {
      setRecipient(availableEmails[0]);
    }
  }, [open, availableEmails, recipient, setRecipient]);

  const noEmails = availableEmails.length === 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Send Pipeline Update to {organization?.name}
          </DialogTitle>
          <DialogDescription>
            Share current grant pipeline status and request profile updates
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          </div>
        ) : (
          <>
            {/* Pipeline Preview */}
            <PipelinePreview grants={grants} limit={3} />

            {noEmails && (
              <Alert className="mb-3">
                <AlertDescription>
                  No email addresses on file for this profile. Add an email to send updates.
                </AlertDescription>
              </Alert>
            )}

            {/* Email Form */}
            <EmailComposerBody
              emails={availableEmails}
              recipient={recipient}
              onRecipientChange={setRecipient}
              subject={subject}
              onSubjectChange={setSubject}
              body={body}
              onBodyChange={setBody}
              onGenerate={handleGenerate}
              isGenerating={isGenerating}
              isSending={isSending}
            />
          </>
        )}

        <DialogFooter>
          <Button 
            variant="outline" 
            onClick={onClose} 
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={isSending || !isValid || isGenerating || noEmails}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Send Update
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}