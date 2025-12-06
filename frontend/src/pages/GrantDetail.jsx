import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Loader2, ShieldAlert } from 'lucide-react';
import { useToast } from "@/components/ui/use-toast";
import { installClickTracer } from '@/components/shared/clickTracer'; // consistency
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuthContext } from '@/components/hooks/useAuthRLS';

// Components
import GrantOverview from '@/components/grants/GrantOverview';
import GrantHeader from '@/components/grants/GrantHeader';
import GrantTabs from '@/components/grants/GrantTabs';
import DeleteGrantDialog from '@/components/grants/DeleteGrantDialog';
import GrantAssistants from '@/components/grants/GrantAssistants';
import GrantForm from '@/components/grants/GrantForm';
import AIProposalWriter from '@/components/proposals/AIProposalWriter';
import AIProposalAssistant from '@/components/proposals/AIProposalAssistant';
import WorkflowTimeline from '@/components/workflow/WorkflowTimeline';
import AddStageDialog from '@/components/workflow/AddStageDialog';
import AddTaskDialog from '@/components/workflow/AddTaskDialog';
import BudgetManager from '@/components/budgets/BudgetManager';
import ApplicationWizard from '@/components/wizard/ApplicationWizard';
import DocumentManager from '@/components/documents/DocumentManager';

// Hooks
import { useGrantAnalysis } from '@/components/hooks/useGrantAnalysis';
import { useAssistantManager } from '@/components/hooks/useAssistantManager';
import { useGrantWorkflow } from '@/components/hooks/useGrantWorkflow';

const toMessage = (e) => (e instanceof Error ? e.message : String(e || ''));

