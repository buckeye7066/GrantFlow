import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  ChevronLeft, 
  ChevronRight, 
  Save, 
  CheckCircle2, 
  Loader2,
  HelpCircle,
  FileText,
  X,
  Sparkles,
  Shield,
  Wand2,
  ChevronDown,
  ChevronUp,
  GripVertical
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

import BasicInfoStep from './steps/BasicInfoStep';
import ProjectNarrativeStep from './steps/ProjectNarrativeStep';
import BudgetStep from './steps/BudgetStep';
import OrganizationInfoStep from './steps/OrganizationInfoStep';
import AttachmentsStep from './steps/AttachmentsStep';
import ReviewStep from './steps/ReviewStep';
import ContextHelp from './ContextHelp';
import DocumentManager from '../documents/DocumentManager';
import ComplianceChecker from './ComplianceChecker';

export default function ApplicationWizard({ grant, organization, onComplete, onClose }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState({});
  const [draftId, setDraftId] = useState(null);
  const [showHelp, setShowHelp] = useState(true);
  const [validationErrors, setValidationErrors] = useState({});
  const [isAutoFilling, setIsAutoFilling] = useState(false);
  const [showComplianceCheck, setShowComplianceCheck] = useState(false);
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const steps = [
    {
      id: 'basic',
      title: 'Basic Information',
      description: 'Grant title, deadlines, and key details',
      component: BasicInfoStep,
      help: 'Start by reviewing the basic grant information. We\'ve pre-filled what we know from the grant listing.',
      requiredFields: ['project_title', 'requested_amount']
    },
    {
      id: 'narrative',
      title: 'Project Narrative',
      description: 'Problem statement, goals, and methods',
      component: ProjectNarrativeStep,
      help: 'Describe your project clearly and concisely. Use the AI Draft buttons to generate initial responses.',
      requiredFields: ['problem_statement', 'project_goals']
    },
    {
      id: 'budget',
      title: 'Budget & Finances',
      description: 'Detailed budget breakdown',
      component: BudgetStep,
      help: 'Provide a detailed budget. Include all costs and justify major expenses.',
      requiredFields: ['budget_items']
    },
    {
      id: 'organization',
      title: 'Organization Details',
      description: 'Your organization\'s information',
      component: OrganizationInfoStep,
      help: 'We\'ve pre-filled your organization details. Review and add any grant-specific information.',
      requiredFields: ['organization_name']
    },
    {
      id: 'attachments',
      title: 'Supporting Documents',
      description: 'Required attachments and forms',
      component: AttachmentsStep,
      help: 'Upload all required documents. AI will suggest what you need based on grant requirements.',
      requiredFields: []
    },
    {
      id: 'review',
      title: 'Review & Submit',
      description: 'Final review before submission',
      component: ReviewStep,
      help: 'Review your complete application. Run compliance check to catch any issues.',
      requiredFields: []
    }
  ];

  const { data: existingDraft } = useQuery({
    queryKey: ['applicationDraft', grant?.id],
    queryFn: async () => {
      const drafts = await base44.entities.ApplicationDraft.filter({
        grant_id: grant.id,
        status: 'in_progress'
      }, '-updated_date', 1);
      return drafts[0];
    },
    enabled: !!grant?.id
  });

  // Load existing draft only once on initial mount
  const [draftLoaded, setDraftLoaded] = useState(false);
  
  useEffect(() => {
    if (draftLoaded) return; // Don't reload after initial load
    
    if (existingDraft) {
      setDraftId(existingDraft.id);
      setFormData(existingDraft.form_data || {});
      setCurrentStep(existingDraft.current_step || 0);
      setDraftLoaded(true);
      
      toast({
        title: '📝 Draft Loaded',
        description: 'Your previous progress has been restored',
      });
    } else if (grant && organization) {
      setDraftLoaded(true);
      handleAutoFill();
    }
  }, [existingDraft, grant, organization, draftLoaded]);

  const saveDraftMutation = useMutation({
    mutationFn: async (data) => {
      if (draftId) {
        return await base44.entities.ApplicationDraft.update(draftId, data);
      } else {
        const draft = await base44.entities.ApplicationDraft.create(data);
        setDraftId(draft.id);
        return draft;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applicationDraft'] });
    }
  });

  useEffect(() => {
    if (Object.keys(formData).length > 0 && grant?.id) {
      const timeoutId = setTimeout(() => {
        handleSaveDraft(true);
      }, 3000);
      return () => clearTimeout(timeoutId);
    }
  }, [formData, grant]);

  const handleAutoFill = async () => {
    if (!organization || !grant) return;

    setIsAutoFilling(true);

    try {
      toast({
        title: '🤖 Auto-Filling Form',
        description: 'Extracting data from organization profile...',
      });

      const response = await base44.functions.invoke('autoFillApplicationForm', {
        organization_id: organization.id,
        grant_id: grant.id,
        form_fields: [
          'project_title',
          'applicant_legal_name',
          'applicant_ein',
          'applicant_address',
          'applicant_phone',
          'applicant_website',
          'organization_mission',
          'organization_history',
          'past_relevant_projects',
          'organizational_capacity',
          'target_population',
          'geographic_service_area',
          'annual_operating_budget',
          'staff_size'
        ]
      });

      if (response.data.success) {
        const preFilled = response.data.pre_filled_fields;
        
        setFormData(prev => ({
          ...prev,
          grant_id: grant.id,
          grant_title: grant.title,
          funder_name: grant.funder,
          deadline: grant.deadline,
          requested_amount: grant.award_ceiling || '',
          ...preFilled
        }));

        const fieldCount = Object.keys(preFilled).length;
        const missing = response.data.missing_data || [];

        toast({
          title: '✅ Form Auto-Filled',
          description: `${fieldCount} fields populated. ${missing.length > 0 ? `${missing.length} fields need manual entry.` : 'All data extracted!'}`,
          duration: 6000,
        });
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Auto-Fill Failed',
        description: error.message,
      });
    } finally {
      setIsAutoFilling(false);
    }
  };

  const handleSaveDraft = (silent = false) => {
    const draftData = {
      grant_id: grant.id,
      organization_id: organization.id,
      current_step: currentStep,
      form_data: formData,
      status: 'in_progress',
      completion_percentage: calculateCompletionPercentage(),
      last_saved_at: new Date().toISOString()
    };

    saveDraftMutation.mutate(draftData);
    
    if (!silent) {
      toast({
        title: '✅ Draft Saved',
        description: 'You can continue later from where you left off',
      });
    }
  };

  const calculateCompletionPercentage = () => {
    let completed = 0;
    let total = 0;

    steps.forEach(step => {
      step.requiredFields.forEach(field => {
        total++;
        if (field === 'budget_items') {
          if (formData[field] && Array.isArray(formData[field]) && formData[field].length > 0) {
            completed++;
          }
        } else if (formData[field] && formData[field] !== '') {
          completed++;
        }
      });
    });

    return total > 0 ? Math.round((completed / total) * 100) : 0;
  };

  const validateStep = (stepIndex) => {
    const step = steps[stepIndex];
    const errors = {};
    
    step.requiredFields.forEach(field => {
      if (field === 'budget_items') {
        if (!formData[field] || !Array.isArray(formData[field]) || formData[field].length === 0) {
          errors[field] = 'At least one budget item is required';
        }
      } else if (!formData[field] || formData[field] === '') {
        errors[field] = 'This field is required';
      }
    });

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleNext = async () => {
    if (validateStep(currentStep)) {
      const nextStep = Math.min(currentStep + 1, steps.length - 1);
      setCurrentStep(nextStep);
      setValidationErrors({});
      
      // Save draft with new step immediately
      const draftData = {
        grant_id: grant.id,
        organization_id: organization.id,
        current_step: nextStep,
        form_data: formData,
        status: 'in_progress',
        completion_percentage: calculateCompletionPercentage(),
        last_saved_at: new Date().toISOString()
      };
      saveDraftMutation.mutate(draftData);
    } else {
      toast({
        variant: 'destructive',
        title: 'Required Fields Missing',
        description: 'Please fill in all required fields before continuing',
      });
    }
  };

  const handlePrevious = async () => {
    const prevStep = Math.max(currentStep - 1, 0);
    setCurrentStep(prevStep);
    setValidationErrors({});
    
    // Save draft with new step immediately
    const draftData = {
      grant_id: grant.id,
      organization_id: organization.id,
      current_step: prevStep,
      form_data: formData,
      status: 'in_progress',
      completion_percentage: calculateCompletionPercentage(),
      last_saved_at: new Date().toISOString()
    };
    saveDraftMutation.mutate(draftData);
  };

  const handleStepClick = (stepIndex) => {
    if (stepIndex <= currentStep) {
      setCurrentStep(stepIndex);
      setValidationErrors({});
    }
  };

  const handleDataChange = (stepData) => {
    setFormData(prev => ({ ...prev, ...stepData }));
  };

  const handleMouseDown = (e) => {
    if (e.target.closest('button, input, textarea, select')) return;
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y
    });
  };

  const handleMouseMove = (e) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragOffset.x,
        y: e.clientY - dragOffset.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragOffset]);

  const handleComplete = async () => {
    if (draftId) {
      await base44.entities.ApplicationDraft.update(draftId, {
        status: 'completed',
        completion_percentage: 100,
        completed_at: new Date().toISOString()
      });
    }

    toast({
      title: '🎉 Application Complete!',
      description: 'Your application is ready for submission',
    });

    if (onComplete) {
      onComplete(formData);
    }
  };

  const CurrentStepComponent = steps[currentStep].component;
  const completionPercentage = calculateCompletionPercentage();
  const isReviewStep = currentStep === steps.length - 1;

  return (
    <>
      {/* Main Wizard Modal */}
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg max-w-6xl w-full my-8 max-h-[90vh] overflow-y-auto flex flex-col">
          <div className={`bg-white border-b border-slate-200 rounded-t-lg z-10 ${!isMinimized ? 'sticky top-0' : ''}`}>
            {isMinimized ? (
              <div className="p-2 flex items-center justify-between bg-slate-50">
                <button
                  onClick={() => setIsMinimized(false)}
                  className="flex items-center gap-2 hover:bg-slate-100 rounded px-2 py-1 transition-colors text-sm"
                >
                  <Sparkles className="w-4 h-4 text-purple-600" />
                  <span className="font-medium text-slate-700">Show Header</span>
                  <ChevronDown className="w-3 h-3 text-slate-500" />
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  title="Close wizard"
                  className="h-7 w-7"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <h2 className="text-2xl font-bold text-slate-900 mb-2 flex items-center gap-2">
                      <Sparkles className="w-7 h-7 text-purple-600" />
                      AI-Powered Application Wizard
                    </h2>
                    <p className="text-slate-600">
                      {grant?.title} • {organization?.name}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAutoFill}
                      disabled={isAutoFilling}
                      className="border-purple-300 text-purple-700"
                    >
                      {isAutoFilling ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Auto-Filling...
                        </>
                      ) : (
                        <>
                          <Wand2 className="w-4 h-4 mr-2" />
                          Auto-Fill Form
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowHelp(!showHelp)}
                      title="Toggle help panel"
                    >
                      <HelpCircle className="w-5 h-5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsMinimized(true)}
                      title="Minimize header"
                    >
                      <ChevronUp className="w-5 h-5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onClose}
                      title="Close wizard"
                    >
                      <X className="w-5 h-5" />
                    </Button>
                  </div>
                </div>

                  <div className="flex items-center gap-2 mt-4 overflow-x-auto pb-2">
                    {steps.map((step, index) => (
                      <button
                        key={step.id}
                        onClick={() => handleStepClick(index)}
                        disabled={index > currentStep}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg whitespace-nowrap transition-all ${
                          index === currentStep
                            ? 'bg-blue-600 text-white shadow-lg'
                            : index < currentStep
                            ? 'bg-green-100 text-green-800 hover:bg-green-200'
                            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                        }`}
                      >
                        {index < currentStep ? (
                          <CheckCircle2 className="w-4 h-4" />
                        ) : (
                          <span className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-sm">
                            {index + 1}
                          </span>
                        )}
                        <span className="font-medium">{step.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

          <div className="p-6">
            <div className="grid lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="w-5 h-5 text-blue-600" />
                      {steps[currentStep].title}
                    </CardTitle>
                    <p className="text-sm text-slate-600 mt-1">
                      {steps[currentStep].description}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <CurrentStepComponent
                      data={formData}
                      onChange={handleDataChange}
                      grant={grant}
                      organization={organization}
                      errors={validationErrors}
                      formData={formData}
                    />
                  </CardContent>
                </Card>

                {isReviewStep && (
                  <div className="mt-6">
                    <ComplianceChecker
                      grant={grant}
                      organization={organization}
                      applicationData={formData}
                    />
                  </div>
                )}
              </div>

              {showHelp && (
                <div className="lg:col-span-1">
                  <div className="sticky top-24 space-y-4">
                    <ContextHelp
                      stepId={steps[currentStep].id}
                      grant={grant}
                      organization={organization}
                    />
                    
                    <DocumentManager
                      organizationId={organization.id}
                      grantId={grant.id}
                      mode="compact"
                    />

                    <Card className="bg-gradient-to-br from-purple-50 to-pink-50 border-purple-200">
                      <CardHeader>
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-purple-600" />
                          AI Features Available
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2 text-xs">
                        <div className="flex items-start gap-2">
                          <Wand2 className="w-3 h-3 text-purple-600 mt-0.5" />
                          <span className="text-slate-700">
                            <strong>Auto-Fill:</strong> Extract org data into forms
                          </span>
                        </div>
                        <div className="flex items-start gap-2">
                          <Sparkles className="w-3 h-3 text-blue-600 mt-0.5" />
                          <span className="text-slate-700">
                            <strong>AI Draft:</strong> Generate narrative responses
                          </span>
                        </div>
                        <div className="flex items-start gap-2">
                          <Shield className="w-3 h-3 text-green-600 mt-0.5" />
                          <span className="text-slate-700">
                            <strong>Compliance:</strong> Pre-submission review
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="sticky bottom-0 bg-white border-t border-slate-200 p-6 rounded-b-lg">
            <div className="flex items-center justify-between">
              <Button
                onClick={handlePrevious}
                disabled={currentStep === 0}
                variant="outline"
              >
                <ChevronLeft className="w-4 h-4 mr-2" />
                Previous
              </Button>

              <div className="flex gap-2">
                <Button
                  onClick={() => handleSaveDraft(false)}
                  variant="outline"
                  disabled={saveDraftMutation.isPending}
                >
                  <Save className="w-4 h-4 mr-2" />
                  Save Draft
                </Button>

                {currentStep === steps.length - 1 ? (
                  <Button
                    onClick={handleComplete}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    Complete Application
                  </Button>
                ) : (
                  <Button
                    onClick={handleNext}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    Next Step
                    <ChevronRight className="w-4 h-4 ml-2" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}