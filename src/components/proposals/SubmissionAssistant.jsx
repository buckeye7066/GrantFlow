
import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { 
  Loader2, 
  CheckCircle, 
  Send, 
  Download, 
  AlertTriangle,
  Mail,
  Sparkles,
  MapPin,
  Phone,
  Printer,
  FileText
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { createLogger } from '@/utils/logger';

export default function SubmissionAssistant({ open, onClose, grant, organization }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const log = React.useMemo(() => createLogger('SubmissionAssistant'), []);
  
  const [submissionMethod, setSubmissionMethod] = useState('email');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [recipientFax, setRecipientFax] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [coverLetter, setCoverLetter] = useState('');
  const [isGeneratingLetter, setIsGeneratingLetter] = useState(false);
  const [isFindingContact, setIsFindingContact] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // Fetch proposal sections
  const { data: sections = [] } = useQuery({
    queryKey: ['proposalSections', grant?.id],
    queryFn: () => base44.entities.ProposalSection.filter({ grant_id: grant.id }, 'section_order'),
    enabled: !!grant?.id && open,
  });

  // Auto-populate from grant data on mount
  useEffect(() => {
    if (grant) {
      if (grant.funder_email) setRecipientEmail(grant.funder_email);
      if (grant.funder_phone) setRecipientPhone(grant.funder_phone);
      if (grant.funder_fax) setRecipientFax(grant.funder_fax);
      if (grant.funder_address) setRecipientAddress(grant.funder_address);
    }
  }, [grant]);

  // Generate cover letter on mount
  useEffect(() => {
    if (open && !coverLetter) {
      generateCoverLetter();
    }
  }, [open]);

  const generateCoverLetter = async () => {
    setIsGeneratingLetter(true);
    try {
      // Determine if this is an individual or organization
      const isIndividual = ['high_school_student', 'college_student', 'graduate_student', 'individual_need', 'medical_assistance', 'family', 'other'].includes(organization.applicant_type);
      
      const voiceGuidance = isIndividual 
        ? 'Write in FIRST PERSON SINGULAR (I, my, me). This is an individual applicant, NOT an organization.'
        : 'Write in FIRST PERSON PLURAL (we, our, us). This is an organization.';

      const prompt = `Write a professional cover letter for this grant application submission:

${isIndividual ? 'Individual Applicant' : 'Organization'}: ${organization.name}
Grant: ${grant.title}
Funder: ${grant.funder}

CRITICAL: ${voiceGuidance}

The letter should:
1. Express gratitude for the opportunity
2. Briefly state the purpose of the application (1-2 sentences)
3. Mention key qualifications ${isIndividual ? 'or achievements' : ''}
4. Express enthusiasm and availability for questions
5. Be formal but warm
6. Be concise (under 150 words)

${isIndividual ? `
Examples of proper first-person singular:
- "I am writing to express..."
- "I am currently pursuing..."
- "My dedication to..."
- "I am eager to..."
- "Thank you for considering my application."
` : `
Examples of proper first-person plural:
- "We are writing to express..."
- "We are dedicated to..."
- "Our organization has..."
- "We are eager to..."
- "Thank you for considering our application."
`}

Keep it professional and submission-ready.`;

      const response = await base44.integrations.Core.InvokeLLM({ prompt });
      setCoverLetter(response);
    } catch (error) {
      console.error('Failed to generate cover letter:', error);
      
      // Fallback letter with proper voice
      const isIndividual = ['high_school_student', 'college_student', 'graduate_student', 'individual_need', 'medical_assistance', 'family', 'other'].includes(organization.applicant_type);
      
      if (isIndividual) {
        setCoverLetter(`Dear Grant Committee,

I am pleased to submit this application for ${grant.title}. I believe my background and goals align closely with your mission.

Thank you for your consideration. I am available to answer any questions I may have.

Sincerely,
${organization.name}`);
      } else {
        setCoverLetter(`Dear Grant Committee,

${organization.name} is pleased to submit this application for ${grant.title}. We believe our work aligns closely with your mission and goals.

Thank you for your consideration. We are available to answer any questions you may have.

Sincerely,
${organization.name}`);
      }
    } finally {
      setIsGeneratingLetter(false);
    }
  };

  const handleFindContactInfo = async () => {
    setIsFindingContact(true);
    
    try {
      const prompt = `Find CURRENT contact information for submitting grant applications to the following funder: "${grant.funder}"

${grant.url ? `Their website/portal is: ${grant.url}` : ''}

Search the internet thoroughly and provide the following contact information in JSON format:
{
  "email": "their grants/contact email address for SUBMISSIONS (not general info)",
  "phone": "their phone number",
  "fax": "their fax number if available",
  "address": "their physical mailing address for grant submissions"
}

CRITICAL: Find the SUBMISSION-SPECIFIC contact info, not just general contact information.
Look for pages like "How to Apply", "Contact for Grant Inquiries", etc.

Return ONLY the JSON object. If you cannot find a specific piece of information, use null for that field.`;

      const response = await base44.integrations.Core.InvokeLLM({
        prompt,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          properties: {
            email: { type: ["string", "null"] },
            phone: { type: ["string", "null"] },
            fax: { type: ["string", "null"] },
            address: { type: ["string", "null"] }
          }
        }
      });

      log.debug('AI contact response', response);

      // Update form fields with AI results
      if (response.email && !recipientEmail) setRecipientEmail(response.email);
      if (response.phone && !recipientPhone) setRecipientPhone(response.phone);
      if (response.fax && !recipientFax) setRecipientFax(response.fax);
      if (response.address && !recipientAddress) setRecipientAddress(response.address);

      const foundCount = [response.email, response.phone, response.fax, response.address].filter(Boolean).length;
      
      if (foundCount > 0) {
        toast({
          title: 'Contact Info Found! ✨',
          description: `Found ${foundCount} contact detail(s). Review and edit as needed.`
        });
        
        // Save to grant for future use
        if (response.email || response.phone || response.fax || response.address) {
          const updates = {};
          if (response.email) updates.funder_email = response.email;
          if (response.phone) updates.funder_phone = response.phone;
          if (response.fax) updates.funder_fax = response.fax;
          if (response.address) updates.funder_address = response.address;
          
          await base44.entities.Grant.update(grant.id, updates);
          queryClient.invalidateQueries({ queryKey: ['grant', grant.id] });
        }
      } else {
        toast({
          title: 'No Contact Info Found',
          description: 'AI could not find submission contact information. Please enter manually.',
          variant: 'destructive'
        });
      }

    } catch (error) {
      console.error('[SubmissionAssistant] AI contact search failed:', error);
      toast({
        variant: 'destructive',
        title: 'AI Search Failed',
        description: error.message || 'Could not find contact information'
      });
    } finally {
      setIsFindingContact(false);
    }
  };

  const handleDownloadDocument = async () => {
    setIsDownloading(true);
    
    try {
      const today = new Date();
      const formattedDate = today.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      
      // Get primary email and phone
      const primaryEmail = Array.isArray(organization.email) && organization.email.length > 0 
        ? organization.email[0] 
        : organization.email || '';
      const primaryPhone = Array.isArray(organization.phone) && organization.phone.length > 0 
        ? organization.phone[0] 
        : organization.phone || '';
      
      const cityStateZip = [organization.city, organization.state, organization.zip]
        .filter(Boolean)
        .join(', ');

      // FIXED: Use grant award amount, not organization funding need
      const awardAmount = grant.award_ceiling || grant.award_floor || grant.typical_award;
      const formattedAwardAmount = awardAmount ? `$${awardAmount.toLocaleString()}` : 'Not specified';

      // Build HTML document (Word can open HTML as .doc)
      let htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${grant.title} - Application</title>
  <style>
    body {
      font-family: 'Times New Roman', Times, serif;
      font-size: 12pt;
      line-height: 1.6;
      margin: 1in;
      color: #000;
    }
    h1 {
      font-size: 16pt;
      font-weight: bold;
      text-align: center;
      margin-bottom: 24pt;
      text-transform: uppercase;
      border-bottom: 2px solid #000;
      padding-bottom: 12pt;
    }
    h2 {
      font-size: 14pt;
      font-weight: bold;
      margin-top: 24pt;
      margin-bottom: 12pt;
      text-transform: uppercase;
      border-bottom: 1px solid #000;
      padding-bottom: 6pt;
    }
    h3 {
      font-size: 12pt;
      font-weight: bold;
      margin-top: 18pt;
      margin-bottom: 6pt;
    }
    p {
      margin: 0 0 12pt 0;
      text-align: justify;
    }
    .header-block {
      text-align: center;
      margin-bottom: 36pt;
      border: 2px solid #000;
      padding: 18pt;
    }
    .letterhead {
      margin-bottom: 24pt;
    }
    .signature-block {
      margin-top: 36pt;
    }
    .page-break {
      page-break-after: always;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12pt 0;
    }
    td {
      padding: 6pt;
      vertical-align: top;
    }
    .label {
      font-weight: bold;
      width: 200px;
    }
    ul {
      margin: 12pt 0;
      padding-left: 24pt;
    }
    li {
      margin-bottom: 6pt;
    }
  </style>
</head>
<body>

  <!-- TITLE PAGE -->
  <div class="header-block">
    <h1>${grant.title}</h1>
    <p style="font-size: 14pt; margin: 12pt 0;"><strong>APPLICATION FOR: ${organization.name.toUpperCase()}</strong></p>
    <p style="font-size: 12pt;"><strong>SUBMITTED TO: ${grant.funder.toUpperCase()}</strong></p>
    <p style="font-size: 12pt;"><strong>DATE: ${formattedDate}</strong></p>
  </div>

  <div class="page-break"></div>

  <!-- COVER LETTER -->
  ${coverLetter ? `
  <h2>Cover Letter</h2>
  
  <div class="letterhead">
    <p><strong>${organization.name}</strong><br>
    ${organization.address ? `${organization.address}<br>` : ''}
    ${cityStateZip ? `${cityStateZip}<br>` : ''}
    ${primaryEmail ? `${primaryEmail}<br>` : ''}
    ${primaryPhone ? `${primaryPhone}<br>` : ''}
    ${organization.website ? `${organization.website}` : ''}</p>
    
    <p style="margin-top: 24pt;">${formattedDate}</p>
    
    <p style="margin-top: 24pt;">Review Committee<br>
    ${grant.funder}<br>
    ${recipientAddress ? recipientAddress.split('\n').join('<br>') : ''}</p>
  </div>
  
  <p style="margin-top: 24pt;">Dear Review Committee,</p>
  
  <p>${coverLetter.replace(/^Dear.*?,?\n*/i, '').replace(/\n/g, '</p><p>')}</p>
  
  <div class="signature-block">
    <p>Sincerely,</p>
    <p style="margin-top: 48pt;"><strong>${organization.name}</strong><br>
    ${primaryEmail ? `Email: ${primaryEmail}<br>` : ''}
    ${primaryPhone ? `Phone: ${primaryPhone}` : ''}</p>
  </div>
  
  <div class="page-break"></div>
  ` : ''}

  <!-- TABLE OF CONTENTS -->
  ${sections.length > 0 ? `
  <h2>Table of Contents</h2>
  <ul>
    ${sections.sort((a, b) => a.section_order - b.section_order).map((section, index) => 
      `<li>${index + 1}. ${section.section_name}</li>`
    ).join('')}
  </ul>
  <div class="page-break"></div>
  ` : ''}

  <!-- EXECUTIVE SUMMARY -->
  <h2>Executive Summary</h2>
  <table>
    <tr>
      <td class="label">Applicant:</td>
      <td>${organization.name}</td>
    </tr>
    <tr>
      <td class="label">Program:</td>
      <td>${grant.title}</td>
    </tr>
    <tr>
      <td class="label">Funder:</td>
      <td>${grant.funder}</td>
    </tr>
    ${awardAmount ? `
    <tr>
      <td class="label">Award Amount:</td>
      <td>${formattedAwardAmount}</td>
    </tr>
    ` : ''}
    ${grant.deadline ? `
    <tr>
      <td class="label">Deadline:</td>
      <td>${new Date(grant.deadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
    </tr>
    ` : ''}
  </table>
  
  ${organization.mission ? `
  <h3>Mission Statement</h3>
  <p>${organization.mission.replace(/\n/g, '</p><p>')}</p>
  ` : ''}
  
  ${organization.primary_goal ? `
  <h3>Primary Goal</h3>
  <p>${organization.primary_goal.replace(/\n/g, '</p><p>')}</p>
  ` : ''}
  
  <div class="page-break"></div>

  <!-- PROPOSAL SECTIONS -->
  ${sections.sort((a, b) => a.section_order - b.section_order).map(section => `
    <h2>${section.section_name}</h2>
    ${section.requirements ? `<p style="font-style: italic; color: #666;">[Requirements: ${section.requirements}]</p>` : ''}
    <p>${section.draft_content ? section.draft_content.replace(/\n/g, '</p><p>') : '[This section has not been completed yet]'}</p>
    <div class="page-break"></div>
  `).join('')}

  <!-- APPLICANT INFORMATION -->
  <h2>Applicant Information</h2>
  <table>
    <tr>
      <td class="label">Legal Name:</td>
      <td>${organization.name}</td>
    </tr>
    ${organization.ein ? `
    <tr>
      <td class="label">EIN:</td>
      <td>${organization.ein}</td>
    </tr>
    ` : ''}
    ${organization.uei ? `
    <tr>
      <td class="label">UEI:</td>
      <td>${organization.uei}</td>
    </tr>
    ` : ''}
    <tr>
      <td class="label">Applicant Type:</td>
      <td>${organization.applicant_type?.replace(/_/g, ' ') || 'N/A'}</td>
    </tr>
    ${organization.address || cityStateZip ? `
    <tr>
      <td class="label">Address:</td>
      <td>
        ${organization.address ? `${organization.address}<br>` : ''}
        ${cityStateZip}
      </td>
    </tr>
    ` : ''}
    ${primaryEmail ? `
    <tr>
      <td class="label">Email:</td>
      <td>${primaryEmail}</td>
    </tr>
    ` : ''}
    ${primaryPhone ? `
    <tr>
      <td class="label">Phone:</td>
      <td>${primaryPhone}</td>
    </tr>
    ` : ''}
    ${organization.website ? `
    <tr>
      <td class="label">Website:</td>
      <td>${organization.website}</td>
    </tr>
    ` : ''}
  </table>

  <!-- STUDENT-SPECIFIC INFO -->
  ${['high_school_student', 'college_student', 'graduate_student'].includes(organization.applicant_type) ? `
  <h3>Academic Information</h3>
  <table>
    ${organization.student_grade_levels?.length ? `
    <tr>
      <td class="label">Grade Level(s):</td>
      <td>${organization.student_grade_levels.join(', ').replace(/_/g, ' ')}</td>
    </tr>
    ` : ''}
    ${organization.gpa ? `
    <tr>
      <td class="label">GPA:</td>
      <td>${organization.gpa}</td>
    </tr>
    ` : ''}
    ${organization.act_score ? `
    <tr>
      <td class="label">ACT Score:</td>
      <td>${organization.act_score}</td>
    </tr>
    ` : ''}
    ${organization.sat_score ? `
    <tr>
      <td class="label">SAT Score:</td>
      <td>${organization.sat_score}</td>
    </tr>
    ` : ''}
    ${organization.intended_major ? `
    <tr>
      <td class="label">Intended Major:</td>
      <td>${organization.intended_major}</td>
    </tr>
    ` : ''}
    ${organization.first_generation ? `
    <tr>
      <td class="label">First-Generation:</td>
      <td>Yes</td>
    </tr>
    ` : ''}
    ${organization.community_service_hours ? `
    <tr>
      <td class="label">Community Service:</td>
      <td>${organization.community_service_hours} hours</td>
    </tr>
    ` : ''}
  </table>
  ` : ''}

  <!-- ORGANIZATION-SPECIFIC INFO -->
  ${organization.applicant_type === 'organization' ? `
  <h3>Organization Details</h3>
  <table>
    ${organization.nonprofit_type ? `
    <tr>
      <td class="label">Organization Type:</td>
      <td>${organization.nonprofit_type}</td>
    </tr>
    ` : ''}
    ${organization.annual_budget ? `
    <tr>
      <td class="label">Annual Budget:</td>
      <td>$${organization.annual_budget.toLocaleString()}</td>
    </tr>
    ` : ''}
    ${organization.staff_count ? `
    <tr>
      <td class="label">Staff Count:</td>
      <td>${organization.staff_count}</td>
    </tr>
    ` : ''}
    ${organization.sam_registered ? `
    <tr>
      <td class="label">SAM.gov Registered:</td>
      <td>Yes</td>
    </tr>
    ` : ''}
    ${organization.faith_based ? `
    <tr>
      <td class="label">Faith-Based:</td>
      <td>Yes</td>
    </tr>
    ` : ''}
  </table>
  ` : ''}

  <!-- SUBMISSION INFORMATION -->
  <div class="page-break"></div>
  <h2>Submission Information</h2>
  <table>
    <tr>
      <td class="label">Submission Date:</td>
      <td>${formattedDate}</td>
    </tr>
    <tr>
      <td class="label">Submission Method:</td>
      <td>Self-Upload (Downloaded Document)</td>
    </tr>
    ${recipientEmail ? `
    <tr>
      <td class="label">Funder Email:</td>
      <td>${recipientEmail}</td>
    </tr>
    ` : ''}
    ${recipientPhone ? `
    <tr>
      <td class="label">Funder Phone:</td>
      <td>${recipientPhone}</td>
    </tr>
    ` : ''}
    ${recipientFax ? `
    <tr>
      <td class="label">Funder Fax:</td>
      <td>${recipientFax}</td>
    </tr>
    ` : ''}
    ${recipientAddress ? `
    <tr>
      <td class="label">Funder Address:</td>
      <td>${recipientAddress.split('\n').join('<br>')}</td>
    </tr>
    ` : ''}
    ${grant.url ? `
    <tr>
      <td class="label">Application Portal:</td>
      <td>${grant.url}</td>
    </tr>
    ` : ''}
  </table>

  <p style="text-align: center; margin-top: 48pt; font-weight: bold;">*** END OF APPLICATION ***</p>

</body>
</html>
      `;

      // Create and download file as .doc (Word will recognize HTML)
      const blob = new Blob([htmlContent], { type: 'application/msword' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fileName = `${grant.title.replace(/[^a-z0-9]/gi, '_')}_Application_${today.toISOString().split('T')[0]}.doc`;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: 'Application Downloaded! 📄',
        description: 'Your complete application has been saved as a Word document.'
      });

      // Update grant status to submitted
      await base44.entities.Grant.update(grant.id, {
        status: 'submitted',
      });

      // Create a milestone for submission
      await base44.entities.Milestone.create({
        grant_id: grant.id,
        title: 'Application Downloaded for Submission',
        description: `Complete application document downloaded on ${formattedDate}`,
        due_date: new Date().toISOString().split('T')[0],
        milestone_type: 'submission',
        completed: true,
        completed_date: new Date().toISOString().split('T')[0],
      });

      queryClient.invalidateQueries({ queryKey: ['grant', grant.id] });
      queryClient.invalidateQueries({ queryKey: ['grants'] });

      // Close modal after successful download
      setTimeout(() => {
        onClose();
      }, 1500);

    } catch (error) {
      console.error('Download failed:', error);
      toast({
        variant: 'destructive',
        title: 'Download Failed',
        description: error.message || 'Failed to generate document'
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSubmit = async () => {
    // If download method, trigger download instead
    if (submissionMethod === 'download') {
      await handleDownloadDocument();
      return;
    }

    // Validation for other methods
    if (submissionMethod === 'email' && !recipientEmail) {
      toast({
        variant: 'destructive',
        title: 'Email Required',
        description: 'Please provide a recipient email address.'
      });
      return;
    }

    if (submissionMethod === 'mail' && !recipientAddress) {
      toast({
        variant: 'destructive',
        title: 'Address Required',
        description: 'Please provide a mailing address.'
      });
      return;
    }

    if (submissionMethod === 'fax' && !recipientFax) {
      toast({
        variant: 'destructive',
        title: 'Fax Number Required',
        description: 'Please provide a fax number.'
      });
      return;
    }

    try {
      // Update grant status to submitted
      await base44.entities.Grant.update(grant.id, {
        status: 'submitted',
      });

      // Create a milestone for submission
      await base44.entities.Milestone.create({
        grant_id: grant.id,
        title: 'Application Submitted',
        description: `Submitted via ${submissionMethod}`,
        due_date: new Date().toISOString().split('T')[0],
        milestone_type: 'submission',
        completed: true,
        completed_date: new Date().toISOString().split('T')[0],
      });

      queryClient.invalidateQueries({ queryKey: ['grant', grant.id] });
      queryClient.invalidateQueries({ queryKey: ['grants'] });

      toast({
        title: 'Application Submitted! 🎉',
        description: 'Your grant application has been marked as submitted.'
      });

      onClose();
    } catch (error) {
      console.error('Submission failed:', error);
      toast({
        variant: 'destructive',
        title: 'Submission Failed',
        description: error.message || 'Failed to mark application as submitted'
      });
    }
  };

  const hasAnyContactInfo = recipientEmail || recipientPhone || recipientFax || recipientAddress;
  const needsContactInfo = !hasAnyContactInfo && submissionMethod !== 'download';

  const approvedSections = sections.filter(s => s.status === 'approved');
  const allSectionsReady = sections.length > 0 && approvedSections.length === sections.length;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-5 h-5 text-blue-600" />
            Submit Application
          </DialogTitle>
          <DialogDescription>
            Prepare and submit your application for {grant.title}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* AI Contact Finder */}
          {needsContactInfo && (
            <Alert className="bg-amber-50 border-amber-200">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-900">
                <p className="font-semibold mb-2">No Submission Contact Info</p>
                <p className="text-sm mb-3">Let AI find the submission email, phone, fax, and mailing address for this funder.</p>
                <Button
                  onClick={handleFindContactInfo}
                  disabled={isFindingContact}
                  variant="outline"
                  size="sm"
                  className="border-amber-300 hover:bg-amber-100"
                >
                  {isFindingContact ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Searching...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Find Contact Info with AI
                    </>
                  )}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Submission Method */}
          <div>
            <Label className="text-base font-semibold mb-3 block">Submission Method</Label>
            <RadioGroup value={submissionMethod} onValueChange={setSubmissionMethod}>
              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="email" id="email" />
                <Label htmlFor="email" className="flex items-center gap-2 cursor-pointer flex-1">
                  <Mail className="w-4 h-4 text-blue-600" />
                  <div>
                    <p className="font-medium">Email to Funder</p>
                    <p className="text-xs text-slate-600">Send your compiled application via email</p>
                  </div>
                </Label>
              </div>

              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="mail" id="mail" />
                <Label htmlFor="mail" className="flex items-center gap-2 cursor-pointer flex-1">
                  <MapPin className="w-4 h-4 text-green-600" />
                  <div>
                    <p className="font-medium">Mail Physical Copy</p>
                    <p className="text-xs text-slate-600">Send via postal mail</p>
                  </div>
                </Label>
              </div>

              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="fax" id="fax" />
                <Label htmlFor="fax" className="flex items-center gap-2 cursor-pointer flex-1">
                  <Printer className="w-4 h-4 text-purple-600" />
                  <div>
                    <p className="font-medium">Fax</p>
                    <p className="text-xs text-slate-600">Send via fax machine</p>
                  </div>
                </Label>
              </div>

              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-slate-50 cursor-pointer">
                <RadioGroupItem value="download" id="download" />
                <Label htmlFor="download" className="flex items-center gap-2 cursor-pointer flex-1">
                  <Download className="w-4 h-4 text-slate-600" />
                  <div>
                    <p className="font-medium">Download as Document</p>
                    <p className="text-xs text-slate-600">Get a Word document to upload yourself</p>
                  </div>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Contact Info Fields - Only show if not downloading */}
          {submissionMethod !== 'download' && (
            <div className="space-y-4 p-4 bg-slate-50 rounded-lg border">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-base font-semibold">Submission Contact Information</Label>
                {hasAnyContactInfo && (
                  <Button
                    onClick={handleFindContactInfo}
                    disabled={isFindingContact}
                    variant="ghost"
                    size="sm"
                  >
                    {isFindingContact ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Updating...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 mr-2" />
                        Refresh with AI
                      </>
                    )}
                  </Button>
                )}
              </div>

              <div>
                <Label htmlFor="recipientEmail" className="flex items-center gap-2">
                  <Mail className="w-4 h-4" />
                  Email Address {submissionMethod === 'email' && <span className="text-red-500">*</span>}
                </Label>
                <Input
                  id="recipientEmail"
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="grants@funder.org"
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="recipientPhone" className="flex items-center gap-2">
                  <Phone className="w-4 h-4" />
                  Phone Number
                </Label>
                <Input
                  id="recipientPhone"
                  value={recipientPhone}
                  onChange={(e) => setRecipientPhone(e.target.value)}
                  placeholder="(555) 123-4567"
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="recipientFax" className="flex items-center gap-2">
                  <Printer className="w-4 h-4" />
                  Fax Number {submissionMethod === 'fax' && <span className="text-red-500">*</span>}
                </Label>
                <Input
                  id="recipientFax"
                  value={recipientFax}
                  onChange={(e) => setRecipientFax(e.target.value)}
                  placeholder="(555) 123-4568"
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="recipientAddress" className="flex items-center gap-2">
                  <MapPin className="w-4 h-4" />
                  Mailing Address {submissionMethod === 'mail' && <span className="text-red-500">*</span>}
                </Label>
                <Textarea
                  id="recipientAddress"
                  value={recipientAddress}
                  onChange={(e) => setRecipientAddress(e.target.value)}
                  placeholder="123 Main St&#10;City, State ZIP"
                  rows={3}
                  className="mt-1"
                />
              </div>

              {hasAnyContactInfo && (
                <Alert className="bg-blue-50 border-blue-200">
                  <AlertDescription className="text-blue-900 text-xs">
                    💡 This contact information will be saved to the grant details for future use.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* Cover Letter - Only show if not downloading */}
          {submissionMethod !== 'download' && (
            <div>
              <Label htmlFor="coverLetter" className="text-base font-semibold mb-2 block">
                Cover Letter (Optional)
              </Label>
              {isGeneratingLetter ? (
                <div className="flex items-center justify-center p-8 border rounded-lg bg-slate-50">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600 mr-2" />
                  <span className="text-slate-600">Generating cover letter...</span>
                </div>
              ) : (
                <Textarea
                  id="coverLetter"
                  value={coverLetter}
                  onChange={(e) => setCoverLetter(e.target.value)}
                  rows={8}
                  className="font-mono text-sm"
                />
              )}
            </div>
          )}

          {/* Download Preview */}
          {submissionMethod === 'download' && (
            <Alert className="bg-blue-50 border-blue-200">
              <FileText className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-900">
                <p className="font-semibold mb-2">Ready to Download</p>
                <p className="text-sm mb-2">Your application will be compiled into a Word document containing:</p>
                <ul className="text-sm space-y-1 ml-4 list-disc">
                  <li>Cover letter</li>
                  <li>All {sections.length} proposal sections</li>
                  <li>Application information</li>
                </ul>
                <p className="text-sm mt-2">You can then upload this file to the funder's portal or submit it however you choose.</p>
              </AlertDescription>
            </Alert>
          )}

          {/* Submission Status */}
          <Alert className={allSectionsReady ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}>
            {allSectionsReady ? (
              <CheckCircle className="h-4 w-4 text-green-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            )}
            <AlertDescription className={allSectionsReady ? "text-green-900" : "text-amber-900"}>
              <div className="flex items-center gap-2 mb-2">
                <Badge className={allSectionsReady ? "bg-green-600" : "bg-amber-600"}>
                  {approvedSections.length}/{sections.length} sections approved
                </Badge>
                {allSectionsReady && (
                  <Badge className="bg-green-600">All sections ready!</Badge>
                )}
              </div>
              <p className="text-sm">
                {allSectionsReady 
                  ? 'Your application is complete and ready to submit!' 
                  : 'Some sections are not yet approved. You can still submit, but we recommend completing all sections first.'}
              </p>
            </AlertDescription>
          </Alert>
        </div>

        {/* Footer Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleSubmit}
            disabled={isDownloading}
            className={submissionMethod === 'download' ? "bg-blue-600 hover:bg-blue-700" : "bg-green-600 hover:bg-green-700"}
          >
            {isDownloading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating Document...
              </>
            ) : submissionMethod === 'download' ? (
              <>
                <Download className="w-4 h-4 mr-2" />
                Download Application
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Mark as Submitted
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
