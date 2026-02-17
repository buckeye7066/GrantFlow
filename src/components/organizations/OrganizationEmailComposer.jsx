
import React, { useState, useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { formatAddress } from '@/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Loader2, Wand2, Send } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { format } from 'date-fns';

export default function OrganizationEmailComposer({ open, onClose, organization, emails = [] }) {
    const { toast } = useToast();
    const [recipient, setRecipient] = useState('');
    const [subject, setSubject] = useState(`Grant Pipeline Update: ${organization.name}`);
    const [body, setBody] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);

    // Fetch grants for this organization
    const { data: grants = [] } = useQuery({
        queryKey: ['grants', organization.id],
        queryFn: () => base44.entities.Grant.filter({ organization_id: organization.id }),
        enabled: open && !!organization.id,
    });

    // Fetch contact methods
    const { data: contactMethods = [] } = useQuery({
        queryKey: ['contactMethods', organization.id],
        queryFn: () => base44.entities.ContactMethod.filter({ organization_id: organization.id }),
        enabled: open && !!organization.id,
    });

    // Set first email as default recipient
    useEffect(() => {
        if (emails.length > 0 && !recipient) {
            setRecipient(emails[0].value);
        }
    }, [emails]);

    const sendEmailMutation = useMutation({
        mutationFn: (emailData) => base44.integrations.Core.SendEmail(emailData),
        onSuccess: () => {
            toast({
                title: "Update Email Sent! 📧",
                description: `Status update sent to ${recipient}`
            });
            onClose();
        },
        onError: (error) => {
            toast({
                variant: "destructive",
                title: "Failed to Send",
                description: error.message || "Could not send email"
            });
        }
    });

    const generateEmailBody = async () => {
        setIsGenerating(true);
        
        // Build comprehensive profile summary
        const profileSummary = `
**PROFILE INFORMATION ON FILE**
Organization Name: ${organization.name}
${organization.applicant_type ? `Type: ${organization.applicant_type.replace(/_/g, ' ')}` : ''}
${organization.ein ? `EIN: ${organization.ein}` : ''}
${organization.uei ? `UEI: ${organization.uei}` : ''}
${organization.address || organization.city || organization.state ? `
Address: ${formatAddress(organization.address)}
${organization.city ? organization.city + ', ' : ''}${organization.state || ''} ${organization.zip || ''}` : ''}
${contactMethods.filter(c => c.type === 'email').length > 0 ? `Email: ${contactMethods.filter(c => c.type === 'email').map(c => c.value).join(', ')}` : ''}
${contactMethods.filter(c => c.type === 'phone').length > 0 ? `Phone: ${contactMethods.filter(c => c.type === 'phone').map(c => c.value).join(', ')}` : ''}
${organization.website ? `Website: ${organization.website}` : ''}
${organization.mission ? `\nMission: ${organization.mission}` : ''}
${organization.annual_budget ? `Annual Budget: $${organization.annual_budget.toLocaleString()}` : ''}
${organization.staff_count ? `Staff Count: ${organization.staff_count}` : ''}
        `.trim();

        // Build pipeline summary with proper date validation
        const pipelineSummary = grants.length > 0 ? grants.map(grant => {
            const statusLabels = {
                discovered: 'Recently Discovered',
                interested: 'Under Assessment',
                drafting: 'Application in Progress',
                application_prep: 'Ready for Submission',
                portal: 'Portal Entry in Progress',
                submitted: 'Submitted - Awaiting Decision',
                pending_review: 'Under Review',
                follow_up: 'Follow-Up Required',
                awarded: '✅ AWARDED',
                declined: 'Declined',
                closed: 'Closed',
                report: 'Reporting Phase'
            };
            
            // FIX: Validate deadline before formatting
            let deadlineText = '';
            if (grant.deadline) {
                if (typeof grant.deadline === 'string' && grant.deadline.toLowerCase() === 'rolling') {
                    deadlineText = 'Deadline: Rolling';
                } else {
                    const deadlineDate = new Date(grant.deadline);
                    if (!isNaN(deadlineDate.getTime())) {
                        deadlineText = `Deadline: ${format(deadlineDate, 'MMM d, yyyy')}`;
                    }
                }
            }
            
            return `
• ${grant.title}
  Funder: ${grant.funder}
  Status: ${statusLabels[grant.status] || grant.status}
  ${deadlineText}
  ${grant.amount_max ? `Award Amount: Up to $${grant.amount_max.toLocaleString()}` : ''}
            `.trim();
        }).join('\n\n') : 'No grants currently in the pipeline.';

        const prompt = `You are Dr. John White, a professional grant consultant. Write a warm, professional email to ${organization.name} providing a status update on their grant-seeking efforts.

**CONTEXT:**

${profileSummary}

**CURRENT GRANT PIPELINE:**

${pipelineSummary}

**EMAIL REQUIREMENTS:**
- Start with a friendly greeting
- Provide a brief summary of their current pipeline activity
- List each grant opportunity with its current status
- Reference the profile information you have on file
- Ask them to review everything and reply with any updates, corrections, or additions
- Emphasize that keeping information current helps find the best opportunities
- Keep the tone encouraging and supportive
- Sign as "Dr. John White, Grant Consultant"
- Keep under 300 words

Write the complete email body in plain text (no HTML):`;

        try {
            const response = await base44.integrations.Core.InvokeLLM({ prompt });
            setBody(response);
            toast({
                title: "Status Update Generated! ✨",
                description: "Review and edit before sending"
            });
        } catch (error) {
            console.error("Failed to generate email:", error);
            toast({
                variant: "destructive",
                title: "Generation Failed",
                description: "Could not generate email. Please write one manually."
            });
        } finally {
            setIsGenerating(false);
        }
    };

    const handleSend = () => {
        if (!recipient || !subject || !body) {
            toast({
                variant: "destructive",
                title: "Missing Information",
                description: "Please fill in all fields before sending"
            });
            return;
        }

        sendEmailMutation.mutate({
            to: recipient,
            from_name: "Dr. John White",
            subject: subject,
            body: body,
        });
    };

    return (
        <Dialog open={open} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Send Pipeline Update to {organization.name}</DialogTitle>
                    <DialogDescription>
                        Share current grant pipeline status and request profile updates
                    </DialogDescription>
                </DialogHeader>
                
                <div className="space-y-4 py-4">
                    {/* Pipeline Preview */}
                    <div className="bg-slate-50 p-4 rounded-lg border">
                        <h4 className="font-semibold text-sm text-slate-900 mb-2">Current Pipeline Summary</h4>
                        <p className="text-sm text-slate-600">
                            <strong>{grants.length}</strong> {grants.length === 1 ? 'grant' : 'grants'} in pipeline
                        </p>
                        {grants.length > 0 && (
                            <ul className="mt-2 space-y-1 text-xs text-slate-600">
                                {grants.slice(0, 3).map(grant => (
                                    <li key={grant.id}>• {grant.title} - {grant.status}</li>
                                ))}
                                {grants.length > 3 && (
                                    <li className="text-slate-500">... and {grants.length - 3} more</li>
                                )}
                            </ul>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="recipient">Recipient</Label>
                        <Select value={recipient} onValueChange={setRecipient}>
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
                    
                    <div className="space-y-2">
                        <Label htmlFor="subject">Subject</Label>
                        <Input 
                            id="subject" 
                            value={subject} 
                            onChange={(e) => setSubject(e.target.value)} 
                        />
                    </div>
                    
                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <Label htmlFor="body">Message</Label>
                            <Button 
                                variant="ghost" 
                                size="sm" 
                                onClick={generateEmailBody} 
                                disabled={isGenerating || sendEmailMutation.isPending}
                            >
                                {isGenerating ? (
                                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</>
                                ) : (
                                    <><Wand2 className="w-4 h-4 mr-2" />Generate Update</>
                                )}
                            </Button>
                        </div>
                        <Textarea 
                            id="body" 
                            value={body} 
                            onChange={(e) => setBody(e.target.value)} 
                            className="h-64 font-mono text-sm" 
                            placeholder="Click 'Generate Update' to create a status email..."
                        />
                        <p className="text-xs text-slate-500">
                            💡 Tip: The AI will include all pipeline grants, profile info, and request for updates
                        </p>
                    </div>
                </div>
                
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={sendEmailMutation.isPending}>
                        Cancel
                    </Button>
                    <Button 
                        onClick={handleSend} 
                        disabled={sendEmailMutation.isPending || !recipient || !subject || !body}
                        className="bg-blue-600 hover:bg-blue-700"
                    >
                        {sendEmailMutation.isPending ? (
                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending...</>
                        ) : (
                            <><Send className="w-4 h-4 mr-2" />Send Update</>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