export default function GrantDetail() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawGrantId = searchParams.get('id');
  const grantId = rawGrantId && rawGrantId !== 'undefined' && rawGrantId !== 'null' ? rawGrantId : null;
  const initialTab = searchParams.get('tab') || 'coach';

  console.log('[GrantDetail] Page loaded with:', { rawGrantId, grantId, initialTab });

  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [showProposalWriter, setShowProposalWriter] = useState(false);
  const [showProposalAssistant, setShowProposalAssistant] = useState(false);
  const [showAddStageDialog, setShowAddStageDialog] = useState(false);
  const [showAddTaskDialog, setShowAddTaskDialog] = useState(false);
  const [selectedStage, setSelectedStage] = useState(null);
  const [showApplicationWizard, setShowApplicationWizard] = useState(false);

  // Track AI polling start time
  const aiPollingStartRef = useRef(null);

  useEffect(() => {
    installClickTracer();
  }, []);

  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // Grant (RLS-aware)
  const {
    data: grant,
    isLoading: isLoadingGrant,
    isError: isErrorGrant,
    error: grantError,
  } = useQuery({
    queryKey: ['grant', grantId, user?.email, isAdmin],
    queryFn: async () => {
      if (!grantId) return null;
      try {
        if (isAdmin) {
          const results = await base44.entities.Grant.filter({ id: grantId });
          return results?.[0] ?? null;
        }
        const results = await base44.entities.Grant.filter({ id: grantId, created_by: user?.email });
        return results?.[0] ?? null;
      } catch (err) {
        console.error('[GrantDetail] Grant fetch error:', err);
        return null;
      }
    },
    enabled: !!grantId && !!user?.email,
    retry: 1,
    refetchIntervalInBackground: false,
    // FIX: React Query expects (data) or (data, query); use data to decide
    refetchInterval: (grantData) => {
      if (grantData && ['queued', 'running'].includes(grantData.ai_status)) {
        if (!aiPollingStartRef.current) aiPollingStartRef.current = Date.now();
        const elapsed = Date.now() - aiPollingStartRef.current;
        if (elapsed > 120000) {
          console.warn('[GrantDetail] Stopping refetch - timeout after 2 minutes');
          aiPollingStartRef.current = null;
          return false;
        }
        return 2000;
      }
      aiPollingStartRef.current = null;
      return false;
    },
  });

  // Organization (RLS-aware)
  const {
    data: organization,
    isLoading: isLoadingOrg,
    isError: isErrorOrg,
    error: orgError,
  } = useQuery({
    queryKey: ['organization', grant?.organization_id, user?.email, isAdmin],
    queryFn: async () => {
      if (!grant?.organization_id) return null;
      if (isAdmin) {
        const results = await base44.entities.Organization.filter({ id: grant.organization_id });
        return results?.[0] ?? null;
      }
      const results = await base44.entities.Organization.filter({
        id: grant.organization_id,
        created_by: user?.email,
      });
      return results?.[0] ?? null;
    },
    enabled: !!grant?.organization_id && !!user?.email,
  });

  // Checklist items
  const { data: existingChecklistItems = [] } = useQuery({
    queryKey: ['checklistItems', grantId, user?.email],
    queryFn: () => base44.entities.ChecklistItem.filter({ grant_id: grantId }),
    enabled: !!grantId && !!grant && !!user?.email,
  });

  // Workflow
  const { data: workflowStages = [] } = useQuery({
    queryKey: ['workflowStages', grantId, user?.email],
    queryFn: () => base44.entities.WorkflowStage.filter({ grant_id: grantId }),
    enabled: !!grant && !!user?.email,
  });

  const { data: workflowTasks = [] } = useQuery({
    queryKey: ['workflowTasks', grantId, user?.email],
    queryFn: () => base44.entities.WorkflowTask.filter({ grant_id: grantId }),
    enabled: !!grant && !!user?.email,
  });

  // Mutations
  const updateGrantMutation = useMutation({
    mutationFn: (updatedData) => base44.entities.Grant.update(grantId, updatedData),
    onSuccess: (data) => {
      queryClient.setQueryData(['grant', grantId, user?.email, isAdmin], data);
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin] });
      queryClient.invalidateQueries({ queryKey: ['grant', grantId, user?.email, isAdmin] });
      setIsEditing(false);
    },
  });

  const deleteGrantMutation = useMutation({
    mutationFn: () => base44.entities.Grant.delete(grantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin] });
      navigate(createPageUrl('Pipeline'));
    },
  });

  // Analysis
  const analysisMutation = useGrantAnalysis(grantId);
  const runGrantAnalysis = () => {
    if (grant && organization) {
      analysisMutation.mutate({ grant, organization });
    }
  };
  const isAnalyzing = analysisMutation.isPending;

  const {
    isPortalAssistantOpen,
    isApplicationAssistantOpen,
    isSubmissionAssistantOpen,
    openAssistant,
    closeAssistant,
  } = useAssistantManager();

  const { handleApplyWithAI } = useGrantWorkflow(
    grant,
    organization,
    existingChecklistItems,
    runGrantAnalysis,
    updateGrantMutation.mutate,
    openAssistant
  );

  // Sync active tab with URL
  useEffect(() => {
    const tabFromUrl = searchParams.get('tab');
    if (tabFromUrl && tabFromUrl !== activeTab) {
      setActiveTab(tabFromUrl);
    }
  }, [searchParams, activeTab]);

  const handleTabChange = (newTab) => {
    setActiveTab(newTab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      if (grantId) next.set('id', String(grantId)); // ensure string
      return next;
    });
  };

  const handleContentGenerated = (_sectionType, _content) => {
    toast({ title: '✅ Content Ready', description: 'AI-generated content is ready to use' });
    setShowProposalWriter(false);
  };

  const handleAddStage = () => setShowAddStageDialog(true);
  const handleEditStage = (stage) => console.log('[GrantDetail] Edit stage:', stage);
  const handleAddTask = (stage) => {
    setSelectedStage(stage);
    setShowAddTaskDialog(true);
  };

  const handleWizardComplete = (formData) => {
    console.log('[GrantDetail] Wizard completed with data:', formData);
    toast({ title: '✅ Application Complete', description: 'Your application is ready for final review and submission' });
    setShowApplicationWizard(false);
    queryClient.invalidateQueries({ queryKey: ['grant', grantId, user?.email, isAdmin] });
  };

  const docPropsBase = useMemo(
    () => ({
      organizationId: grant?.organization_id,
      grantId: grant?.id,
    }),
    [grant?.organization_id, grant?.id]
  );

  // Loading
  if (isLoadingUser || isLoadingGrant) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  // Auth gate
  if (!user) {
    return (
      <div className="p-6 md:p-8">
        <Card className="max-w-lg mx-auto">
          <CardContent className="p-12 text-center">
            <ShieldAlert className="w-16 h-16 mx-auto text-amber-400 mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">Authentication Required</h3>
            <p className="text-slate-600 mb-6">Please sign in to view this grant.</p>
            <Button onClick={() => base44.auth.redirectToLogin()}>Sign In</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Invalid/missing ID
  if (!grantId) {
    console.error('[GrantDetail] GUARD: Invalid grantId detected', {
      rawGrantId,
      url: typeof window !== 'undefined' ? window.location.href : '',
      timestamp: new Date().toISOString(),
    });

    return (
      <div className="p-6 md:p-8">
        <Card className="max-w-lg mx-auto">
          <CardContent className="p-12 text-center">
            <ShieldAlert className="w-16 h-16 mx-auto text-amber-400 mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">No Grant Selected</h3>
            <p className="text-slate-600 mb-6">Please select a grant from the pipeline to view its details.</p>
            <p className="text-xs text-slate-400 mb-4">Error: Invalid grant ID passed to GrantDetail</p>
            <Button onClick={() => navigate(createPageUrl('Pipeline'))}>Back to Pipeline</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Not found / no access
  if (!grant) {
    return (
      <div className="p-6 md:p-8">
        <Card className="max-w-lg mx-auto">
          <CardContent className="p-12 text-center">
            <ShieldAlert className="w-16 h-16 mx-auto text-red-400 mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">Access Denied</h3>
            <p className="text-slate-600 mb-6">This grant was not found or you do not have permission to view it.</p>
            <Button onClick={() => navigate(createPageUrl('Pipeline'))}>Back to Pipeline</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isErrorGrant) return <div className="p-4">Error loading grant: {toMessage(grantError)}</div>;
  if (isErrorOrg && grant?.organization_id) return <div className="p-4">Error loading organization: {toMessage(orgError)}</div>;

  const handleStarToggle = () => updateGrantMutation.mutate({ starred: !grant.starred });

  // Edit mode
  if (isEditing) {
    return (
      <div className="p-6 md:p-8">
        <GrantForm
          grant={grant}
          organization={organization}
          onSubmit={updateGrantMutation.mutate}
          onCancel={() => setIsEditing(false)}
          isSubmitting={updateGrantMutation.isPending}
        />
      </div>
    );
  }

  return (
    <div className="bg-slate-50 min-h-screen">
      <GrantHeader
        grant={grant}
        isAnalyzing={isAnalyzing}
        onApplyWithAI={handleApplyWithAI}
        onStarToggle={handleStarToggle}
        onEdit={() => setIsEditing(true)}
        onDelete={() => setIsDeleting(true)}
        onWriteProposal={() => setShowProposalAssistant(true)}
        onStartWizard={() => setShowApplicationWizard(true)}
        onSubmit={() => openAssistant('submission')}
      />

      <main className="max-w-7xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <GrantOverview grant={grant} organization={organization} onSubmit={() => openAssistant('submission')} />

          {/* Workflow Timeline */}
          <WorkflowTimeline
            stages={workflowStages}
            tasks={workflowTasks}
            grant={grant}
            onAddStage={handleAddStage}
            onEditStage={handleEditStage}
            onAddTask={handleAddTask}
          />

          {/* Budget Manager */}
          <BudgetManager grant={grant} workflowStages={workflowStages} workflowTasks={workflowTasks} />

          {/* Document Manager with AI Suggestions */}
          {docPropsBase.organizationId && docPropsBase.grantId && (
            <DocumentManager organizationId={docPropsBase.organizationId} grantId={docPropsBase.grantId} mode="suggestions" />
          )}

          <GrantTabs
            grant={grant}
            activeTab={activeTab}
            onTabChange={handleTabChange}
            onAnalyze={runGrantAnalysis}
            isAnalyzing={isAnalyzing}
            onStartApplication={() => openAssistant('application')}
          />
        </div>

        <div className="lg:col-span-1 space-y-6">
          {/* Quick Document Access */}
          {docPropsBase.organizationId && docPropsBase.grantId && (
            <DocumentManager organizationId={docPropsBase.organizationId} grantId={docPropsBase.grantId} mode="compact" />
          )}
        </div>
      </main>

      {/* Application Wizard */}
      {showApplicationWizard && grant && organization && (
        <ApplicationWizard grant={grant} organization={organization} onComplete={handleWizardComplete} onClose={() => setShowApplicationWizard(false)} />
      )}

      {/* AI Proposal Assistant Dialog */}
      {showProposalAssistant && grant && organization && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg max-w-5xl w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-900">AI Proposal Assistant</h2>
              <Button variant="ghost" size="sm" onClick={() => setShowProposalAssistant(false)}>
                Close
              </Button>
            </div>
            <div className="p-6">
              <AIProposalAssistant grant={grant} organization={organization} onContentGenerated={handleContentGenerated} />
            </div>
          </div>
        </div>
      )}

      {/* Add Stage Dialog */}
      <AddStageDialog open={showAddStageDialog} onClose={() => setShowAddStageDialog(false)} grantId={grantId} existingStages={workflowStages} />

      {/* Add Task Dialog */}
      <AddTaskDialog
        open={showAddTaskDialog}
        onClose={() => {
          setShowAddTaskDialog(false);
          setSelectedStage(null);
        }}
        stage={selectedStage}
        grantId={grantId}
      />

      <DeleteGrantDialog
        open={isDeleting}
        grant={grant}
        onConfirm={() => deleteGrantMutation.mutate()}
        onCancel={() => setIsDeleting(false)}
        isDeleting={deleteGrantMutation.isPending}
      />

      <GrantAssistants
        grant={grant}
        organization={organization}
        portalOpen={isPortalAssistantOpen}
        applicationOpen={isApplicationAssistantOpen}
        submissionOpen={isSubmissionAssistantOpen}
        onClosePortal={() => closeAssistant('portal')}
        onCloseApplication={() => closeAssistant('application')}
        onCloseSubmission={() => closeAssistant('submission')}
      />
    </div>
  );
}