import { useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { isValidEmail } from '@/components/emails/emailGenerationHelpers';

/**
 * Hook for sending emails with proper error handling
 * Reusable across the application
 * 
 * @param {Function} onSuccess - Success callback
 * @returns {Object} Send function and state
 */
export function useSendEmail(onSuccess) {
  const { toast } = useToast();

  const sendMutation = useMutation({
    mutationFn: async ({ to, subject, body, fromName = 'Dr. John White' }) => {
      // Validate inputs
      if (!to || !isValidEmail(to)) {
        throw new Error('Invalid recipient email address');
      }
      
      if (!subject || subject.trim().length === 0) {
        throw new Error('Email subject is required');
      }
      
      if (!body || body.trim().length === 0) {
        throw new Error('Email body is required');
      }

      // Send email
      return await base44.integrations.Core.SendEmail({
        to,
        from_name: fromName,
        subject,
        body,
      });
    },
    onSuccess: (data, variables) => {
      toast({
        title: "Email Sent! 📧",
        description: `Status update sent to ${variables.to}`,
      });
      
      onSuccess?.();
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to Send",
        description: error.message || "Could not send email. Please try again.",
      });
    }
  });

  const send = (params) => {
    // Pre-validation
    if (!params.to || !params.subject || !params.body) {
      toast({
        variant: "destructive",
        title: "Missing Information",
        description: "Please fill in all fields before sending",
      });
      return;
    }

    sendMutation.mutate(params);
  };

  return {
    send,
    isSending: sendMutation.isPending,
  };
}