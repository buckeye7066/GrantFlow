
import React, { useState, useEffect, useRef } from 'react';
import client from '@/api/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Sparkles, Loader2, Mail } from 'lucide-react';
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function EmailComposer({ grant, organization, open, onClose }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => {
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (open && organization) {
      setSubject('');
      setBody('');
      setError(null);
    }
  }, [open, organization]);

  const handleGenerateDraft = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const prompt = `
        You are an expert grant writer's assistant. Generate a professional and friendly email draft to send to a client about a grant opportunity.

        CLIENT / ORGANIZATION: ${organization.name}
        GRANT TITLE: ${grant.title}
        FUNDER: ${grant.funder}
        UPCOMING DEADLINE: ${grant.deadline ? new Date(grant.deadline).toLocaleDateString() : 'Not specified'}
        CURRENT STATUS: ${grant.status}

        INSTRUCTIONS:
        1.  Create a clear and concise subject line.
        2.  Write a friendly and professional email body.
        3.  Start by referencing the grant opportunity.
        4.  Provide a brief update based on its current status (e.g., if "drafting", mention progress; if "submitted", confirm submission).
        5.  Clearly state the upcoming deadline as a call to action if applicable.
        6.  Keep the tone encouraging and supportive.
        7.  End the main body of the email with a clear next step (e.g., asking for required documents or scheduling a meeting).
        8.  IMPORTANT: Do NOT include any signature block or closing like "Best regards,". The user's email client will add this automatically.
        
        Return a JSON object with "subject" and "body" keys.
      `;

      const response = await client.integrations.Core.InvokeLLM({
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

      let emailBody = response.body;
      const closingPhrase = "Best regards,";
      const closingIndex = emailBody.lastIndexOf(closingPhrase);

      if (closingIndex !== -1) {
        emailBody = emailBody.substring(0, closingIndex).trim();
      }

      if (isMounted.current) {
        setSubject(response.subject);
        setBody(emailBody);
      }

    } catch (err) {
      if (isMounted.current) {
        setError(`Failed to generate AI draft: ${err.message}`);
      }
    } finally {
      if (isMounted.current) {
        setIsGenerating(false);
      }
    }
  };

  const mailtoHref = organization?.email 
    ? `mailto:${organization.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` 
    : '';

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>AI-Powered Email Composer</DialogTitle>
          <DialogDescription>
            Draft an update for {organization.name}, then open it in your default email client to send.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <div className="flex justify-end">
            <Button variant="outline" onClick={handleGenerateDraft} disabled={isGenerating}>
              {isGenerating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 mr-2" />
              )}
              Generate AI Draft
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="to-email-grant">To</Label>
            <Input
              id="to-email-grant"
              type="email"
              value={organization.email || ''}
              readOnly
              className="bg-slate-100"
              placeholder="No email saved for this profile"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="body">Body</Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Email content..."
              className="h-48"
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <a href={mailtoHref} target="_blank" rel="noopener noreferrer">
            <Button
              disabled={!organization.email || !subject || !body}
            >
              <Mail className="w-4 h-4 mr-2" />
              Open in Email Client
            </Button>
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
