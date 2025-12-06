import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Plus, Trash2, AlertTriangle, Loader2, Zap, Building2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { useToast } from "@/components/ui/use-toast";

// Components
import KanbanBoard from '@/components/pipeline/KanbanBoard';
import AdvancedFilters from '@/components/pipeline/AdvancedFilters';
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

import BackgroundJobStatus from '@/components/automation/BackgroundJobStatus';
import { log } from '@/components/shared/logger';

// Hooks
import { useFilteredGrants } from '@/components/hooks/useFilteredGrants';

// FIXED: Use centralized utility from grantUtils
import { isGrantExpired as isGrantExpiredUtil } from '@/components/shared/grantUtils';

const getExpiredGrants = (grants, now = new Date()) => {
  return grants.filter(g => isGrantExpiredUtil(g, now));
};

export default function PipelinePage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedOrgId, setSelectedOrgId] = useState(() => {
    const orgId = searchParams.get('organization_id');
    return orgId || null;
  });
  const [grantToDelete, setGrantToDelete] = useState(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showRemoveMismatchConfirm, setShowRemoveMismatchConfirm] = useState(false);
  const [expiredCountAtOpen, setExpiredCountAtOpen] = useState(0);
  const [mismatchCountAtOpen, setMismatchCountAtOpen] = useState(0);
  const [backgroundJobId, setBackgroundJobId] = useState(null);

  // Filter state
  const [filters, setFilters] = useState({
    search: '',
    deadlineStatus: 'all',
    hideExpired: false,
    showOnlyExpired: false,
    deadlineAfter: '',
    deadlineBefore: '',
    matchScoreMin: 0,
    minAmount: '',
    maxAmount: '',
    funderTypes: [],
    applicationMethods: [],
    opportunityTypes: [],
    tags: [],
    keywordIncludesAllTerms: false,
  });

  // Sync selectedOrgId to URL - use functional form to avoid re-render loop
  const isFirstMount = useRef(true);
  useEffect(() => {
    // Skip the first mount to avoid unnecessary URL update
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    
    const params = new URLSearchParams(searchParams);
    if (selectedOrgId) params.set('organization_id', selectedOrgId);
    else params.delete('organization_id');
    setSearchParams(params, { replace: true });
  }, [selectedOrgId, setSearchParams]);

  // Fetch data
  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: async () => {
      try {
        return await base44.auth.me();
      } catch (error) {
        console.error('[Pipeline] Auth error:', error);
        return null;
      }
    },
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchInterval: false,
  });

  const isAdmin = user?.role === 'admin';

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Organization.list()
      : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: !!user?.email,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchInterval: false,
  });

  // PART 3 & 5: Fetch grants with profile isolation
  // Admin can see all, regular users see their own
  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', user?.email, isAdmin, selectedOrgId],
    queryFn: async () => {
      if (isAdmin) {
        // PART 5: Admin bypass - can see all grants
        if (selectedOrgId) {
          // If org selected, still scope to that org for performance
          return base44.entities.Grant.filter({ organization_id: selectedOrgId });
        }
        return base44.entities.Grant.list();
      }
      // Regular users: filter by created_by
      // When selectedOrgId is set, also filter by profile_id for isolation
      if (selectedOrgId) {
        return base44.entities.Grant.filter({ 
          created_by: user?.email,
          organization_id: selectedOrgId,
          profile_id: selectedOrgId  // CRITICAL: Per-profile isolation
        });
      }
      return base44.entities.Grant.filter({ created_by: user?.email });
    },
    enabled: !!user?.email,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchInterval: false,
  });

  // Use custom hook for filtering
  const { filteredGrants } = useFilteredGrants(grants, selectedOrgId, filters);

  // Reset analysis status mutation - SEQUENTIAL to prevent 502 errors
  const resetAnalysisMutation = useMutation({
    mutationFn: async () => {
      const grantsToReset = grants.filter(g => 
        g.ai_status === 'queued' || g.ai_status === 'running'
      );
      
      let resetCount = 0;
      for (const grant of grantsToReset) {
        try {
          await base44.entities.Grant.update(grant.id, { ai_status: 'idle' });
          resetCount++;
        } catch (err) {
          console.error('[Pipeline] Failed to reset grant:', grant.id, err);
        }
      }
      
      return resetCount;
    },
    onSuccess: (count) => {
      // FIXED: Include selectedOrgId in query key for proper invalidation
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin, selectedOrgId] });
      toast({
        title: '✅ Analysis Reset',
        description: `Reset ${count} grant${count !== 1 ? 's' : ''} to idle status. You can now retry.`,
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Reset Failed',
        description: error.message || 'Failed to reset analysis status',
      });
    }
  });

  const updateGrantMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Grant.update(id, data),
    onSuccess: () => {
      // FIXED: Include selectedOrgId in query key for proper invalidation
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin, selectedOrgId] });
      toast({
        title: "Grant Updated",
        description: "The grant has been successfully updated.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error.message || "There was an error updating the grant.",
      });
    }
  });

  const deleteGrantMutation = useMutation({
    mutationFn: (id) => base44.entities.Grant.delete(id),
    onSuccess: () => {
      // FIXED: Include selectedOrgId in query key for proper invalidation
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin, selectedOrgId] });
      setGrantToDelete(null);
      toast({
        title: "Grant Deleted",
        description: "The grant has been successfully removed from your pipeline.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error.message || "There was an error deleting the grant.",
      });
    }
  });

  const bulkDeleteExpiredMutation = useMutation({
    mutationFn: async () => {
      // Get all expired grants using the shared helper
      const allExpiredGrants = getExpiredGrants(grants);

      // If profile selected, filter to that profile; otherwise delete all visible expired
      const grantsToDelete = selectedOrgId 
        ? allExpiredGrants.filter(g => g.organization_id === selectedOrgId)
        : allExpiredGrants;

      log.info('[Pipeline] Starting bulk delete', { 
        selectedOrgId, 
        totalExpired: allExpiredGrants.length,
        toDelete: grantsToDelete.length 
      });

      let deleted = 0;

      for (const grant of grantsToDelete) {
        try {
          log.info('[Pipeline] Deleting grant:', grant.id, grant.title);
          await base44.entities.Grant.delete(grant.id);
          deleted++;
        } catch (err) {
          log.error('[Pipeline] Failed to delete grant:', grant.id, err);
        }
      }

      log.info('[Pipeline] Bulk delete complete. Deleted:', deleted, 'of', grantsToDelete.length);
      return deleted;
    },
    onSuccess: (count) => {
      log.info('[Pipeline] Bulk delete success, invalidating queries');
      // FIXED: Include selectedOrgId in query key for proper invalidation
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin, selectedOrgId] });

      // Close dialog BEFORE showing toast to prevent flash
      setShowBulkDeleteConfirm(false);

      // Delay toast to ensure UI updates smoothly
      setTimeout(() => {
        toast({
          title: "Expired Grants Removed",
          description: `Successfully removed ${count} expired grant${count > 1 ? 's' : ''}.`,
        });
      }, 300);
    },
    onError: (error) => {
      log.error('[Pipeline] Bulk delete error:', error);
      // FIXED: Include selectedOrgId in query key for proper invalidation
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin, selectedOrgId] });
      setShowBulkDeleteConfirm(false);
      toast({
        variant: "destructive",
        title: "Bulk Delete Failed",
        description: error.message || "There was an error during bulk deletion.",
      });
    }
  });

  const bulkDeleteMismatchMutation = useMutation({
    mutationFn: async () => {
      // Only allow if a specific profile is selected
      if (!selectedOrgId) {
        throw new Error('Please select a profile first');
      }

      // Get grants with low match scores (< 40) for this profile
      const mismatchedGrants = grants.filter(g => 
        g.organization_id === selectedOrgId && 
        (g.match_score === null || g.match_score === undefined || g.match_score < 40)
      );

      log.info('[Pipeline] Starting mismatch delete', { 
        selectedOrgId, 
        toDelete: mismatchedGrants.length 
      });

      let deleted = 0;

      for (const grant of mismatchedGrants) {
        try {
          log.info('[Pipeline] Deleting low-match grant:', grant.id, grant.title, 'score:', grant.match_score);
          await base44.entities.Grant.delete(grant.id);
          deleted++;
        } catch (err) {
          log.error('[Pipeline] Failed to delete grant:', grant.id, err);
        }
      }

      log.info('[Pipeline] Mismatch delete complete. Deleted:', deleted, 'of', mismatchedGrants.length);
      return deleted;
    },
    onSuccess: (count) => {
      log.info('[Pipeline] Mismatch delete success, invalidating queries');
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin, selectedOrgId] });

      setShowRemoveMismatchConfirm(false);

      setTimeout(() => {
        toast({
          title: "Low-Match Grants Removed",
          description: `Successfully removed ${count} grant${count > 1 ? 's' : ''} with match scores below 40%.`,
        });
      }, 300);
    },
    onError: (error) => {
      log.error('[Pipeline] Mismatch delete error:', error);
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin, selectedOrgId] });
      setShowRemoveMismatchConfirm(false);
      toast({
        variant: "destructive",
        title: "Removal Failed",
        description: error.message || "There was an error removing mismatched grants.",
      });
    }
  });

  const allTags = useMemo(() => {
    const tagSet = new Set();
    grants.forEach(grant => {
      if (grant.tags && Array.isArray(grant.tags)) {
        grant.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return Array.from(tagSet).sort();
  }, [grants]);

  // Use the shared helper for consistency
  const expiredGrants = useMemo(() => getExpiredGrants(grants), [grants]);

  // Get mismatched grants (low match scores)
  const mismatchedGrants = useMemo(() => {
    if (!selectedOrgId) return [];
    return grants.filter(g => 
      g.organization_id === selectedOrgId && 
      (g.match_score === null || g.match_score === undefined || g.match_score < 40)
    );
  }, [grants, selectedOrgId]);

  const handleGrantUpdate = (grantId, data) => {
    updateGrantMutation.mutate({ id: grantId, data });
  };

  const handleDeleteGrant = () => {
    if (grantToDelete?.id) {
      deleteGrantMutation.mutate(grantToDelete.id);
    }
  };

  // Background auto-advance mutation
  // PART 3: Pass BOTH organization_id AND profile_id for per-profile isolation
  const autoAdvanceMutation = useMutation({
    mutationFn: async () => {
      const response = await base44.functions.invoke('runBackgroundAutoAdvance', {
        body: {
          organization_id: selectedOrgId || undefined,
          profile_id: selectedOrgId || undefined  // CRITICAL: For per-profile pipeline isolation
        }
      });
      
      // Handle axios response structure
      const data = response?.data || response;
      if (data?.error) throw new Error(data.error);
      return data?.data || data;
    },
    onSuccess: (data) => {
      const jobId = data?.job_id || data?.jobId || data?.job?.id;
      if (jobId) {
        setBackgroundJobId(jobId);
        
        toast({
          title: '🚀 Auto-Advance Started',
          description: 'Running in background. You can continue working.',
        });
      }
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Auto-Advance Failed',
        description: error?.message || 'Failed to start auto-advance',
      });
    }
  });

  const handleAutoAdvance = () => {
    autoAdvanceMutation.mutate();
  };

  const isLoading = isLoadingGrants || isLoadingOrgs;

  // Helper to get field from either root or nested data (SDK returns data in nested 'data' object)
  const getField = (g, field) => {
    if (!g) return undefined;
    if (g[field] !== undefined) return g[field];
    if (g.data && g.data[field] !== undefined) return g.data[field];
    return undefined;
  };

  const eligibleForAutoAdvance = grants.filter(g => {
    const status = getField(g, 'status');
    const aiStatus = getField(g, 'ai_status');
    return ['discovered', 'interested'].includes(status) &&
      (!aiStatus || aiStatus === 'idle' || aiStatus === 'error');
  }).length;

  const analyzingCount = grants.filter(g => {
    const aiStatus = getField(g, 'ai_status');
    return aiStatus === 'queued' || aiStatus === 'running';
  }).length;

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  const hasActiveFilters = (
    filters.search ||
    filters.deadlineStatus !== 'all' ||
    (filters.minAmount ?? '') !== '' ||
    (filters.maxAmount ?? '') !== '' ||
    (Array.isArray(filters.funderTypes) && filters.funderTypes.length > 0) ||
    (Array.isArray(filters.tags) && filters.tags.length > 0) ||
    selectedOrgId ||
    filters.hideExpired ||
    filters.showOnlyExpired ||
    filters.deadlineAfter ||
    filters.deadlineBefore ||
    filters.matchScoreMin > 0 ||
    (Array.isArray(filters.applicationMethods) && filters.applicationMethods.length > 0) ||
    (Array.isArray(filters.opportunityTypes) && filters.opportunityTypes.length > 0)
  );

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Grant Pipeline</h1>
            <p className="text-slate-600 mt-2">Track and manage funding opportunities</p>
          </div>
          <div className="flex gap-3">
            {eligibleForAutoAdvance > 0 && (
              <Button
                onClick={handleAutoAdvance}
                disabled={autoAdvanceMutation.isPending || backgroundJobId}
                className="bg-purple-600 hover:bg-purple-700 shadow-lg"
              >
                <Zap className="w-4 h-4 mr-2" />
                Auto-Advance {eligibleForAutoAdvance} Grant{eligibleForAutoAdvance !== 1 ? 's' : ''}
              </Button>
            )}
            <Link to={createPageUrl("DiscoverGrants")}>
              <Button className="bg-blue-600 hover:bg-blue-700 shadow-lg">
                <Plus className="w-4 h-4 mr-2" />
                Discover More
              </Button>
            </Link>
          </div>
        </div>

        {/* AI Analysis Progress */}
        {analyzingCount > 0 && (
          <Alert className="mb-6 bg-gradient-to-r from-purple-50 to-blue-50 border-purple-200">
            <Loader2 className="h-4 w-4 animate-spin text-purple-600" />
            <AlertDescription className="text-purple-900">
              <div className="flex items-center justify-between">
                <div>
                  <strong>🤖 AI Analysis in Progress</strong>
                  <p className="text-sm mt-1">
                    {analyzingCount} grant{analyzingCount > 1 ? 's' : ''} being analyzed.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="bg-white">
                    {analyzingCount} analyzing
                  </Badge>
                  <Button
                    onClick={() => resetAnalysisMutation.mutate()}
                    size="sm"
                    variant="destructive"
                    disabled={resetAnalysisMutation.isPending}
                  >
                    {resetAnalysisMutation.isPending ? 'Resetting...' : 'Reset Status'}
                  </Button>
                </div>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Background Job Status */}
        {backgroundJobId && (
          <BackgroundJobStatus 
            jobId={backgroundJobId}
            onComplete={() => {
              setBackgroundJobId(null);
              // FIXED: Include selectedOrgId in query key for proper invalidation
              queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin, selectedOrgId] });
              queryClient.invalidateQueries({ queryKey: ['recentTimeEntries', user?.email] });
            }}
          />
        )}

        {/* Advanced Filters */}
        <AdvancedFilters
          filters={filters}
          onFiltersChange={setFilters}
          availableTags={allTags}
          onClearFilters={() => setFilters({
            search: '',
            deadlineStatus: 'all',
            hideExpired: false,
            showOnlyExpired: false,
            deadlineAfter: '',
            deadlineBefore: '',
            matchScoreMin: 0,
            minAmount: '',
            maxAmount: '',
            funderTypes: [],
            applicationMethods: [],
            opportunityTypes: [],
            tags: [],
            keywordIncludesAllTerms: false,
          })}
        />

        {/* Expired Grants Alert */}
        {expiredGrants.length > 0 && (
          <Alert className="mb-6 bg-amber-50 border-amber-200">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-900">
              <div className="flex items-center justify-between">
                <span>
                  <strong>{expiredGrants.length} expired grant{expiredGrants.length !== 1 ? 's' : ''}</strong> with past deadlines.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setExpiredCountAtOpen(expiredGrants.length);
                    setShowBulkDeleteConfirm(true);
                  }}
                  className="ml-4"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Expired
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Mismatched Grants Alert */}
        {selectedOrgId && mismatchedGrants.length > 0 && (
          <Alert className="mb-6 bg-red-50 border-red-200">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-900">
              <div className="flex items-center justify-between">
                <span>
                  <strong>{mismatchedGrants.length} grant{mismatchedGrants.length !== 1 ? 's' : ''}</strong> with low match scores (&lt;40%) for this profile.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMismatchCountAtOpen(mismatchedGrants.length);
                    setShowRemoveMismatchConfirm(true);
                  }}
                  className="ml-4"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Remove Mismatched
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Pipeline Board */}
        {filteredGrants.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-lg border border-slate-200">
            <p className="text-slate-500">
              {hasActiveFilters
                ? 'No grants match your current filters'
                : 'No grants in your pipeline yet'}
            </p>
            <Link to={createPageUrl('DiscoverGrants')} className="inline-block mt-4">
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Discover Opportunities
              </Button>
            </Link>
          </div>
        ) : (
          <KanbanBoard
            grants={filteredGrants}
            organizations={organizations}
            onUpdateGrant={handleGrantUpdate}
            onDeleteGrant={(grant) => setGrantToDelete(grant)}
            selectedOrganization={selectedOrgId ? organizations.find(o => o.id === selectedOrgId) : null}
          />
        )}

        {/* Delete Grant Dialog */}
        <AlertDialog open={!!grantToDelete} onOpenChange={() => setGrantToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete the grant "{grantToDelete?.title}". This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteGrantMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteGrant}
                className="bg-red-600 hover:bg-red-700"
                disabled={deleteGrantMutation.isPending}
              >
                {deleteGrantMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting...</>
                ) : (
                  'Delete'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Bulk Delete Expired Dialog */}
        {showBulkDeleteConfirm && expiredCountAtOpen > 0 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="fixed inset-0 bg-black/50" onClick={(e) => {
                if (bulkDeleteExpiredMutation.isPending) return;
                if (e.target === e.currentTarget) setShowBulkDeleteConfirm(false);
            }} />
            <div className="relative bg-white rounded-lg shadow-lg p-6 max-w-md w-full mx-4 z-50">
              <h2 className="text-lg font-semibold mb-2">Remove All Expired Grants?</h2>
              <p className="text-sm text-slate-600 mb-6">
                This will permanently delete <strong>{expiredCountAtOpen} expired grant{expiredCountAtOpen > 1 ? 's' : ''}</strong>.
                This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowBulkDeleteConfirm(false)}
                  disabled={bulkDeleteExpiredMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    log.info('[Pipeline] Delete button clicked, calling mutate...');
                    bulkDeleteExpiredMutation.mutate();
                  }}
                  className="bg-red-600 hover:bg-red-700 text-white"
                  disabled={bulkDeleteExpiredMutation.isPending}
                >
                  {bulkDeleteExpiredMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting...</>
                  ) : (
                    `Delete ${expiredCountAtOpen} Grant${expiredCountAtOpen > 1 ? 's' : ''}`
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Bulk Delete Mismatched Dialog */}
        {showRemoveMismatchConfirm && mismatchCountAtOpen > 0 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="fixed inset-0 bg-black/50" onClick={(e) => {
                if (bulkDeleteMismatchMutation.isPending) return;
                if (e.target === e.currentTarget) setShowRemoveMismatchConfirm(false);
            }} />
            <div className="relative bg-white rounded-lg shadow-lg p-6 max-w-md w-full mx-4 z-50">
              <h2 className="text-lg font-semibold mb-2">Remove Low-Match Grants?</h2>
              <p className="text-sm text-slate-600 mb-6">
                This will permanently delete <strong>{mismatchCountAtOpen} grant{mismatchCountAtOpen > 1 ? 's' : ''}</strong> with match scores below 40%.
                These grants don't match the selected profile's demographics and needs.
              </p>
              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowRemoveMismatchConfirm(false)}
                  disabled={bulkDeleteMismatchMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    log.info('[Pipeline] Remove mismatched button clicked');
                    bulkDeleteMismatchMutation.mutate();
                  }}
                  className="bg-red-600 hover:bg-red-700 text-white"
                  disabled={bulkDeleteMismatchMutation.isPending}
                >
                  {bulkDeleteMismatchMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Removing...</>
                  ) : (
                    `Remove ${mismatchCountAtOpen} Grant${mismatchCountAtOpen > 1 ? 's' : ''}`
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}