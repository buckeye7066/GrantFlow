import React, { useState, useCallback, useMemo, useRef } from 'react';
import { DragDropContext } from '@hello-pangea/dnd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { Loader2 } from 'lucide-react';
import KanbanColumn from './KanbanColumn';
import { useGrantsByStatus, GRANT_STATUSES } from '@/components/hooks/useGrantsByStatus';
import { useChecklistProgress } from '@/components/hooks/useChecklistProgress';
import { runAIAssessment, hasExistingAnalysis } from './services/aiAssessmentService';

/**
 * KanbanBoard - Drag-and-drop grant pipeline board
 *
 * Features:
 * - Drag grants between status columns
 * - Auto-trigger AI assessment on status change
 * - Star/delete grants
 * - Display checklist progress
 * - Display workflow progress
 * - Responsive and accessible
 */
export default function KanbanBoard({
  grants,
  organizations,
  onUpdateGrant,
  onDeleteGrant,
  selectedOrganization,
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isProcessingAI, setIsProcessingAI] = useState(false);

  // Prevent duplicate AI runs per grant within session
  const inFlightAI = useRef(new Set());

  const safeGrants = Array.isArray(grants) ? grants : [];
  const safeOrganizations = Array.isArray(organizations) ? organizations : [];

  // Fetch checklist items
  const { data: checklistItems = [] } = useQuery({
    queryKey: ['checklistItems'],
    queryFn: async () => (await base44.entities.ChecklistItem.list()) || [],
  });

  // Fetch workflow stages for all grants
  const { data: allWorkflowStages = [] } = useQuery({
    queryKey: ['allWorkflowStages'],
    queryFn: async () => (await base44.entities.WorkflowStage.list()) || [],
  });

  // Group grants by status
  const grantsByStatus = useGrantsByStatus(safeGrants);

  // Calculate checklist progress
  const checklistProgressMap = useChecklistProgress(safeGrants, checklistItems);

  // Calculate workflow progress for each grant
  const workflowProgressMap = useMemo(() => {
    const progressMap = {};

    safeGrants.forEach((grant) => {
      const grantStages = allWorkflowStages.filter((s) => String(s.grant_id) === String(grant.id));
      const completed = grantStages.filter((s) => s.status === 'completed').length;

      progressMap[String(grant.id)] = {
        total: grantStages.length,
        completed,
        percentage: grantStages.length > 0 ? (completed / grantStages.length) * 100 : 0,
      };
    });

    return progressMap;
  }, [safeGrants, allWorkflowStages]);

  // Build valid status set
  const validStatuses = useMemo(() => new Set(GRANT_STATUSES.map((s) => s.value)), []);

  /**
   * Handle AI assessment workflow
   */
  const handleAIAssessment = useCallback(
    async (grant, newStatus) => {
      if (!grant?.id) return;
      if (newStatus !== 'interested') return;

      const org = safeOrganizations.find((o) => String(o?.id) === String(grant?.organization_id));
      if (!org) {
        console.warn('[KanbanBoard] Organization not found for AI assessment', grant);
        return;
      }

      // Avoid duplicate runs within the same session
      if (inFlightAI.current.has(String(grant.id)) || isProcessingAI) {
        return;
      }

      // Skip if existing analysis already present
      const exists = await hasExistingAnalysis(grant.id);
      if (exists) {
        toast({
          title: '✓ Analysis Exists',
          description: `${grant.title || 'This grant'} has already been analyzed.`,
        });
        return;
      }

      inFlightAI.current.add(String(grant.id));
      setIsProcessingAI(true);

      toast({
        title: '🤖 AI Assessment Started',
        description: `Analyzing ${grant.title || 'opportunity'}...`,
      });

      try {
        const result = await runAIAssessment(grant, org, { skipIfExists: true });

        if (result.skipped) {
          toast({
            title: '✓ Already Analyzed',
            description: 'This grant has an existing analysis.',
          });
        } else {
          // Invalidate queries to refresh data - sequential for stability
          await queryClient.invalidateQueries({ queryKey: ['aiArtifact', grant.id] });
          await queryClient.invalidateQueries({ queryKey: ['checklistItems'] });

          toast({
            title: '✅ AI Assessment Complete',
            description: `Created ${result.checklistItemsCreated} checklist items.`,
          });
        }
      } catch (error) {
        console.error('[KanbanBoard] AI assessment error:', error);
        toast({
          variant: 'destructive',
          title: '❌ AI Assessment Failed',
          description: error?.message || 'Could not complete AI analysis.',
        });
      } finally {
        inFlightAI.current.delete(String(grant.id));
        setIsProcessingAI(false);
      }
    },
    [safeOrganizations, toast, queryClient, isProcessingAI]
  );

  /**
   * Handle drag end event
   *
   * Sentinel check - verify grant belongs to selected organization
   * Validate destination status
   */
  const handleDragEnd = useCallback(
    async (result) => {
      const { destination, source, draggableId } = result;

      if (!destination) {
        console.log('[KanbanBoard] Drag cancelled - no destination');
        return;
      }

      const newStatus = destination.droppableId;
      const oldStatus = source.droppableId;

      // Validate status column
      if (!validStatuses.has(newStatus)) {
        console.warn('[KanbanBoard] Unknown destination status, skipping update:', newStatus);
        return;
      }

      if (newStatus === oldStatus) {
        console.log('[KanbanBoard] Status unchanged, skipping update');
        return;
      }

      const grant = safeGrants.find((g) => String(g.id) === String(draggableId));
      if (!grant) {
        console.error('[KanbanBoard] Grant not found for draggableId:', draggableId);
        return;
      }

      // Verify grant belongs to the current profile
      if (grant && selectedOrganization) {
        if (grant.profile_id && String(grant.profile_id) !== String(selectedOrganization.id)) {
          console.error('[KanbanBoard] CONTAMINATION_BLOCKED: Cannot update grant from different profile', {
            grantId: grant.id,
            grantProfileId: grant.profile_id,
            selectedProfileId: selectedOrganization.id,
          });
          toast({
            variant: 'destructive',
            title: 'Update Blocked',
            description: 'This grant belongs to a different profile.',
          });
          return;
        }
      }

      console.log('[KanbanBoard] Updating grant status:', {
        grantId: draggableId,
        fromStatus: oldStatus,
        toStatus: newStatus,
      });

      // Optimistic status update via provided handler
      onUpdateGrant(String(draggableId), { status: newStatus });

      // Run AI assessment if applicable
      handleAIAssessment(grant, newStatus);
    },
    [safeGrants, onUpdateGrant, handleAIAssessment, selectedOrganization, toast, validStatuses]
  );

  /**
   * Handle star toggle
   */
  const handleStarToggle = useCallback(
    (grant) => {
      if (!grant?.id) return;
      onUpdateGrant(String(grant.id), { starred: !grant.starred });
    },
    [onUpdateGrant]
  );

  /**
   * Handle delete
   */
  const handleDelete = useCallback(
    (grant) => {
      if (!grant) return;
      onDeleteGrant(grant);
    },
    [onDeleteGrant]
  );

  // Loading guard
  if (!Array.isArray(grants) || !Array.isArray(organizations)) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <>
      {/* AI Processing Indicator */}
      {isProcessingAI && (
        <div className="fixed top-4 right-4 z-50 bg-purple-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm font-medium">Running AI Analysis...</span>
        </div>
      )}

      {/* Kanban Board */}
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6" role="region" aria-label="Grant pipeline board">
          {GRANT_STATUSES.map((status) => {
            const statusGrants = grantsByStatus[status.value] || [];

            // Count grants that need AI analysis
            const needsAnalysis = statusGrants.filter((g) => {
              const noSummary = !g.ai_summary || g.ai_summary.trim().length === 0;
              const errored = g.ai_status === 'error';
              const notReady = g.ai_status !== 'ready';
              return errored || (noSummary && notReady);
            }).length;

            return (
              <KanbanColumn
                key={status.value}
                status={status}
                grants={statusGrants}
                organizations={safeOrganizations}
                onUpdateGrant={onUpdateGrant}
                onDeleteGrant={onDeleteGrant}
                checklistProgressMap={checklistProgressMap}
                workflowProgressMap={workflowProgressMap}
                selectedOrganization={selectedOrganization || null}
                needsAnalysisCount={needsAnalysis}
              />
            );
          })}
        </div>
      </DragDropContext>
    </>
  );
}