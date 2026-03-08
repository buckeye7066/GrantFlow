
import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowLeft, Edit, Trash2, Star, CheckSquare, Sparkles, DollarSign, ArrowRightSquare, Shield, Brain, Clock, FileText } from 'lucide-react';
import GrantOverview from '../components/grants/GrantOverview';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Checklist from '../components/workflow/Checklist';
import TimeTrackingTab from '../components/billing/TimeTrackingTab';
import BudgetTab from '../components/budgets/BudgetTab';
import ComplianceTab from '../components/grants/ComplianceTab';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import GrantForm from '../components/grants/GrantForm';
import GrantPortalAssistant from '../components/proposals/GrantPortalAssistant';
import AIApplicationAssistant from '../components/proposals/AIApplicationAssistant';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import ProposalCoachPanel from '../components/proposals/ProposalCoachPanel';
import { useToast } from "@/components/ui/use-toast";
import { installClickTracer } from '../components/shared/clickTracer';
import SubmissionAssistant from '../components/proposals/SubmissionAssistant';
import PortalAssistantPanel from '../components/ai/PortalAssistantPanel';
import PrintableApplicationPanel from '../components/ai/PrintableApplicationPanel';
import { createLogger } from '@/utils/logger';
import { apiFetch } from "@/api/client"

const toMessage = (e) => (e instanceof Error ? e.message : String(e ?? ''));

const FIELD_NAME_MAP = {
  mission: "Mission Statement",
  primary_goal: "Primary Goal (Q1)",
  target_population: "Target Population (Q2)",
  geographic_focus: "Geographic Focus (Q3)",
  funding_amount_needed: "Funding Need (Q4)",
  timeline: "Timeline (Q5)",
  past_experience: "Track Record (Q6)",
  unique_qualities: "Unique Qualities (Q7)",
  collaboration_partners: "Collaboration Partners (Q8)",
  sustainability_plan: "Competitive Advantage (Q9)",
  barriers_faced: "Organizational Capacity (Q10)",
  annual_budget: "Annual Budget",
  staff_count: "Staff Count"
};

