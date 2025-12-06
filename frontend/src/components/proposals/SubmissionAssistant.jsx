import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  FileText,
  Save
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import {
  buildCoverLetterPrompt,
  buildFallbackCoverLetter,
  CONTACT_INFO_SCHEMA,
  generateApplicationDocument,
  generateCoverLetterDocument,
  slugifyFilename,
} from './submissionHelpers';

export default function SubmissionAssistant({ open, onClose, grant, organization }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [submissionMethod, setSubmissionMethod] = useState('email');
  const [contactInfo, setContactInfo] = useState({
    recipientEmail: '',
    recipientPhone: '',
    recipientFax: '',
    recipientAddress: '',
  });
  const [coverLetter, setCoverLetter] = useState('');
  const [isGeneratingLetter, setIsGeneratingLetter] = useState(false);
  const [isFindingContact, setIsFindingContact] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [includeCoverLetter, setIncludeCoverLetter] = useState(true);
  const [isSavingContact, setIsSavingContact] = useState(false);
  
  // Auto-save debounce ref
  const autoSaveTimeoutRef = useRef(null);

  const { data: sections = [] } = useQuery({
    queryKey: ['proposalSections', grant?.id],
    queryFn: () => base44.entities.ProposalSection.filter({ grant_id: grant.id }, 'section_order'),
    enabled: !!grant?.id && open,
  });

  const { data: requirements = [] } = useQuery({
    queryKey: ['requirements', grant?.id],
    queryFn: () => base44.entities.ApplicationRequirement.filter({ grant_id: grant.id }),
    enabled: !!grant?.id && open,
  });

  // Fetch application draft data (where the wizard saves form data)
  const { data: applicationDrafts = [] } = useQuery({
    queryKey: ['applicationDrafts', grant?.id],
    queryFn: () => base44.entities.ApplicationDraft.filter({ grant_id: grant.id }),
    enabled: !!grant?.id && open,
  });
  
  // Get the most recent draft's form data
  const applicationDraft = applicationDrafts[0];
  const formData = applicationDraft?.form_data || {};

  useEffect(() => {
    if (grant) {
      setContactInfo({
        recipientEmail: grant.funder_email || '',
        recipientPhone: grant.funder_phone || '',
        recipientFax: grant.funder_fax || '',
        recipientAddress: grant.funder_address || '',
      });
    }
  }, [grant]);

  // Auto-save contact info when it changes
  const saveContactInfo = useCallback(async (info) => {
    if (!grant?.id) return;
    
    const updates = {};
    if (info.recipientEmail) updates.funder_email = info.recipientEmail;
    if (info.recipientPhone) updates.funder_phone = info.recipientPhone;
    if (info.recipientFax) updates.funder_fax = info.recipientFax;
    if (info.recipientAddress) updates.funder_address = info.recipientAddress;
    
    if (Object.keys(updates).length > 0) {
      setIsSavingContact(true);
      try {
        await base44.entities.Grant.update(grant.id, updates);
        queryClient.invalidateQueries({ queryKey: ['grant', grant.id] });
      } catch (error) {
        console.error('[SubmissionAssistant] Failed to auto-save contact:', error);
      } finally {
        setIsSavingContact(false);
      }
    }
  }, [grant?.id, queryClient]);

  // Debounced auto-save when contact info changes
  const handleContactChange = (field, value) => {
    const newContactInfo = { ...contactInfo, [field]: value };
    setContactInfo(newContactInfo);
    
    // Clear existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }
    
    // Set new timeout for auto-save (1.5 seconds after last change)
    autoSaveTimeoutRef.current = setTimeout(() => {
      saveContactInfo(newContactInfo);
    }, 1500);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (open && !coverLetter) {
      generateCoverLetter();
    }
  }, [open]);

  const generateCoverLetter = async () => {
    setIsGeneratingLetter(true);
    try {
      const prompt = buildCoverLetterPrompt(organization, grant);
      const response = await base44.integrations.Core.InvokeLLM({ prompt });
      setCoverLetter(response);
    } catch (error) {
      console.error('Failed to generate cover letter:', error);
      setCoverLetter(buildFallbackCoverLetter(organization, grant));
    } finally {
      setIsGeneratingLetter(false);
    }
  };

  const handleFindContactInfo = async () => {
    setIsFindingContact(true);
    
    try {
      // Extract potential parent organization or alternate names from grant title
      const grantTitle = grant.title || '';
      const funderName = grant.funder || '';
      
      // Build search variations
      const searchTerms = [funderName];
      
      // If grant title contains "Fund" or "Scholarship", the administering org might be different
      if (grantTitle.toLowerCase().includes('fund') || grantTitle.toLowerCase().includes('scholarship')) {
        // Look for common patterns like "X Memorial Scholarship" administered by community foundations
        searchTerms.push(`"${grantTitle}" contact`);
        searchTerms.push(`"${grantTitle}" foundation`);
      }
      
      // Super aggressive prompt that demands results
      const prompt = `URGENT RESEARCH TASK: Find contact information for submitting to this grant/scholarship.

GRANT/SCHOLARSHIP: "${grantTitle}"
FUNDER/ADMINISTRATOR: "${funderName}"
${grant.url ? `WEBSITE: ${grant.url}` : ''}

IMPORTANT: Many scholarships and funds are ADMINISTERED by community foundations, banks, or other organizations. 
If "${funderName}" is a fund name (like "John Smith Memorial Scholarship"), search for WHO ADMINISTERS IT.

SEARCH STRATEGY - DO ALL OF THESE:
1. Search "${funderName}" - find their website
2. Search "${grantTitle}" - the program/scholarship name
3. Search "${funderName} contact information"
4. Search "${funderName} phone email address"
5. If it's a scholarship fund, search "${grantTitle} application" to find the administrator
6. Search for the organization on Google Maps to get address/phone
7. Check if a community foundation administers this fund
8. Look for Form 990 tax records which have public address info

COMMON PATTERNS:
- Memorial scholarships are often run by community foundations
- Named funds (like "Smith Family Fund") are often at community foundations
- Local scholarships may be administered by local community foundations

YOU MUST FIND:
- At minimum: a phone number OR email OR address
- The organization "${funderName}" or its administrator EXISTS and has public contact info
- Do NOT give up - search harder if initial searches fail

OUTPUT (JSON only - fill in everything you find):
{
  "email": "contact email (grants@, info@, or staff email)",
  "phone": "phone number with area code like (423) 555-1234",
  "fax": "fax number or null",
  "address": "Full address: Street, City, State ZIP"
}

CRITICAL: Return real data you find. Do not make up information. But also do not return all nulls - this organization has public contact information somewhere.`;

      const response = await base44.integrations.Core.InvokeLLM({
        prompt,
        add_context_from_internet: true,
        response_json_schema: CONTACT_INFO_SCHEMA,
      });

      const updates = {};
      const newContactInfo = { ...contactInfo };
      
      // Update all found fields, even if we have existing values (user can override)
      if (response.email) {
        newContactInfo.recipientEmail = response.email;
        updates.funder_email = response.email;
      }
      if (response.phone) {
        newContactInfo.recipientPhone = response.phone;
        updates.funder_phone = response.phone;
      }
      if (response.fax) {
        newContactInfo.recipientFax = response.fax;
        updates.funder_fax = response.fax;
      }
      if (response.address) {
        newContactInfo.recipientAddress = response.address;
        updates.funder_address = response.address;
      }

      setContactInfo(newContactInfo);

      const foundCount = [response.email, response.phone, response.fax, response.address].filter(Boolean).length;
      
      if (foundCount > 0) {
        toast({
          title: 'Contact Info Found! ✨',
          description: `Found ${foundCount} contact detail(s). Review and edit as needed.`
        });
        
        // Auto-save immediately
        if (Object.keys(updates).length > 0) {
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

        // Validate formData before document generation
        if (!formData || typeof formData !== 'object') {
          throw new Error('Application data is missing or invalid. Please complete the application wizard first.');
        }

        // Generate application (with requirements included)
        const htmlContent = generateApplicationDocument(grant, organization, sections, contactInfo, formData, requirements);

      // Open print dialog for PDF saving
      const printWindow = window.open('', '_blank');
      printWindow.document.write(htmlContent);
      printWindow.document.close();
      
      // Wait for content to load then trigger print
      printWindow.onload = () => {
        printWindow.print();
      };
      
      // Fallback if onload doesn't fire
      setTimeout(() => {
        if (printWindow && !printWindow.closed) {
          printWindow.print();
        }
      }, 500);

      toast({
        title: 'Print Dialog Opened 📄',
        description: 'Use "Save as PDF" in the print dialog to download your application.'
      });

      await base44.entities.Grant.update(grant.id, {
        status: 'submitted',
      });

      await base44.entities.Milestone.create({
        grant_id: grant.id,
        title: 'Application Submitted',
        description: `Application submitted on ${formattedDate}`,
        due_date: new Date().toISOString().split('T')[0],
        milestone_type: 'submission',
        completed: true,
        completed_date: new Date().toISOString().split('T')[0],
      });

      queryClient.invalidateQueries({ queryKey: ['grant', grant.id] });
      queryClient.invalidateQueries({ queryKey: ['grants'] });

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

  const handlePrintCoverLetterOnly = () => {
    if (!coverLetter) {
      toast({
        variant: 'destructive',
        title: 'No Cover Letter',
        description: 'Please generate or write a cover letter first.'
      });
      return;
    }

    const htmlContent = generateCoverLetterDocument(grant, organization, coverLetter, contactInfo);

    const printWindow = window.open('', '_blank');
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    
    printWindow.onload = () => {
      printWindow.print();
    };
    
    setTimeout(() => {
      if (printWindow && !printWindow.closed) {
        printWindow.print();
      }
    }, 500);

    toast({
      title: 'Cover Letter Print Dialog Opened',
      description: 'Use "Save as PDF" to download your cover letter separately.'
    });
  };

  const handleSubmit = async () => {
    // Always generate and download the document
    await handleDownloadDocument();
  };

  const hasAnyContactInfo = Object.values(contactInfo).some(v => v);
  const needsContactInfo = !hasAnyContactInfo && submissionMethod !== 'download';
  const approvedSections = sections.filter(s => s.status === 'approved');
  const allSectionsReady = sections.length === 0 || approvedSections.length === sections.length;

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
                  value={contactInfo.recipientEmail}
                  onChange={(e) => handleContactChange('recipientEmail', e.target.value)}
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
                  value={contactInfo.recipientPhone}
                  onChange={(e) => handleContactChange('recipientPhone', e.target.value)}
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
                  value={contactInfo.recipientFax}
                  onChange={(e) => handleContactChange('recipientFax', e.target.value)}
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
                  value={contactInfo.recipientAddress}
                  onChange={(e) => handleContactChange('recipientAddress', e.target.value)}
                  placeholder="123 Main St&#10;City, State ZIP"
                  rows={3}
                  className="mt-1"
                />
              </div>

              <Alert className="bg-blue-50 border-blue-200">
                <AlertDescription className="text-blue-900 text-xs flex items-center gap-2">
                  {isSavingContact ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Saving contact info...
                    </>
                  ) : (
                    <>
                      <Save className="w-3 h-3" />
                      Contact information auto-saves to the grant record
                    </>
                  )}
                </AlertDescription>
              </Alert>
            </div>
          )}

          {submissionMethod !== 'download' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label htmlFor="coverLetter" className="text-base font-semibold">
                  Cover Letter
                </Label>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeCoverLetter}
                      onChange={(e) => setIncludeCoverLetter(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    Include in application
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePrintCoverLetterOnly}
                    disabled={!coverLetter}
                  >
                    <Printer className="w-3 h-3 mr-1" />
                    Print Separately
                  </Button>
                </div>
              </div>
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
              {!includeCoverLetter && (
                <p className="text-xs text-amber-600 mt-1">
                  ⚠️ Cover letter will NOT be included in the application document. Use "Print Separately" to get it as a standalone document.
                </p>
              )}
            </div>
          )}

          {submissionMethod === 'download' && (
            <Alert className="bg-blue-50 border-blue-200">
              <FileText className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-900">
                <p className="font-semibold mb-2">Ready to Download</p>
                <p className="text-sm mb-2">Your application will be compiled into a Word document containing:</p>
                <ul className="text-sm space-y-1 ml-4 list-disc">
                  {includeCoverLetter && <li>Cover letter</li>}
                  <li>All {sections.length} proposal sections</li>
                  {requirements.filter(r => r.draft_content).length > 0 && (
                    <li>{requirements.filter(r => r.draft_content).length} custom written requirement(s)</li>
                  )}
                  <li>Application information</li>
                </ul>
                <p className="text-sm mt-2">You can then upload this file to the funder's portal or submit it however you choose.</p>
              </AlertDescription>
            </Alert>
            )}

          <Alert className="bg-green-50 border-green-200">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-900">
              <p className="text-sm">Ready to submit your application.</p>
            </AlertDescription>
          </Alert>
        </div>

        <div className="flex flex-wrap justify-end gap-3 pt-4 border-t">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {coverLetter && submissionMethod !== 'download' && (
            <Button 
              variant="outline"
              onClick={handlePrintCoverLetterOnly}
            >
              <FileText className="w-4 h-4 mr-2" />
              Print Cover Letter Only
            </Button>
          )}
          <Button 
            onClick={handleSubmit}
            disabled={isDownloading}
            className="bg-green-600 hover:bg-green-700"
          >
            {isDownloading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 mr-2" />
                {includeCoverLetter ? 'Generate & Submit' : 'Generate Application (No Cover)'}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}