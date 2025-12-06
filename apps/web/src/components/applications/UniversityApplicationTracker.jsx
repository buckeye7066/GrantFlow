import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { GraduationCap, Calendar, DollarSign, FileText, Plus, X, ExternalLink, CreditCard, Sparkles, Upload, Loader2, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import UniversityDetailDialog from './UniversityDetailDialog';
import CommonAppProfileEditor from './CommonAppProfileEditor';

const PLATFORMS = [
  { value: 'commonapp', label: 'Common Application', url: 'https://www.commonapp.org' },
  { value: 'coalition', label: 'Coalition Application', url: 'https://www.coalitionforcollegeaccess.org' },
  { value: 'apply_texas', label: 'ApplyTexas', url: 'https://www.applytexas.org' },
  { value: 'uc_application', label: 'UC Application', url: 'https://admission.universityofcalifornia.edu' },
  { value: 'direct', label: 'Direct to Institution', url: null },
  { value: 'other', label: 'Other Platform', url: null }
];

export default function UniversityApplicationTracker({ organizationId, isStudent, organization }) {
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [newApp, setNewApp] = useState({
    university_name: '',
    application_type: 'regular_decision',
    platform: 'direct',
    application_deadline: '',
    major_applied: '',
    application_fee: 0,
    application_url: '',
    payment_portal_url: ''
  });
  const [selectedApp, setSelectedApp] = useState(null);
  const [parsedUniversityInfo, setParsedUniversityInfo] = useState(null);
  const [fetchingInfoForId, setFetchingInfoForId] = useState(null);

  const { data: applications = [] } = useQuery({
    queryKey: ['universityApplications', organizationId],
    queryFn: () => base44.entities.UniversityApplication.filter({ organization_id: organizationId }, 'application_deadline'),
    enabled: !!organizationId && isStudent
  });

  // Helper to normalize university names for comparison
  const normalizeUniversityName = (name) => {
    if (!name) return '';
    return name.toLowerCase().trim()
      .replace(/\s+/g, ' ')
      .replace(/^the\s+/i, '')
      .replace(/\s*(university|college|institute|school)\s*(of|at)?\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  // Find existing application with similar name
  const findDuplicateApplication = (universityName) => {
    const normalized = normalizeUniversityName(universityName);
    return applications.find(app => {
      const appNormalized = normalizeUniversityName(app.university_name);
      // Check exact match or close match
      return appNormalized === normalized ||
        appNormalized.includes(normalized) ||
        normalized.includes(appNormalized);
    });
  };

  const createMutation = useMutation({
    mutationFn: async (data) => {
      // Check for duplicates before creating
      const existing = findDuplicateApplication(data.university_name);
      
      if (existing) {
        // Merge with existing record instead of creating new
        const mergedData = {
          application_deadline: data.application_deadline || existing.application_deadline,
          application_type: data.application_type || existing.application_type,
          application_fee: data.application_fee || existing.application_fee,
          major_applied: data.major_applied || existing.major_applied,
          application_url: data.application_url || existing.application_url,
          payment_portal_url: data.payment_portal_url || existing.payment_portal_url,
          platform: data.platform || existing.platform,
          status: data.status || existing.status,
          notes: data.notes || existing.notes
        };
        
        await base44.entities.UniversityApplication.update(existing.id, mergedData);
        toast.info(`Merged with existing ${existing.university_name} application`);
        return existing;
      }
      
      // Create new application
      const app = await base44.entities.UniversityApplication.create({
        ...data,
        organization_id: organizationId
      });
      
      // Also add to profile's target_colleges if not already there
      try {
        const org = await base44.entities.Organization.get(organizationId);
        const currentTargets = org.target_colleges || [];
        if (!currentTargets.includes(data.university_name)) {
          await base44.entities.Organization.update(organizationId, {
            target_colleges: [...currentTargets, data.university_name]
          });
        }
      } catch (e) {
        console.error('Failed to update target colleges:', e);
      }
      
      return app;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['universityApplications', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
      setIsAdding(false);
      setNewApp({
        university_name: '',
        application_type: 'regular_decision',
        platform: 'direct',
        application_deadline: '',
        major_applied: ''
      });
      toast.success('University application added');
      
      // Trigger scholarship search for this university
      searchUniversityScholarships(variables.university_name);
    }
  });
  
  const searchUniversityScholarships = async (universityName) => {
    try {
      toast.info(`🔍 Searching for scholarships at ${universityName}...`);
      const response = await base44.functions.invoke('crawlUniversityScholarships', {
        organization_id: organizationId,
        university_name: universityName
      });
      
      if (response.data?.scholarships_found > 0) {
        toast.success(`Found ${response.data.scholarships_found} scholarship opportunities at ${universityName}!`);
        queryClient.invalidateQueries({ queryKey: ['grants'] });
      } else {
        toast.info(`Search complete for ${universityName}`);
      }
    } catch (error) {
      console.error('Scholarship search failed:', error);
      // Don't show error toast - this is a background enhancement
    }
  };

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.UniversityApplication.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['universityApplications', organizationId] });
      toast.success('Updated');
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.UniversityApplication.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['universityApplications', organizationId] });
      toast.success('Application removed');
    }
  });

  if (!isStudent) return null;

  const handleUploadUniversityInfo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsUploading(true);
    
    try {
      // Upload file first
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      
      // Extract data from the uploaded document (including QR codes)
      const extractedData = await base44.integrations.Core.ExtractDataFromUploadedFile({
        file_url,
        json_schema: {
          type: "object",
          properties: {
            university_name: { type: "string", description: "Name of the university" },
            application_deadline: { type: "string", description: "Application deadline in YYYY-MM-DD format" },
            application_type: { type: "string", description: "Type: early_decision, early_action, regular_decision, or rolling" },
            application_fee: { type: "number", description: "Application fee amount in dollars" },
            major_applied: { type: "string", description: "Major or program mentioned" },
            application_url: { type: "string", description: "Application portal URL if mentioned, or URL from any QR code in the image" },
            payment_portal_url: { type: "string", description: "Payment portal URL if mentioned" },
            financial_aid_deadline: { type: "string", description: "Financial aid deadline if mentioned" },
            admission_decision: { type: "string", description: "If this is an acceptance/rejection letter, what was the decision" },
            scholarship_amount: { type: "number", description: "Scholarship amount offered if any" },
            qr_code_url: { type: "string", description: "If there is a QR code in the image, decode it and provide the URL or text it contains" },
            notes: { type: "string", description: "Any other important information from the document" }
          }
        }
      });
      
      if (extractedData.status === 'error') {
        toast.error('Failed to extract data: ' + extractedData.details);
        return;
      }
      
      const data = extractedData.output;
      
      // If QR code was found, use it as application URL if no other URL exists
      if (data.qr_code_url && !data.application_url) {
        data.application_url = data.qr_code_url;
      }
      
      // Map admission decision to status
      let status = 'planning';
      if (data.admission_decision) {
        const decision = data.admission_decision.toLowerCase();
        if (decision.includes('accept') || decision.includes('admit') || decision.includes('congratulations')) {
          status = 'accepted';
        } else if (decision.includes('reject') || decision.includes('deny') || decision.includes('unable')) {
          status = 'rejected';
        } else if (decision.includes('waitlist')) {
          status = 'waitlisted';
        } else if (decision.includes('defer')) {
          status = 'deferred';
        }
      }
      
      // Check if this university already exists (case-insensitive match)
      const existingApp = applications.find(app => 
        app.university_name.toLowerCase().trim() === data.university_name?.toLowerCase().trim()
      );
      
      if (existingApp) {
        // Merge new data with existing record
        const mergedData = {
          ...existingApp,
          application_deadline: data.application_deadline || existingApp.application_deadline,
          application_type: data.application_type || existingApp.application_type,
          application_fee: data.application_fee || existingApp.application_fee,
          major_applied: data.major_applied || existingApp.major_applied,
          application_url: data.application_url || existingApp.application_url,
          payment_portal_url: data.payment_portal_url || existingApp.payment_portal_url,
          status: data.admission_decision ? status : existingApp.status,
          notes: existingApp.notes 
            ? `${existingApp.notes}\n\n${data.notes || ''}`.trim() 
            : (data.notes || '')
        };
        
        await updateMutation.mutateAsync({ id: existingApp.id, data: mergedData });
        toast.success(`Updated ${data.university_name} with new information`);
        return;
      }
      
      // If this looks like a decision letter and we found a university name, create the application directly
      if (data.university_name && (data.admission_decision || data.scholarship_amount)) {
        await createMutation.mutateAsync({
          university_name: data.university_name,
          application_type: data.application_type || 'regular_decision',
          platform: 'direct',
          application_deadline: data.application_deadline || '',
          major_applied: data.major_applied || '',
          application_fee: data.application_fee || 0,
          application_url: data.application_url || '',
          payment_portal_url: data.payment_portal_url || '',
          status: status,
          scholarship_offered: data.scholarship_amount || 0,
          notes: data.notes || ''
        });
        toast.success(`Added ${data.university_name} - ${status}`);
      } else if (data.university_name) {
        // Check again for non-decision documents
        await createMutation.mutateAsync({
          university_name: data.university_name,
          application_type: data.application_type || 'regular_decision',
          platform: 'direct',
          application_deadline: data.application_deadline || '',
          major_applied: data.major_applied || '',
          application_fee: data.application_fee || 0,
          application_url: data.application_url || '',
          payment_portal_url: data.payment_portal_url || '',
          notes: data.notes || ''
        });
        toast.success(`Added ${data.university_name}`);
      } else {
        // Pre-fill the form with extracted data
        setNewApp(prev => ({
          ...prev,
          university_name: data.university_name || prev.university_name,
          application_deadline: data.application_deadline || prev.application_deadline,
          application_type: data.application_type || prev.application_type,
          application_fee: data.application_fee || prev.application_fee,
          major_applied: data.major_applied || prev.major_applied,
          application_url: data.application_url || prev.application_url,
          payment_portal_url: data.payment_portal_url || prev.payment_portal_url
        }));
        setIsAdding(true);
        toast.success('Extracted university info - please review and save');
      }
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to process document');
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };

  // Determine the target enrollment term/year from organization profile
  const getTargetEnrollmentInfo = () => {
    const term = organization?.planned_enrollment_term || 'fall';
    const year = organization?.planned_enrollment_year || new Date().getFullYear() + 1;
    return { term, year };
  };

  const handleAIGenerate = async () => {
    if (!newApp.university_name) {
      toast.error('Please enter a university name first');
      return;
    }
    
    setIsGenerating(true);
    const { term, year } = getTargetEnrollmentInfo();
    const termCapitalized = term.charAt(0).toUpperCase() + term.slice(1);
    
    try {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `Research "${newApp.university_name}" undergraduate admissions and provide comprehensive information.

IMPORTANT: The student plans to start in ${termCapitalized} ${year}. All deadlines must be for ${termCapitalized} ${year} admission.

REQUIRED DATA:
1. platform: Application platform used (commonapp, coalition, apply_texas, uc_application, direct, or other)
2. application_deadline: Regular Decision deadline for ${termCapitalized} ${year} in YYYY-MM-DD format
3. early_action_deadline: Early Action deadline for ${termCapitalized} ${year} if available in YYYY-MM-DD format
4. early_decision_deadline: Early Decision deadline for ${termCapitalized} ${year} if available in YYYY-MM-DD format
5. application_fee: Application fee amount as a number (e.g., 65)
6. application_url: Direct URL to apply (e.g., https://www.ucf.edu/admissions/undergraduate/apply/)
7. payment_portal_url: Payment portal URL if different from application URL
8. acceptance_rate: Acceptance rate as a percentage number (e.g., 41)
9. avg_gpa: Average admitted GPA as a number (e.g., 3.8)
10. sat_range_low: SAT 25th percentile score (e.g., 1200)
11. sat_range_high: SAT 75th percentile score (e.g., 1370)
12. act_range_low: ACT 25th percentile score (e.g., 25)
13. act_range_high: ACT 75th percentile score (e.g., 30)
14. in_state_tuition: Annual in-state tuition as a number
15. out_of_state_tuition: Annual out-of-state tuition as a number
16. room_and_board: Annual room and board cost as a number
17. financial_aid_deadline: Priority financial aid deadline in YYYY-MM-DD format
18. fafsa_code: Federal school code for FAFSA
19. essay_required: Whether an essay is required (true/false)
20. letters_of_rec_required: Number of recommendation letters required (0 if none)
21. test_optional: Whether the school is test-optional (true/false)
22. campus_visit_url: URL to schedule campus visit
23. top_majors: Array of popular majors at this school
24. enrollment: Total undergraduate enrollment number
25. school_type: public or private
26. setting: urban, suburban, or rural
27. notes: Any important admissions notes or requirements

Return ONLY valid JSON. Do not include commentary outside the JSON object.`,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            platform: { type: "string" },
            application_deadline: { type: "string" },
            early_action_deadline: { type: "string" },
            early_decision_deadline: { type: "string" },
            application_fee: { type: "number" },
            application_url: { type: "string" },
            payment_portal_url: { type: "string" },
            acceptance_rate: { type: "number" },
            avg_gpa: { type: "number" },
            sat_range_low: { type: "number" },
            sat_range_high: { type: "number" },
            act_range_low: { type: "number" },
            act_range_high: { type: "number" },
            in_state_tuition: { type: "number" },
            out_of_state_tuition: { type: "number" },
            room_and_board: { type: "number" },
            financial_aid_deadline: { type: "string" },
            fafsa_code: { type: "string" },
            essay_required: { type: "boolean" },
            letters_of_rec_required: { type: "number" },
            test_optional: { type: "boolean" },
            campus_visit_url: { type: "string" },
            top_majors: { type: "array", items: { type: "string" } },
            enrollment: { type: "number" },
            school_type: { type: "string" },
            setting: { type: "string" },
            notes: { type: "string" }
          }
        }
      });
      
      // Update the form with basic fields
      setNewApp(prev => ({
        ...prev,
        platform: response.platform || prev.platform,
        application_deadline: response.application_deadline || prev.application_deadline,
        application_fee: response.application_fee || prev.application_fee,
        application_url: response.application_url || prev.application_url,
        payment_portal_url: response.payment_portal_url || prev.payment_portal_url
      }));
      
      // Store parsed university info for display and later use
      const universityInfo = {
        acceptance_rate: response.acceptance_rate,
        avg_gpa: response.avg_gpa,
        sat_range: response.sat_range_low && response.sat_range_high ? `${response.sat_range_low}-${response.sat_range_high}` : null,
        act_range: response.act_range_low && response.act_range_high ? `${response.act_range_low}-${response.act_range_high}` : null,
        in_state_tuition: response.in_state_tuition,
        out_of_state_tuition: response.out_of_state_tuition,
        room_and_board: response.room_and_board,
        financial_aid_deadline: response.financial_aid_deadline,
        fafsa_code: response.fafsa_code,
        essay_required: response.essay_required,
        letters_of_rec_required: response.letters_of_rec_required,
        test_optional: response.test_optional,
        campus_visit_url: response.campus_visit_url,
        top_majors: response.top_majors,
        enrollment: response.enrollment,
        school_type: response.school_type,
        setting: response.setting,
        early_action_deadline: response.early_action_deadline,
        early_decision_deadline: response.early_decision_deadline,
        notes: response.notes
      };
      
      // Store in state for display
      setParsedUniversityInfo(universityInfo);
      
      toast.success('AI suggestions applied! Review details below.');
    } catch (error) {
      toast.error('Failed to generate suggestions');
      console.error(error);
    } finally {
      setIsGenerating(false);
    }
  };

  // Fetch info for an existing university
  const fetchUniversityInfo = async (app) => {
    setFetchingInfoForId(app.id);
    const { term, year } = getTargetEnrollmentInfo();
    const termCapitalized = term.charAt(0).toUpperCase() + term.slice(1);
    
    try {
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `Research "${app.university_name}" undergraduate admissions and provide comprehensive information.

IMPORTANT: The student plans to start in ${termCapitalized} ${year}. All deadlines must be for ${termCapitalized} ${year} admission.

REQUIRED DATA:
1. platform: Application platform used (commonapp, coalition, apply_texas, uc_application, direct, or other)
2. application_deadline: Regular Decision deadline for ${termCapitalized} ${year} in YYYY-MM-DD format
3. early_action_deadline: Early Action deadline for ${termCapitalized} ${year} if available in YYYY-MM-DD format
4. early_decision_deadline: Early Decision deadline for ${termCapitalized} ${year} if available in YYYY-MM-DD format
5. application_fee: Application fee amount as a number (e.g., 65)
6. application_url: Direct URL to apply
7. payment_portal_url: Payment portal URL if different from application URL
8. acceptance_rate: Acceptance rate as a percentage number (e.g., 41)
9. avg_gpa: Average admitted GPA as a number (e.g., 3.8)
10. sat_range_low: SAT 25th percentile score (e.g., 1200)
11. sat_range_high: SAT 75th percentile score (e.g., 1370)
12. act_range_low: ACT 25th percentile score (e.g., 25)
13. act_range_high: ACT 75th percentile score (e.g., 30)
14. in_state_tuition: Annual in-state tuition as a number
15. out_of_state_tuition: Annual out-of-state tuition as a number
16. room_and_board: Annual room and board cost as a number
17. financial_aid_deadline: Priority financial aid deadline in YYYY-MM-DD format
18. fafsa_code: Federal school code for FAFSA
19. essay_required: Whether an essay is required (true/false)
20. letters_of_rec_required: Number of recommendation letters required (0 if none)
21. test_optional: Whether the school is test-optional (true/false)
22. campus_visit_url: URL to schedule campus visit
23. top_majors: Array of popular majors at this school
24. enrollment: Total undergraduate enrollment number
25. school_type: public or private
26. setting: urban, suburban, or rural
27. notes: Any important admissions notes or requirements

Return ONLY valid JSON.`,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            platform: { type: "string" },
            application_deadline: { type: "string" },
            early_action_deadline: { type: "string" },
            early_decision_deadline: { type: "string" },
            application_fee: { type: "number" },
            application_url: { type: "string" },
            payment_portal_url: { type: "string" },
            acceptance_rate: { type: "number" },
            avg_gpa: { type: "number" },
            sat_range_low: { type: "number" },
            sat_range_high: { type: "number" },
            act_range_low: { type: "number" },
            act_range_high: { type: "number" },
            in_state_tuition: { type: "number" },
            out_of_state_tuition: { type: "number" },
            room_and_board: { type: "number" },
            financial_aid_deadline: { type: "string" },
            fafsa_code: { type: "string" },
            essay_required: { type: "boolean" },
            letters_of_rec_required: { type: "number" },
            test_optional: { type: "boolean" },
            campus_visit_url: { type: "string" },
            top_majors: { type: "array", items: { type: "string" } },
            enrollment: { type: "number" },
            school_type: { type: "string" },
            setting: { type: "string" },
            notes: { type: "string" }
          }
        }
      });
      
      // Build university info object
      const universityInfo = {
        acceptance_rate: response.acceptance_rate,
        avg_gpa: response.avg_gpa,
        sat_range: response.sat_range_low && response.sat_range_high ? `${response.sat_range_low}-${response.sat_range_high}` : null,
        act_range: response.act_range_low && response.act_range_high ? `${response.act_range_low}-${response.act_range_high}` : null,
        in_state_tuition: response.in_state_tuition,
        out_of_state_tuition: response.out_of_state_tuition,
        room_and_board: response.room_and_board,
        financial_aid_deadline: response.financial_aid_deadline,
        fafsa_code: response.fafsa_code,
        essay_required: response.essay_required,
        letters_of_rec_required: response.letters_of_rec_required,
        test_optional: response.test_optional,
        campus_visit_url: response.campus_visit_url,
        top_majors: response.top_majors,
        enrollment: response.enrollment,
        school_type: response.school_type,
        setting: response.setting,
        early_action_deadline: response.early_action_deadline,
        early_decision_deadline: response.early_decision_deadline,
        notes: response.notes
      };
      
      // Update the application record with fetched info
      await updateMutation.mutateAsync({
        id: app.id,
        data: {
          application_deadline: response.application_deadline || app.application_deadline,
          application_fee: response.application_fee || app.application_fee,
          application_url: response.application_url || app.application_url,
          payment_portal_url: response.payment_portal_url || app.payment_portal_url,
          platform: response.platform || app.platform,
          notes: JSON.stringify(universityInfo)
        }
      });
      
      toast.success(`Updated ${app.university_name} with latest info!`);
    } catch (error) {
      console.error('Failed to fetch university info:', error);
      toast.error('Failed to fetch university information');
    } finally {
      setFetchingInfoForId(null);
    }
  };

  // Parse stored university info from notes
  const parseStoredInfo = (notes) => {
    if (!notes) return null;
    try {
      const parsed = JSON.parse(notes);
      // Check if it has university info keys
      if (parsed.acceptance_rate || parsed.sat_range || parsed.in_state_tuition || parsed.fafsa_code) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'accepted': return 'bg-green-100 text-green-800';
      case 'submitted': return 'bg-blue-100 text-blue-800';
      case 'in_progress': return 'bg-yellow-100 text-yellow-800';
      case 'rejected': return 'bg-red-100 text-red-800';
      case 'waitlisted': return 'bg-orange-100 text-orange-800';
      case 'deferred': return 'bg-purple-100 text-purple-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  // Check if any applications use Common App
  const hasCommonAppSchools = applications.some(app => app.platform === 'commonapp');

  return (
    <div className="space-y-4">
      {/* Common App Profile - Show if any schools use it */}
      {hasCommonAppSchools && (
        <CommonAppProfileEditor organizationId={organizationId} />
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <GraduationCap className="w-5 h-5 text-blue-600" />
              University Applications
            </CardTitle>
          <div className="flex gap-2">
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                onChange={handleUploadUniversityInfo}
                className="hidden"
                disabled={isUploading}
              />
              <Button size="sm" variant="outline" asChild disabled={isUploading}>
                <span>
                  {isUploading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-1" />
                  )}
                  {isUploading ? 'Processing...' : 'Upload Letter'}
                </span>
              </Button>
            </label>
            <Button size="sm" onClick={() => setIsAdding(!isAdding)}>
              {isAdding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4 mr-1" />}
              {isAdding ? 'Cancel' : 'Add University'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isAdding && (
          <div className="p-4 bg-slate-50 rounded-lg space-y-3">
            <div>
              <Label className="text-sm">University Name</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g., University of Tennessee"
                  value={newApp.university_name}
                  onChange={(e) => setNewApp({...newApp, university_name: e.target.value})}
                  className="flex-1"
                />
                <Button 
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleAIGenerate}
                  disabled={!newApp.university_name || isGenerating}
                  className="gap-1"
                >
                  <Sparkles className="w-3 h-3" />
                  {isGenerating ? 'Generating...' : 'AI Fill'}
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Application Type</Label>
                <Select value={newApp.application_type} onValueChange={(v) => setNewApp({...newApp, application_type: v})}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="early_decision">Early Decision</SelectItem>
                    <SelectItem value="early_action">Early Action</SelectItem>
                    <SelectItem value="regular_decision">Regular Decision</SelectItem>
                    <SelectItem value="rolling">Rolling Admission</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm">Platform</Label>
                <Select value={newApp.platform} onValueChange={(v) => setNewApp({...newApp, platform: v})}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORMS.map(p => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Application Deadline</Label>
                <Input
                  type="date"
                  value={newApp.application_deadline}
                  onChange={(e) => setNewApp({...newApp, application_deadline: e.target.value})}
                />
              </div>
              <div>
                <Label className="text-sm">Major</Label>
                <Input
                  placeholder="e.g., Computer Science"
                  value={newApp.major_applied}
                  onChange={(e) => setNewApp({...newApp, major_applied: e.target.value})}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Application Fee</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={newApp.application_fee}
                  onChange={(e) => setNewApp({...newApp, application_fee: parseFloat(e.target.value) || 0})}
                />
              </div>
              <div>
                <Label className="text-sm">Application URL</Label>
                <Input
                  placeholder="https://..."
                  value={newApp.application_url}
                  onChange={(e) => setNewApp({...newApp, application_url: e.target.value})}
                />
              </div>
            </div>
            <div>
              <Label className="text-sm">Payment Portal URL</Label>
              <Input
                placeholder="https://... (if different from application URL)"
                value={newApp.payment_portal_url}
                onChange={(e) => setNewApp({...newApp, payment_portal_url: e.target.value})}
              />
            </div>
            {/* Parsed University Info Display */}
            {parsedUniversityInfo && (
              <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="font-semibold text-blue-900 mb-3 flex items-center gap-2">
                  <Sparkles className="w-4 h-4" />
                  University Details (AI-Parsed)
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  {parsedUniversityInfo.acceptance_rate && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">Acceptance Rate</span>
                      <p className="font-medium">{parsedUniversityInfo.acceptance_rate}%</p>
                    </div>
                  )}
                  {parsedUniversityInfo.avg_gpa && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">Avg GPA</span>
                      <p className="font-medium">{parsedUniversityInfo.avg_gpa}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.sat_range && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">SAT Range</span>
                      <p className="font-medium">{parsedUniversityInfo.sat_range}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.act_range && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">ACT Range</span>
                      <p className="font-medium">{parsedUniversityInfo.act_range}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.in_state_tuition && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">In-State Tuition</span>
                      <p className="font-medium">${parsedUniversityInfo.in_state_tuition.toLocaleString()}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.out_of_state_tuition && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">Out-of-State Tuition</span>
                      <p className="font-medium">${parsedUniversityInfo.out_of_state_tuition.toLocaleString()}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.room_and_board && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">Room & Board</span>
                      <p className="font-medium">${parsedUniversityInfo.room_and_board.toLocaleString()}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.fafsa_code && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">FAFSA Code</span>
                      <p className="font-medium">{parsedUniversityInfo.fafsa_code}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.enrollment && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">Enrollment</span>
                      <p className="font-medium">{parsedUniversityInfo.enrollment.toLocaleString()}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.school_type && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">Type</span>
                      <p className="font-medium capitalize">{parsedUniversityInfo.school_type}</p>
                    </div>
                  )}
                  {parsedUniversityInfo.setting && (
                    <div className="bg-white p-2 rounded border">
                      <span className="text-slate-500 text-xs">Setting</span>
                      <p className="font-medium capitalize">{parsedUniversityInfo.setting}</p>
                    </div>
                  )}
                </div>
                
                {/* Requirements */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {parsedUniversityInfo.test_optional !== undefined && (
                    <Badge variant="outline" className={parsedUniversityInfo.test_optional ? 'bg-green-100 text-green-800' : 'bg-slate-100'}>
                      {parsedUniversityInfo.test_optional ? '✓ Test Optional' : 'Tests Required'}
                    </Badge>
                  )}
                  {parsedUniversityInfo.essay_required !== undefined && (
                    <Badge variant="outline" className={parsedUniversityInfo.essay_required ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}>
                      {parsedUniversityInfo.essay_required ? 'Essay Required' : 'No Essay'}
                    </Badge>
                  )}
                  {parsedUniversityInfo.letters_of_rec_required !== undefined && (
                    <Badge variant="outline">
                      {parsedUniversityInfo.letters_of_rec_required > 0 
                        ? `${parsedUniversityInfo.letters_of_rec_required} Rec Letters` 
                        : 'No Rec Letters'}
                    </Badge>
                  )}
                </div>

                {/* Deadlines */}
                {(parsedUniversityInfo.early_action_deadline || parsedUniversityInfo.early_decision_deadline || parsedUniversityInfo.financial_aid_deadline) && (
                  <div className="mt-3 pt-3 border-t border-blue-200">
                    <p className="text-xs text-slate-500 mb-2">Other Deadlines:</p>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {parsedUniversityInfo.early_action_deadline && (
                        <span className="bg-white px-2 py-1 rounded border">
                          EA: {parsedUniversityInfo.early_action_deadline}
                        </span>
                      )}
                      {parsedUniversityInfo.early_decision_deadline && (
                        <span className="bg-white px-2 py-1 rounded border">
                          ED: {parsedUniversityInfo.early_decision_deadline}
                        </span>
                      )}
                      {parsedUniversityInfo.financial_aid_deadline && (
                        <span className="bg-white px-2 py-1 rounded border">
                          FAFSA Priority: {parsedUniversityInfo.financial_aid_deadline}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Top Majors */}
                {parsedUniversityInfo.top_majors?.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-blue-200">
                    <p className="text-xs text-slate-500 mb-2">Popular Majors:</p>
                    <div className="flex flex-wrap gap-1">
                      {parsedUniversityInfo.top_majors.slice(0, 8).map((major, idx) => (
                        <Badge key={idx} variant="outline" className="text-xs bg-white">
                          {major}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Campus Visit Link */}
                {parsedUniversityInfo.campus_visit_url && (
                  <div className="mt-3">
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="gap-1"
                      onClick={() => window.open(parsedUniversityInfo.campus_visit_url, '_blank')}
                    >
                      <ExternalLink className="w-3 h-3" />
                      Schedule Campus Visit
                    </Button>
                  </div>
                )}

                {/* Notes */}
                {parsedUniversityInfo.notes && (
                  <div className="mt-3 pt-3 border-t border-blue-200 text-xs text-slate-600">
                    <p className="font-medium text-slate-700">Notes:</p>
                    <p>{parsedUniversityInfo.notes}</p>
                  </div>
                )}
              </div>
            )}

            <Button 
              onClick={() => {
                createMutation.mutate({
                  ...newApp,
                  // Include parsed info in notes for reference
                  notes: parsedUniversityInfo ? JSON.stringify(parsedUniversityInfo) : ''
                });
                setParsedUniversityInfo(null);
              }} 
              disabled={!newApp.university_name || createMutation.isPending} 
              className="w-full"
            >
              Add Application
            </Button>
          </div>
        )}

        {applications
          .sort((a, b) => a.university_name.localeCompare(b.university_name))
          .map((app) => {
          const platform = PLATFORMS.find(p => p.value === app.platform);
          const deadlineDate = app.application_deadline ? new Date(app.application_deadline) : null;
          const isValidDate = deadlineDate && !isNaN(deadlineDate.getTime());
          const daysUntil = isValidDate ? Math.ceil((deadlineDate - new Date()) / (1000 * 60 * 60 * 24)) : null;
          const isOverdue = daysUntil !== null && daysUntil < 0;
          const isUrgent = daysUntil !== null && daysUntil >= 0 && daysUntil <= 14;
          const storedInfo = parseStoredInfo(app.notes);
          const hasInfo = !!storedInfo;
          const isFetching = fetchingInfoForId === app.id;

          return (
            <Card key={app.id} className="border-l-4 border-l-blue-600 cursor-pointer hover:shadow-md transition-shadow" onClick={() => setSelectedApp(app)}>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                      {app.university_name}
                      <ChevronRight className="w-4 h-4 text-slate-400" />
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="outline" className="text-xs">
                        {app.application_type.replace(/_/g, ' ')}
                      </Badge>
                      {app.major_applied && (
                        <span className="text-xs text-slate-600">• {app.major_applied}</span>
                      )}
                    </div>
                  </div>
                  <Badge className={getStatusColor(app.status)}>
                    {app.status.replace(/_/g, ' ')}
                  </Badge>
                </div>

                {/* Quick Stats Row - Show if we have stored info */}
                {hasInfo && (
                  <div className="grid grid-cols-3 md:grid-cols-5 gap-2 text-xs bg-slate-50 p-2 rounded-lg">
                    {storedInfo.acceptance_rate && (
                      <div className="text-center">
                        <p className="text-slate-500">Accept Rate</p>
                        <p className="font-semibold">{storedInfo.acceptance_rate}%</p>
                      </div>
                    )}
                    {storedInfo.avg_gpa && (
                      <div className="text-center">
                        <p className="text-slate-500">Avg GPA</p>
                        <p className="font-semibold">{storedInfo.avg_gpa}</p>
                      </div>
                    )}
                    {storedInfo.sat_range && (
                      <div className="text-center">
                        <p className="text-slate-500">SAT</p>
                        <p className="font-semibold">{storedInfo.sat_range}</p>
                      </div>
                    )}
                    {storedInfo.out_of_state_tuition && (
                      <div className="text-center">
                        <p className="text-slate-500">Tuition</p>
                        <p className="font-semibold">${(storedInfo.out_of_state_tuition / 1000).toFixed(0)}k</p>
                      </div>
                    )}
                    {storedInfo.fafsa_code && (
                      <div className="text-center">
                        <p className="text-slate-500">FAFSA</p>
                        <p className="font-semibold">{storedInfo.fafsa_code}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Requirements badges */}
                {hasInfo && (
                  <div className="flex flex-wrap gap-1">
                    {storedInfo.test_optional !== undefined && (
                      <Badge variant="outline" className={`text-xs ${storedInfo.test_optional ? 'bg-green-50 text-green-700' : ''}`}>
                        {storedInfo.test_optional ? '✓ Test Optional' : 'Tests Required'}
                      </Badge>
                    )}
                    {storedInfo.essay_required !== undefined && (
                      <Badge variant="outline" className="text-xs">
                        {storedInfo.essay_required ? 'Essay Required' : 'No Essay'}
                      </Badge>
                    )}
                    {storedInfo.letters_of_rec_required !== undefined && storedInfo.letters_of_rec_required > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {storedInfo.letters_of_rec_required} Rec Letters
                      </Badge>
                    )}
                    {storedInfo.school_type && (
                      <Badge variant="outline" className="text-xs capitalize">
                        {storedInfo.school_type}
                      </Badge>
                    )}
                  </div>
                )}

                {/* Fetch Info Button - Show if no info stored */}
                {!hasInfo && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1 h-7 text-xs border-dashed"
                    onClick={(e) => {
                      e.stopPropagation();
                      fetchUniversityInfo(app);
                    }}
                    disabled={isFetching}
                  >
                    {isFetching ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Fetching Info...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3 h-3" />
                        Fetch University Info
                      </>
                    )}
                  </Button>
                )}

                <div className="grid grid-cols-2 gap-2 text-xs">
                  {app.application_deadline && !isNaN(new Date(app.application_deadline).getTime()) && (
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-slate-400" />
                      <span className={isOverdue ? 'text-red-600 font-semibold' : isUrgent ? 'text-orange-600' : ''}>
                        {format(new Date(app.application_deadline), 'MMM dd, yyyy')}
                        {daysUntil !== null && (
                          <span className="ml-1">
                            {isOverdue ? `(${Math.abs(daysUntil)}d overdue)` : `(${daysUntil}d left)`}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  {app.application_fee > 0 && (
                    <div className="flex items-center gap-1">
                      <DollarSign className="w-3 h-3 text-slate-400" />
                      <span>${app.application_fee.toFixed(2)}</span>
                      <Badge className={`text-xs ml-1 ${
                        app.fee_payment_status === 'paid' ? 'bg-green-100 text-green-800' :
                        app.fee_waiver_applied || app.fee_payment_status === 'waived' ? 'bg-blue-100 text-blue-800' :
                        'bg-orange-100 text-orange-800'
                      }`}>
                        {app.fee_waiver_applied ? 'Waiver' : app.fee_payment_status}
                      </Badge>
                    </div>
                  )}
                </div>

                <div className="flex gap-2 mt-2">
                  {app.application_url && (
                    <Button size="sm" variant="outline" className="flex-1 gap-1 h-7 text-xs" onClick={(e) => { e.stopPropagation(); window.open(app.application_url, '_blank'); }}>
                      <ExternalLink className="w-3 h-3" />
                      Apply
                    </Button>
                  )}
                  {!app.application_url && platform?.url && (
                    <Button size="sm" variant="outline" className="flex-1 gap-1 h-7 text-xs" onClick={(e) => { e.stopPropagation(); window.open(platform.url, '_blank'); }}>
                      <ExternalLink className="w-3 h-3" />
                      {platform.label}
                    </Button>
                  )}
                  {app.application_fee > 0 && app.fee_payment_status === 'pending' && (app.payment_portal_url || app.application_url) && (
                    <Button 
                      size="sm" 
                      className="flex-1 gap-1 h-7 text-xs bg-green-600 hover:bg-green-700"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(app.payment_portal_url || app.application_url, '_blank');
                        updateMutation.mutate({ 
                          id: app.id, 
                          data: { 
                            fee_payment_status: 'paid',
                            fee_payment_date: new Date().toISOString()
                          } 
                        });
                      }}
                    >
                      <CreditCard className="w-3 h-3" />
                      Pay Fee
                    </Button>
                  )}
                  {hasInfo && storedInfo.campus_visit_url && (
                    <Button size="sm" variant="outline" className="gap-1 h-7 text-xs" onClick={(e) => { e.stopPropagation(); window.open(storedInfo.campus_visit_url, '_blank'); }}>
                      <ExternalLink className="w-3 h-3" />
                      Visit
                    </Button>
                  )}
                </div>

                <div className="space-y-2 pt-2 border-t" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={app.status === 'submitted' || app.status === 'accepted' || app.status === 'rejected' || app.status === 'waitlisted' || app.status === 'deferred'}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          updateMutation.mutate({ 
                            id: app.id, 
                            data: { 
                              status: 'submitted',
                              submission_date: new Date().toISOString()
                            } 
                          });
                        } else {
                          updateMutation.mutate({ id: app.id, data: { status: 'planning' } });
                        }
                      }}
                    />
                    <Label className="text-sm font-medium cursor-pointer">
                      Applied {app.status === 'submitted' && app.submission_date && (
                        <span className="text-xs text-slate-500 ml-1">
                          ({format(new Date(app.submission_date), 'MMM dd, yyyy')})
                        </span>
                      )}
                    </Label>
                  </div>
                  <Select 
                    value={app.status} 
                    onValueChange={(v) => updateMutation.mutate({ id: app.id, data: { status: v } })}
                  >
                    <SelectTrigger className="h-8 text-xs flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="planning">Planning</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                      <SelectItem value="submitted">Submitted</SelectItem>
                      <SelectItem value="accepted">Accepted</SelectItem>
                      <SelectItem value="rejected">Rejected</SelectItem>
                      <SelectItem value="waitlisted">Waitlisted</SelectItem>
                      <SelectItem value="deferred">Deferred</SelectItem>
                    </SelectContent>
                  </Select>
                  {hasInfo && (
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      className="h-8 px-2"
                      onClick={(e) => { e.stopPropagation(); fetchUniversityInfo(app); }}
                      disabled={isFetching}
                      title="Refresh university info"
                    >
                      {isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(app.id); }}>
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}

        <UniversityDetailDialog
          application={selectedApp}
          open={!!selectedApp}
          onOpenChange={(open) => !open && setSelectedApp(null)}
          studentInterests={organization?.extracurricular_activities || []}
        />
      </CardContent>
    </Card>
    </div>
  );
}