export default function GrantDetail() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const log = React.useMemo(() => createLogger('GrantDetail'), []);
  const urlParams = new URLSearchParams(window.location.search);
  const grantId = urlParams.get('id');
  const initialTab = urlParams.get('tab') || 'coach';

  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isPortalAssistantOpen, setIsPortalAssistantOpen] = useState(false);
  const [isApplicationAssistantOpen, setIsApplicationAssistantOpen] = useState(false);
  const [isSubmissionAssistantOpen, setIsSubmissionAssistantOpen] = useState(false);
  const [isPrintableAppOpen, setIsPrintableAppOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab);
  
  // Install click tracer for debugging
  useEffect(() => {
    installClickTracer();
  }, []);

  // Listen for portal assistant switch event
  useEffect(() => {
    const handleOpenPortalAssistant = (event) => {
      const { grant: eventGrant, organization: eventOrg } = event.detail;
      if (eventGrant && eventOrg) {
        setIsApplicationAssistantOpen(false); // Close application assistant if open
        setIsPortalAssistantOpen(true);
        toast({
          title: "Portal Assistant Activated",
          description: "Switched to Portal Assistant based on external request."
        });
      }
    };

    window.addEventListener('openPortalAssistant', handleOpenPortalAssistant);
    return () => window.removeEventListener('openPortalAssistant', handleOpenPortalAssistant);
  }, [toast]);
  
  const { data: grant, isLoading: isLoadingGrant, isError: isErrorGrant, error: grantError } = useQuery({
    queryKey: ['grant', grantId],
    queryFn: () => {
        if (!grantId) return null;
        return base44.entities.Grant.get(grantId);
    },
    enabled: !!grantId,
    refetchInterval: (query) => {
      const grantData = query.state?.data;
      // Only refetch if actively running, and stop after 2 minutes
      if (grantData && ['queued', 'running'].includes(grantData.ai_status)) {
        const updatedAt = grantData.ai_updated_at ? new Date(grantData.ai_updated_at) : new Date();
        const elapsed = Date.now() - updatedAt.getTime();
        // Stop refetching after 2 minutes to prevent infinite loops
        if (elapsed > 120000) {
          console.warn('[GrantDetail] Stopping refetch - timeout');
          return false;
        }
        return 2000;
      }
      return false;
    },
  });

  const { data: organization, isLoading: isLoadingOrg, isError: isErrorOrg, error: orgError } = useQuery({
    queryKey: ['organization', grant?.organization_id],
    queryFn: () => base44.entities.Organization.get(grant.organization_id),
    enabled: !!grant?.organization_id,
  });
  
  const { data: existingChecklistItems = [] } = useQuery({
    queryKey: ['checklistItems', grantId],
    queryFn: () => base44.entities.ChecklistItem.filter({ grant_id: grantId }),
    enabled: !!grantId,
  });

  const updateGrantMutation = useMutation({
    mutationFn: (updatedData) => base44.entities.Grant.update(grantId, updatedData),
    onSuccess: (data) => {
      queryClient.setQueryData(['grant', grantId], data);
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      setIsEditing(false);
    },
  });

  const deleteGrantMutation = useMutation({
    mutationFn: () => base44.entities.Grant.delete(grantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      navigate(createPageUrl('Pipeline'));
    },
  });
  
  const analyzeGrantMutation = useMutation({
    mutationFn: async (payload) => {
      log.debug('calling analyzeGrant', {
        grantId: payload.grantId,
        title: payload.title?.substring(0, 50),
        hasDescription: !!payload.description,
        hasEligibility: !!payload.eligibility
      });
      
      try {
        // Client returns parsed JSON body: { success, analysis } (no .data wrapper)
        const body = await base44.functions.invoke('analyzeGrant', payload);
        log.debug('analyzeGrant response', {
          success: body?.success,
          hasAnalysis: !!body?.analysis
        });
        
        if (body && body.success === false) {
          console.error('[GrantDetail] Function returned error:', body);
          throw new Error(body.message || body.error || 'Analysis failed');
        }
        
        return body;
      } catch (error) {
        console.error('[GrantDetail] Function invocation failed:', {
          message: error.message,
          responseData: error.response?.data,
          status: error.response?.status
        });
        
        let errorMessage = error.message;
        if (error.response?.data) {
          const data = error.response.data;
          errorMessage = data.message || data.error || data.details || errorMessage;
        }
        
        const enhancedError = new Error(errorMessage);
        enhancedError.response = error.response;
        throw enhancedError;
      }
    },
    onSuccess: async (data) => {
        log.debug('analysis mutation succeeded; persisting results');
        
        try {
            // API returns { success, analysis }; client returns parsed JSON (no .data wrapper)
            const analysis = data?.analysis ?? data?.data?.analysis;
            
            if (!analysis || !analysis.analysis_markdown) {
                throw new Error('No analysis data in response or analysis_markdown missing.');
            }
            
            // Save the analysis to the grant
            await updateGrantMutation.mutateAsync({
                ai_summary: analysis.analysis_markdown,
                ai_status: 'ready',
                ai_updated_at: new Date().toISOString(),
                ai_error: null
            });
            
            log.debug('analysis saved to grant');
            
            // Force refetch the grant to get the updated AI summary
            queryClient.invalidateQueries({ queryKey: ['grant', grantId] });
            
            // Handle checklist items
            if (analysis.required_profile_fields?.length > 0 && organization) {
              const newItemsToCreate = [];
              const existingTitles = new Set(
                existingChecklistItems.filter(item => item.type === 'question').map(item => item.title)
              );
              
              for (const fieldName of analysis.required_profile_fields) {
                const isMissing = !organization[fieldName] || 
                  (Array.isArray(organization[fieldName]) && organization[fieldName].length === 0);
                const friendlyName = FIELD_NAME_MAP[fieldName] || fieldName.replace(/_/g, ' ');
                const itemTitle = `Please provide the organization's ${friendlyName}.`;

                if (isMissing && !existingTitles.has(itemTitle)) {
                  newItemsToCreate.push({
                    grant_id: grantId,
                    organization_id: grant.organization_id,
                    title: itemTitle,
                    type: 'question',
                    status: 'open',
                  });
                }
              }

              if (newItemsToCreate.length > 0) {
                 await base44.entities.ChecklistItem.bulkCreate(newItemsToCreate);
                 queryClient.invalidateQueries({ queryKey: ['checklistItems', grantId] });
                 toast({ 
                   title: "Checklist Updated", 
                   description: `${newItemsToCreate.length} action item(s) added.` 
                 });
              }
            }
            
            toast({ 
              title: "Analysis Complete", 
              description: "Grant analysis saved successfully." 
            });
        } catch (saveError) {
            console.error('[GrantDetail] Failed to save analysis or update checklist:', saveError);
            toast({ 
                variant: "destructive", 
                title: "Save Failed", 
                description: saveError.message 
            });
            // Also update grant status to error if saving failed after analysis was successful
            await updateGrantMutation.mutateAsync({
                ai_status: 'error',
                ai_error: saveError.message,
                ai_updated_at: new Date().toISOString(),
            }).catch(e => console.error("Failed to set AI status to error after save fail:", e));
            queryClient.invalidateQueries({ queryKey: ['grant', grantId] });
        }
    },
    onError: async (error) => {
        console.error('[GrantDetail] Mutation error:', error);
        
        const errorMsg = error.message || 'Analysis failed. Please try again.';
        
        toast({ 
          variant: "destructive", 
          title: "Analysis Failed", 
          description: errorMsg 
        });
        
        // Update grant status to error immediately if the function invocation failed
        try {
          await updateGrantMutation.mutateAsync({
              ai_status: 'error',
              ai_error: errorMsg,
              ai_updated_at: new Date().toISOString(),
          });
        } catch (updateError) {
          console.error('[GrantDetail] Failed to update error status:', updateError);
        }
        queryClient.invalidateQueries({ queryKey: ['grant', grantId] });
    },
  });

  const runGrantAnalysis = async () => {
    if (!grant) {
        console.error('[GrantDetail] Cannot analyze - grant data missing');
        toast({ 
            variant: "destructive", 
            title: "Cannot Analyze", 
            description: "Grant data is missing." 
        });
        return;
    }
    
    log.debug('starting analysis', { grantId: grant.id });
    
    const payload = {
        grantId: grant.id,
        title: grant.title,
        description: grant.program_description || '',
        eligibility: grant.eligibility_summary || '',
        selectionCriteria: grant.selection_criteria || '',
    };
    
    log.debug('analysis payload summary', {
      grantId: payload.grantId,
      titleLength: payload.title?.length,
      descLength: payload.description?.length,
      eligLength: payload.eligibility?.length
    });

    // Optimistically update AI status to running
    await updateGrantMutation.mutateAsync({ 
      ai_status: 'running', 
      ai_error: null, 
      ai_updated_at: new Date().toISOString() 
    });
    
    try {
      await analyzeGrantMutation.mutateAsync(payload);
    } catch (error) {
      console.error('[GrantDetail] Analysis failed during invocation:', error);
      // The onError handler for useMutation will already display a toast and update grant status.
      // We catch here to prevent unhandled promise rejection warnings.
    }
  };
  
  if (isLoadingGrant) {
    return <div className="flex h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" /></div>; 
  }
  if (isErrorGrant) { return <div className="p-4">Error loading grant: {toMessage(grantError)}</div>; }
  if (isErrorOrg && grant?.organization_id) { return <div className="p-4">Error loading organization: {toMessage(orgError)}</div>; }
  if (!grant) { return <div className="p-4">Grant not found.</div>; }
  
  const handleStarToggle = () => { updateGrantMutation.mutate({ starred: !grant.starred }); };
  
  const handleApplyWithAI = () => {
    log.debug('start application clicked', { status: grant.status })
    navigate(`/Apply?id=${encodeURIComponent(String(grantId))}`)
  };
  
  if (isEditing) {
    return (
        <div className="p-6 md:p-8">
            <GrantForm grant={grant} organization={organization} onSubmit={updateGrantMutation.mutate} onCancel={() => setIsEditing(false)} isSubmitting={updateGrantMutation.isPending} />
        </div>
    );
  }
  
  const isAnalyzing = analyzeGrantMutation.isPending || ['queued', 'running'].includes(grant.ai_status);
  
  // Build pipeline URL with organization filter
  const pipelineUrl = grant.organization_id 
    ? createPageUrl("Pipeline", { organization_id: grant.organization_id })
    : createPageUrl('Pipeline');
  
  return (
    <div className="bg-slate-50 min-h-screen">
      <header className="bg-white border-b border-slate-200 p-4 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div>
            <Button variant="ghost" onClick={() => navigate(pipelineUrl)} className="flex items-center gap-2 mb-2 -ml-3">
              <ArrowLeft className="w-4 h-4" /> Back to Pipeline
            </Button>
            <h1 className="text-2xl font-bold text-slate-900 truncate" title={grant.title}>{grant.title}</h1>
            <p className="text-slate-600">from {grant.funder}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {['discovered', 'interested', 'drafting', 'portal', 'application_prep', 'revision'].includes(grant.status) && ( 
              <Button 
                onClick={handleApplyWithAI} 
                className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 gap-2 shadow-lg"
                disabled={isAnalyzing}
              > 
                {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} 
                {grant.status === 'portal' || grant.url?.toLowerCase().includes('portal') ? 'Launch Portal Assistant' : 'Start Application'}
              </Button> 
            )}
            <Button variant={grant.starred ? 'default' : 'outline'} onClick={handleStarToggle} className="gap-2"> 
              <Star className={`w-4 h-4 ${grant.starred ? 'text-yellow-400 fill-yellow-400' : ''}`} /> 
              {grant.starred ? 'Starred' : 'Star'} 
            </Button>
            <Button variant="outline" onClick={() => setIsEditing(true)}><Edit className="w-4 h-4 mr-2" /> Edit</Button>
            <Button variant="destructive" onClick={() => setIsDeleting(true)}><Trash2 className="w-4 h-4 mr-2" /> Delete</Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <GrantOverview grant={grant} organization={organization} onOpenPrintApp={() => setIsPrintableAppOpen(true)} />
          <Tabs value={activeTab} onValueChange={setActiveTab} className="bg-white rounded-xl shadow-sm border">
            <TabsList className="p-2 m-2">
                <TabsTrigger value="coach"><Brain className="w-4 h-4 mr-2"/>AI Coach</TabsTrigger>
                <TabsTrigger value="portal-assist" onClick={(e) => { e.preventDefault(); setIsPortalAssistantOpen(true); }}><Sparkles className="w-4 h-4 mr-2"/>Portal Assistant</TabsTrigger>
                <TabsTrigger value="print-app" onClick={(e) => { e.preventDefault(); setIsPrintableAppOpen(true); }}><FileText className="w-4 h-4 mr-2"/>Print Application</TabsTrigger>
                <TabsTrigger value="checklist"><CheckSquare className="w-4 h-4 mr-2"/>Checklist</TabsTrigger>
                <TabsTrigger value="budget"><DollarSign className="w-4 h-4 mr-2"/>Budget</TabsTrigger>
                <TabsTrigger value="timelogs"><Clock className="w-4 h-4 mr-2"/>Time Logs</TabsTrigger>
                {grant.status === 'awarded' && <TabsTrigger value="compliance"><Shield className="w-4 h-4 mr-2"/>Compliance</TabsTrigger>}
            </TabsList>
            <TabsContent value="coach" className="p-4">
                <ErrorBoundary>
                    <ProposalCoachPanel 
                        grantId={grant.id}
                        grant={grant} 
                        onAnalyze={runGrantAnalysis}
                        isAnalyzing={isAnalyzing}
                        onStartApplication={() => setIsApplicationAssistantOpen(true)}
                        onSaveDetails={(payload) => updateGrantMutation.mutateAsync(payload)}
                        onDraftDetails={async () => {
                          const data = await apiFetch(`/api/grants/${encodeURIComponent(String(grant.id))}/ai/draft-details`, {
                            method: "POST",
                            body: JSON.stringify({}),
                          })
                          const updated = data?.grant ?? null
                          if (updated) {
                            queryClient.setQueryData(["grant", grantId], updated)
                          } else {
                            queryClient.invalidateQueries({ queryKey: ["grant", grantId] })
                          }
                          return updated
                        }}
                    />
                </ErrorBoundary>
            </TabsContent>
            <TabsContent value="checklist" className="p-4">
              <ErrorBoundary>
                <Checklist grantId={grant.id} organizationId={grant.organization_id} />
              </ErrorBoundary>
            </TabsContent>
            <TabsContent value="budget" className="p-4">
              <ErrorBoundary>
                <BudgetTab grant={grant} />
              </ErrorBoundary>
            </TabsContent>
            <TabsContent value="timelogs" className="p-4">
              <ErrorBoundary>
                <TimeTrackingTab grantId={grant.id} organizationId={grant.organization_id} />
              </ErrorBoundary>
            </TabsContent>
            {grant.status === 'awarded' && (
              <TabsContent value="compliance" className="p-4">
                <ErrorBoundary>
                  <ComplianceTab grant={grant} />
                </ErrorBoundary>
              </TabsContent>
            )}
          </Tabs>
        </div>
        <div className="lg:col-span-1 space-y-6"></div>
      </main>

      <AlertDialog open={isDeleting} onOpenChange={setIsDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription> 
              This will permanently delete "{grant.title}". This action cannot be undone. 
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteGrantMutation.mutate()} className="bg-red-600 hover:bg-red-700"> 
              {deleteGrantMutation.isPending ? 'Deleting...' : 'Delete'} 
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isPortalAssistantOpen && (
        <PortalAssistantPanel
          open={isPortalAssistantOpen}
          onClose={() => setIsPortalAssistantOpen(false)}
          grant={grant}
        />
      )}

      {isApplicationAssistantOpen && organization && (
        <AIApplicationAssistant
          open={isApplicationAssistantOpen}
          onClose={() => setIsApplicationAssistantOpen(false)}
          grant={grant}
          organization={organization}
        />
      )}

      {isSubmissionAssistantOpen && organization && (
        <SubmissionAssistant
          open={isSubmissionAssistantOpen}
          onClose={() => setIsSubmissionAssistantOpen(false)}
          grant={grant}
          organization={organization}
        />
      )}

      {isPrintableAppOpen && (
        <PrintableApplicationPanel
          open={isPrintableAppOpen}
          onClose={() => setIsPrintableAppOpen(false)}
          grant={grant}
        />
      )}
    </div>
  );
}
