import React, { useState, useEffect, useMemo } from "react";
import client from '@/api/client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Filter, Loader2, RefreshCcw, Trash2, UserCheck, Printer, Sparkles } from "lucide-react";
import { getCrawlerJob, createCrawlerJob } from "@/api/crawlers";
import KanbanBoard from "@/components/pipeline/KanbanBoard";
import AdvancedFilters from "@/components/pipeline/AdvancedFilters";
import { HamiltonSelectionProvider } from "@/components/hamilton/HamiltonSelectionContext";
import HamiltonSelectionToolbar from "@/components/hamilton/HamiltonSelectionToolbar";
import HamiltonAutomationQueue from "@/components/hamilton/HamiltonAutomationQueue";
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
import { useToast } from "@/components/ui/use-toast";
import { useFilteredGrants } from "@/components/hooks/useFilteredGrants";
import { isGrantExpired } from "@/components/shared/grantUtils";
import { createPageUrl } from "@/utils";
import { countBy } from "lodash";
import { listProfiles } from "@/api/profiles";
import { apiFetch } from "@/api/client";
import { env } from "@/config/env.js";
import { useAuthStore } from "@/stores/authStore";

export default function Pipeline() {
  const [selectedProfileId, setSelectedProfileId] = useState("all");
  const [grantToDelete, setGrantToDelete] = useState(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [isProcessAllPending, setIsProcessAllPending] = useState(false);
  const [processAllJobId, setProcessAllJobId] = useState(null);
  const [filters, setFilters] = useState({
    search: '',
    minAmount: '',
    maxAmount: '',
    funderTypes: [],
    applicationMethods: [],
    opportunityTypes: [],
    tags: [],
    hideExpired: false,
    showOnlyExpired: false,
  });
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = useAuthStore((state) => Boolean(state?.user?.is_admin));

  const profilesQuery = useQuery({
    queryKey: ['profiles', 'pipeline-selector'],
    queryFn: () => listProfiles({ summary: true }),
    staleTime: 60_000,
  })
  const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : []

  const selectedProfile = useMemo(() => {
    if (!selectedProfileId || selectedProfileId === 'all') return null
    return profiles.find((p) => p.id === selectedProfileId) ?? null
  }, [profiles, selectedProfileId])

  const selectedProfileOrgId = selectedProfile?.organization_id ?? null

  // SECURITY / DATA INTEGRITY:
  // If the URL/local state carries an invalid profile id (not in the accessible profile list),
  // do NOT apply it. This prevents cross-profile bleed from stale links/localStorage.
  useEffect(() => {
    if (!selectedProfileId || selectedProfileId === 'all') return
    if (profiles.length === 0) return
    const ok = profiles.some((p) => String(p?.id) === String(selectedProfileId))
    if (!ok) {
      console.warn('[Pipeline] Invalid selectedProfileId (not in accessible profiles); resetting', {
        selectedProfileId,
        profileCount: profiles.length,
      })
      setSelectedProfileId('all')
    }
  }, [profiles, selectedProfileId])

  // Initialize selectedProfileId from URL.
  // Back-compat: if older links passed organization_id, try mapping it to a profile id.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const profileId = params.get('profile_id');
    const legacyOrgId = params.get('organization_id');

    if (profileId) {
      setSelectedProfileId(profileId);
      return
    }

    if (legacyOrgId && profiles.length > 0) {
      const mapped =
        profiles.find((p) => p.organization_id === legacyOrgId) ??
        profiles.find((p) => p.id === legacyOrgId) ??
        null
      if (mapped?.id) {
        setSelectedProfileId(mapped.id)
      }
    }
  }, [location.search, profiles]);

  // Keep active profile in sync so API requests return the selected profile's pipeline.
  useEffect(() => {
    if (selectedProfileId && selectedProfileId !== 'all') {
      client.setActiveProfileId?.(String(selectedProfileId))
    } else {
      client.setActiveProfileId?.(null)
    }
  }, [selectedProfileId])

  // Poll Process All job status for progress display
  const processAllJobQuery = useQuery({
    queryKey: ["crawler-job", processAllJobId],
    queryFn: () => getCrawlerJob(processAllJobId),
    enabled: Boolean(processAllJobId),
    refetchInterval: 3000,
  });
  const processAllJob = processAllJobQuery?.data ?? null;
  const processAllJobStatus = processAllJob?.status ?? "";
  const processAllJobMeta = processAllJob?.result_meta ?? {};

  // When Process All job completes, refresh grants and show result
  useEffect(() => {
    if (!processAllJobId || !processAllJob) return;
    if (!["completed", "failed", "cancelled"].includes(processAllJobStatus)) return;

    queryClient.invalidateQueries({ queryKey: ["grants"] });
    queryClient.invalidateQueries({ queryKey: ["grants-pipeline"] });
    queryClient.invalidateQueries({ queryKey: ["grants", "pipeline"] });
    setProcessAllJobId(null);
    setIsProcessAllPending(false);

    if (processAllJobStatus === "completed") {
      const { evaluated = 0, advanced = 0, handoffs = 0 } = processAllJobMeta;
      toast({
        title: "Process All completed",
        description: `Evaluated ${evaluated} grant(s). ${advanced} advanced, ${handoffs} need review.`,
      });
      // Anya goal #4: every prompt leaves the user knowing what to do next.
      // When the automation flagged grants for human review, fire a second
      // warmer toast that points at the cards rather than a number.
      if (handoffs > 0) {
        toast({
          id: `pipeline-handoffs-${processAllJobId}`,
          title: `${handoffs} grant${handoffs === 1 ? "" : "s"} need a person to step in`,
          description:
            "GrantFlow prepared the next steps, but a person must finish this part. Click to jump to the cards that need attention.",
          duration: 12000,
          // Clickable: flash the Human-Review-Needed cards already on this page.
          flash: "human-review",
        });
      }
    } else if (processAllJobStatus === "failed") {
      toast({
        variant: "destructive",
        title: "Process All failed",
        description: processAllJob?.error || "Pipeline automation job failed.",
      });
    }
  }, [
    processAllJobId,
    processAllJob,
    processAllJobStatus,
    processAllJobMeta,
    queryClient,
    toast,
  ]);

  const vnextAppsQuery = useQuery({
    queryKey: ["vnext-applications", selectedProfileId],
    enabled: env.shouldersVnext && Boolean(selectedProfileId) && selectedProfileId !== "all",
    queryFn: () =>
      apiFetch(
        `/api/vnext/applications?profile_id=${encodeURIComponent(String(selectedProfileId))}&limit=200`,
      ),
  })
  const vnextApps = Array.isArray(vnextAppsQuery.data) ? vnextAppsQuery.data : []
  const vnextCounts = useMemo(() => countBy(vnextApps, (a) => a?.state || "UNKNOWN"), [vnextApps])

  // Sync selectedProfileId to URL (canonical param: profile_id).
  // Also remove legacy organization_id param to avoid future confusion.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const currentProfileId = params.get('profile_id')

    if (selectedProfileId !== 'all' && selectedProfileId !== currentProfileId) {
      params.set('profile_id', selectedProfileId)
      params.delete('organization_id')
      navigate(`?${params.toString()}`, { replace: true })
    } else if (selectedProfileId === 'all' && currentProfileId) {
      params.delete('profile_id')
      params.delete('organization_id')
      navigate(`?${params.toString()}`, { replace: true })
    }
  }, [selectedProfileId, navigate, location.search]);

  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', 'pipeline', selectedProfileId],
    queryFn: () =>
      client.entities.Grant.list(
        '-created_date',
        2000,
        selectedProfileId && selectedProfileId !== 'all' ? { profile_id: selectedProfileId } : {},
      ),
  });

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list(),
  });

  const updateGrantMutation = useMutation({
    mutationFn: ({ id, data }) => client.entities.Grant.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
    },
  });

  const deleteGrantMutation = useMutation({
    mutationFn: (id) => client.entities.Grant.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
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

  const bulkDeleteMutation = useMutation({
    mutationFn: async (grantIds) => {
      // Parallelize deletions for better performance
      await Promise.all(grantIds.map(id => client.entities.Grant.delete(id)));
    },
    onSuccess: (_, grantIds) => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      setShowBulkDeleteConfirm(false);
      toast({
        title: "Expired Grants Removed",
        description: `Successfully removed ${grantIds.length} expired grant${grantIds.length > 1 ? 's' : ''}.`,
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Bulk Delete Failed",
        description: error.message || "There was an error during bulk deletion.",
      });
    }
  });

  // Extract all unique tags from grants - memoized
  const allTags = useMemo(() => {
    const tagSet = new Set();
    grants.forEach(grant => {
      if (grant.tags && Array.isArray(grant.tags)) {
        grant.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return Array.from(tagSet).sort();
  }, [grants]);

  const scopedGrants = useMemo(() => {
    if (!selectedProfileId || selectedProfileId === 'all') return grants
    return (Array.isArray(grants) ? grants : []).filter((g) => {
      // CRITICAL: When a specific profile is selected, ONLY show grants explicitly assigned to it.
      // Do NOT fall back to organization_id, which can cause cross-profile leakage when orgs are shared.
      return Boolean(g?.profile_id) && String(g.profile_id) === String(selectedProfileId)
    })
  }, [grants, selectedProfileId])

  // Count of grants needing a human to step in. We treat both
  // (a) the stage-level human-required statuses, and (b) the latest
  // automation event's handoff_required flag as triggers — same rule the
  // per-card "Human Review Needed" badge uses. Computed across the
  // currently-scoped grants so it reflects the visible board.
  const handoffsNeededCount = useMemo(() => {
    const HUMAN_STAGES = new Set(['portal', 'follow_up', 'report']);
    return (Array.isArray(scopedGrants) ? scopedGrants : []).filter((g) => {
      if (!g) return false;
      if (g.latest_automation?.handoff_required === true) return true;
      if (g.latestAutomation?.handoff_required === true) return true;
      return HUMAN_STAGES.has(String(g.status || '').toLowerCase());
    }).length;
  }, [scopedGrants]);

  const filteredGrants = useFilteredGrants(scopedGrants, filters, 'all');

  // Get all expired grants in "discovered" or "interested" status
  const expiredDiscoveredGrants = useMemo(() => {
    return grants.filter(grant => 
      isGrantExpired(grant) && 
      ['discovered', 'interested'].includes(grant.status)
    );
  }, [grants]);

  const handleGrantUpdate = (grantId, data) => {
    updateGrantMutation.mutate({ id: grantId, data });
  };
  
  const handleDeleteGrant = () => {
    if (grantToDelete) {
      deleteGrantMutation.mutate(grantToDelete.id);
    }
  };

  const handleBulkDelete = () => {
    const expiredIds = expiredDiscoveredGrants.map(g => g.id);
    bulkDeleteMutation.mutate(expiredIds);
  };

  // Hamilton "keep only what I picked" flow: delete the pipeline cards the
  // user did NOT select for Hamilton. Returns a promise so the toolbar can
  // show its own progress/confirmation.
  const handleDeleteUnselectedForHamilton = async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    await Promise.all(ids.map((id) => client.entities.Grant.delete(id)));
    queryClient.invalidateQueries({ queryKey: ['grants'] });
  };

  const handleProcessAll = async () => {
    if (!isAdmin) return
    if (isProcessAllPending) return

    // If a specific profile is selected, process that profile’s pipeline.
    // If "All profiles" is selected, run globally (bounded by a server-side limit).
    const forProfile = selectedProfileId && selectedProfileId !== 'all' ? String(selectedProfileId) : null

    setIsProcessAllPending(true)
    toast({
      title: 'Process All queued',
      description: forProfile
        ? 'Queuing pipeline automation for the selected profile…'
        : 'Queuing pipeline automation across all profiles…',
    })

    try {
      const payload = {
        type: 'pipeline_automation',
        ...(forProfile ? { profile_id: forProfile } : {}),
        parameters: {
          process_all: true,
          ...(forProfile ? { limit: 200 } : { limit: 100 }),
        },
      }

      const job = await createCrawlerJob(payload)
      const jobId = job?.id ?? job?.jobId

      if (jobId) {
        setProcessAllJobId(jobId)
      } else {
        toast({
          title: 'Pipeline automation started',
          description: 'Job queued. Progress cannot be tracked.',
        })
      }
      setIsProcessAllPending(false)
    } catch (error) {
      setIsProcessAllPending(false)
      toast({
        variant: 'destructive',
        title: 'Process All failed',
        description: error?.message || 'Unable to queue pipeline automation.',
      })
    }
  }

  // Handle filter conflicts - ensure hideExpired and showOnlyExpired are mutually exclusive
  const handleFiltersChange = (newFilters) => {
    if (newFilters.hideExpired && filters.showOnlyExpired) {
      newFilters.showOnlyExpired = false;
    } else if (newFilters.showOnlyExpired && filters.hideExpired) {
      newFilters.hideExpired = false;
    }
    setFilters(newFilters);
  };

  const isLoading = isLoadingGrants || isLoadingOrgs;

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  const hasActiveFilters = filters.search !== '' || 
                          filters.minAmount !== '' || 
                          filters.maxAmount !== '' ||
                          filters.funderTypes.length > 0 ||
                          filters.applicationMethods.length > 0 ||
                          filters.opportunityTypes.length > 0 ||
                          filters.tags.length > 0 ||
                          filters.hideExpired ||
                          filters.showOnlyExpired ||
                          selectedProfileId !== "all";

  return (
    <HamiltonSelectionProvider enabled={true}>
    <div className="p-6 md:p-8 space-y-6">
      <div className="max-w-full mx-auto">
        <div className="flex flex-col gap-4 mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900">Master Grant Pipeline</h1>
              <p className="text-slate-600 mt-2">
                Track all your grants across every profile • {filteredGrants.length} of {scopedGrants.length} grants
              </p>
              {handoffsNeededCount > 0 && (
                <p
                  className="mt-2 inline-flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 px-3 py-1.5 text-sm font-medium"
                  role="status"
                  aria-live="polite"
                >
                  <UserCheck className="w-4 h-4" />
                  {handoffsNeededCount} grant{handoffsNeededCount === 1 ? "" : "s"} need a person to step in
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-slate-500" />
              <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Filter by profile..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All profiles</SelectItem>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.display_name || profile.organization_name || profile.name || profile.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isAdmin && (
                <Button
                  variant="default"
                  onClick={handleProcessAll}
                  disabled={isProcessAllPending}
                  aria-label="Process all pipeline grants"
                >
                  {isProcessAllPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Processing…
                    </>
                  ) : (
                    <>
                      <RefreshCcw className="w-4 h-4 mr-2" />
                      Process All
                    </>
                  )}
                </Button>
              )}
              {expiredDiscoveredGrants.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => setShowBulkDeleteConfirm(true)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  aria-label="Remove expired grants"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Remove {expiredDiscoveredGrants.length} Expired
                </Button>
              )}
              {/*
                Print This Profile's Packet — only shown when a specific
                profile is selected. The packet renders profile summary,
                pipeline by stage, human-review items with prepared
                application steps, and a next-steps checklist. Opens in a
                new tab so the in-app session stays intact.
              */}
              {selectedProfileId && selectedProfileId !== "all" && (
                <Button
                  variant="outline"
                  onClick={() =>
                    window.open(
                      `/PrintProfilePacket?profile_id=${encodeURIComponent(selectedProfileId)}`,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                  aria-label="Print this profile's packet"
                >
                  <Printer className="w-4 h-4 mr-2" />
                  Print This Profile's Packet
                </Button>
              )}
              {/*
                Process Funding Sources with Hamilton — opens a focused, full
                worklist (per-source Process / Leave / Delete) in a new tab so
                the user can triage Hamilton work without losing the board.
                Only meaningful for a specific profile, since Hamilton needs to
                know whose application to complete.
              */}
              {selectedProfileId && selectedProfileId !== "all" && (
                <Button
                  variant="default"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  onClick={() =>
                    window.open(
                      `/HamiltonProcessing?profile_id=${encodeURIComponent(selectedProfileId)}`,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                  aria-label="Process funding sources with Hamilton"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  Process with Hamilton
                </Button>
              )}
            </div>
          </div>

          {/* Advanced Filters */}
          <AdvancedFilters
            filters={filters}
            onFiltersChange={handleFiltersChange}
            allTags={allTags}
          />

          {/* Process All progress */}
          {processAllJobId && (
            <Alert>
              <Loader2 className="h-4 w-4 animate-spin" />
              <AlertDescription className="ml-2">
                {processAllJobStatus === "queued" && "Pipeline automation queued. Waiting for worker…"}
                {processAllJobStatus === "running" && "Processing pipeline grants…"}
                {processAllJobStatus === "completed" && (
                  <>
                    Done: {processAllJobMeta.evaluated ?? 0} evaluated, {processAllJobMeta.advanced ?? 0} advanced,{" "}
                    {processAllJobMeta.handoffs ?? 0} need review.
                  </>
                )}
                {processAllJobStatus === "failed" && `Failed: ${processAllJob?.error ?? "Unknown error"}`}
                {!["queued", "running", "completed", "failed"].includes(processAllJobStatus) &&
                  `Status: ${processAllJobStatus || "…"}`}
              </AlertDescription>
            </Alert>
          )}
        </div>

        {env.shouldersVnext && selectedProfileId !== "all" ? (
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">vNext Applications</h2>
                <p className="text-sm text-slate-600">
                  {vnextAppsQuery.isLoading ? "Loading…" : `${vnextApps.length} applications`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                {Object.entries(vnextCounts).slice(0, 8).map(([state, count]) => (
                  <span key={state} className="rounded-full bg-slate-100 px-2 py-1">
                    {state}: {count}
                  </span>
                ))}
              </div>
            </div>

            {vnextApps.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {vnextApps.slice(0, 10).map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <div className="text-sm">
                      <span className="font-medium">{a.state}</span>
                      <span className="text-slate-500"> — EV: </span>
                      <span className="text-slate-700">
                        {a.expected_value !== null ? Number(a.expected_value).toFixed(2) : "—"}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate(`/VNextApplication?id=${encodeURIComponent(a.id)}`)}
                    >
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                Create a vNext application from Funding Opportunities (when enabled).
              </p>
            )}
          </div>
        ) : null}

        <div className="mt-4 flex-1 overflow-x-auto">
          {filteredGrants.length === 0 ? (
            <div className="text-center py-20">
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                {hasActiveFilters ? "No Grants Match Your Filters" : "No Applications Yet"}
              </h3>
              <p className="text-slate-600 mb-4">
                {hasActiveFilters
                  ? "Try adjusting your search criteria or filters to see more results."
                  : "Find grants that match your organization, then add them here to track and submit."}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                {hasActiveFilters ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFilters({
                        search: '',
                        minAmount: '',
                        maxAmount: '',
                        funderTypes: [],
                        applicationMethods: [],
                        opportunityTypes: [],
                        tags: [],
                        hideExpired: false,
                        showOnlyExpired: false,
                      });
                      setSelectedProfileId("all");
                    }}
                  >
                    Clear All Filters
                  </Button>
                ) : (
                  <Button asChild variant="default" className="gap-2">
                    <Link to={createPageUrl("DiscoverGrants")}>Find Grants</Link>
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <KanbanBoard 
              grants={filteredGrants}
              organizations={organizations}
              onGrantUpdate={handleGrantUpdate}
              onGrantDelete={setGrantToDelete}
            />
          )}
        </div>
      </div>

      {/* Single Delete Dialog */}
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

      {/* Bulk Delete Dialog */}
      <AlertDialog open={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove All Expired Grants?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{expiredDiscoveredGrants.length} expired grant{expiredDiscoveredGrants.length > 1 ? 's' : ''}</strong> that are in "Discovered" or "Interested" status. Grants in later stages (Drafting, Submitted, etc.) will not be affected.
              <br/><br/>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting...</>
              ) : (
                `Delete ${expiredDiscoveredGrants.length} Grant${expiredDiscoveredGrants.length > 1 ? 's' : ''}`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <HamiltonSelectionToolbar
        profileId={selectedProfileId && selectedProfileId !== 'all' ? selectedProfileId : null}
        grants={filteredGrants}
        onDeleteGrants={handleDeleteUnselectedForHamilton}
      />
      {selectedProfileId && selectedProfileId !== 'all' && (
        <div className="max-w-full mx-auto mt-6">
          <HamiltonAutomationQueue profileId={selectedProfileId} />
        </div>
      )}
    </div>
    </HamiltonSelectionProvider>
  );
}