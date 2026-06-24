import React, { useState, useEffect, useMemo } from "react";
import client from '@/api/client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Filter, Loader2, RefreshCcw, Trash2, UserCheck, Printer, Sparkles, KeyRound } from "lucide-react";
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
import { Money } from "@/components/ui/Money";
import { canonicalStage } from "../../shared/pipelineStages.js";

// "Your funding current" track: the four high-level phases of the pipeline,
// matching design/grantflow-dashboard.html. Each canonical Kanban stage rolls
// up into one phase so the live board collapses into a readable current.
const FUNDING_CURRENT_PHASES = [
  { key: "preparing", label: "Preparing", statuses: ["discovered", "saved", "interested", "gathering_documents", "drafting", "ready_to_submit"] },
  { key: "applied", label: "Applied", statuses: ["submitted"] },
  { key: "under_review", label: "Under review", statuses: ["follow_up"] },
  { key: "awarded", label: "Awarded", statuses: ["awarded"], awarded: true },
];

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

// Best-estimate dollar value for a grant card (requested → max → min → amount).
function grantValue(grant) {
  const candidates = [grant?.amount_requested, grant?.amount_awarded, grant?.amount_max, grant?.amount_min, grant?.amount];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

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
  // Guard: only reset once profiles have actually loaded, so we don't fight the
  // URL-init effect when a valid-but-not-yet-loaded profile id is present.
  useEffect(() => {
    if (!selectedProfileId || selectedProfileId === 'all') return
    if (profilesQuery.isLoading) return
    if (profiles.length === 0) return
    const ok = profiles.some((p) => String(p?.id) === String(selectedProfileId))
    if (!ok) {
      console.warn('[Pipeline] Invalid selectedProfileId (not in accessible profiles); resetting', {
        selectedProfileId,
        profileCount: profiles.length,
      })
      setSelectedProfileId('all')
    }
  }, [profiles, selectedProfileId, profilesQuery.isLoading])

  // Initialize selectedProfileId from URL.
  // Back-compat: if older links passed organization_id, try mapping it to a profile id.
  // Validate the URL-provided profileId against loaded profiles before applying
  // (when profiles are loaded); otherwise apply optimistically and let the
  // validation effect above clean up once profiles arrive.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const profileId = params.get('profile_id');
    const legacyOrgId = params.get('organization_id');

    if (profileId) {
      if (!profilesQuery.isLoading && profiles.length > 0) {
        const ok = profiles.some((p) => String(p?.id) === String(profileId))
        if (ok) {
          setSelectedProfileId(profileId);
        } else {
          console.warn('[Pipeline] URL profile_id not in accessible profiles; ignoring', { profileId })
          setSelectedProfileId('all');
        }
      } else {
        // Profiles not loaded yet: apply optimistically; validation effect reconciles.
        setSelectedProfileId(profileId);
      }
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
  }, [location.search, profiles, profilesQuery.isLoading]);

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
    retry: 2,
  });
  const processAllJob = processAllJobQuery?.data ?? null;
  const processAllJobStatus = processAllJob?.status ?? "";
  const processAllJobMeta = processAllJob?.result_meta ?? {};
  const processAllJobError = processAllJobQuery?.error ?? null;

  // Handle a failed polling query: surface the error and stop the spinner so
  // the user isn't left with a silently stuck "Processing…" state.
  useEffect(() => {
    if (!processAllJobId) return;
    if (!processAllJobQuery.isError) return;

    toast({
      variant: "destructive",
      title: "Process All status unavailable",
      description:
        processAllJobError?.message ||
        "Unable to fetch pipeline automation job status. The job may still be running.",
    });
    setProcessAllJobId(null);
    setIsProcessAllPending(false);
  }, [processAllJobId, processAllJobQuery.isError, processAllJobError, toast]);

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
  // Only treat data as a usable array when the query is not loading/erroring
  // and the payload is genuinely an array. Otherwise fall back to [].
  const vnextApps =
    !vnextAppsQuery.isLoading && !vnextAppsQuery.isError && Array.isArray(vnextAppsQuery.data)
      ? vnextAppsQuery.data
      : []
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
      // Use allSettled so a single failure doesn't abort the rest. Collect the
      // succeeded/failed ids so the caller can report accurate counts.
      const results = await Promise.allSettled(
        grantIds.map((id) => client.entities.Grant.delete(id)),
      );
      const succeeded = [];
      const failed = [];
      results.forEach((res, idx) => {
        if (res.status === "fulfilled") {
          succeeded.push(grantIds[idx]);
        } else {
          failed.push(grantIds[idx]);
        }
      });
      return { succeeded, failed };
    },
    onSuccess: ({ succeeded, failed }) => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      setShowBulkDeleteConfirm(false);
      if (failed.length === 0) {
        toast({
          title: "Expired Grants Removed",
          description: `Successfully removed ${succeeded.length} expired grant${succeeded.length === 1 ? '' : 's'}.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Some Grants Could Not Be Removed",
          description: `Removed ${succeeded.length}, ${failed.length} failed. Please try again for the remaining grants.`,
        });
      }
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
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

  // "Your funding current" rollup — bucket the scoped grants into the four
  // high-level phases shown in the track band. Counts + estimated dollar value
  // per phase, derived live from the same grants the board renders.
  const fundingCurrent = useMemo(() => {
    const totals = Object.fromEntries(
      FUNDING_CURRENT_PHASES.map((p) => [p.key, { count: 0, amount: 0 }]),
    );
    const phaseByStatus = new Map();
    for (const phase of FUNDING_CURRENT_PHASES) {
      for (const status of phase.statuses) phaseByStatus.set(status, phase.key);
    }
    for (const grant of Array.isArray(scopedGrants) ? scopedGrants : []) {
      if (!grant) continue;
      const canon = canonicalStage(grant.status);
      const phaseKey = phaseByStatus.get(canon);
      if (!phaseKey) continue;
      totals[phaseKey].count += 1;
      totals[phaseKey].amount += grantValue(grant);
    }
    return totals;
  }, [scopedGrants]);

  const fundingCurrentTotal = useMemo(
    () => Object.values(fundingCurrent).reduce((sum, p) => sum + p.amount, 0),
    [fundingCurrent],
  );

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
    // Defensive null check: state may have been cleared between render and invocation.
    if (grantToDelete && grantToDelete.id) {
      deleteGrantMutation.mutate(grantToDelete.id);
    }
  };

  const handleBulkDelete = () => {
    const expiredIds = expiredDiscoveredGrants.map(g => g.id);
    bulkDeleteMutation.mutate(expiredIds);
  };

  // Hamilton "keep only what I picked" flow: delete the pipeline cards the
  // user did NOT select for Hamilton. Returns a promise so the toolbar can
  // show its own progress/confirmation. Uses allSettled so a single failure
  // doesn't abort the rest, always invalidates the cache, and reports failures.
  const handleDeleteUnselectedForHamilton = async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
      const results = await Promise.allSettled(
        ids.map((id) => client.entities.Grant.delete(id)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const succeeded = results.length - failed;
      if (failed > 0) {
        toast({
          variant: "destructive",
          title: "Some Grants Could Not Be Removed",
          description: `Removed ${succeeded}, ${failed} failed. Please try again for the remaining grants.`,
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error?.message || "There was an error removing the unselected grants.",
      });
    } finally {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
    }
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
        // Keep isProcessAllPending true while the job is queued/running; the
        // completion (or polling-error) effect will clear it. This prevents
        // the user from queuing duplicate jobs while one is in flight.
        setProcessAllJobId(jobId)
      } else {
        toast({
          title: 'Pipeline automation started',
          description: 'Job queued. Progress cannot be tracked.',
        })
        setIsProcessAllPending(false)
      }
    } catch (error) {
      setIsProcessAllPending(false)
      toast({
        variant: 'destructive',
        title: 'Process All failed',
        description: error?.message || 'Unable to queue pipeline automation.',
      })
    }
  }

  // Handle filter conflicts - ensure hideExpired and showOnlyExpired are mutually exclusive.
  // First resolve the case where the incoming object itself has both flags enabled
  // (precedence: hideExpired wins), then resolve transitions against prior state.
  const handleFiltersChange = (newFilters) => {
    const next = { ...newFilters };
    if (next.hideExpired && next.showOnlyExpired) {
      // Both enabled in the same payload — pick a precedence and clear the other.
      next.showOnlyExpired = false;
    } else if (next.hideExpired && filters.showOnlyExpired) {
      next.showOnlyExpired = false;
    } else if (next.showOnlyExpired && filters.hideExpired) {
      next.hideExpired = false;
    }
    setFilters(next);
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
            <div className="min-w-0 flex-1">
              <p className="money text-xs font-bold uppercase tracking-[0.12em] text-current-emerald">Your funding current</p>
              <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-current-ink">Master Grant Pipeline</h1>
              <p className="money mt-2 text-sm text-current-ink/60">
                Track all your grants across every profile • {filteredGrants.length} of {scopedGrants.length} grants
              </p>
              {handoffsNeededCount > 0 && (
                <p
                  className="mt-2 inline-flex items-center gap-2 rounded-full border border-current-amber/40 bg-current-amberSoft px-3 py-1.5 text-sm font-semibold text-[#a76a16]"
                  role="status"
                  aria-live="polite"
                >
                  <UserCheck className="h-4 w-4" />
                  {handoffsNeededCount} grant{handoffsNeededCount === 1 ? "" : "s"} need a person to step in
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 md:justify-end md:shrink-0">
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
                Portal Logins — teaches Hamilton how to sign in to this
                profile's grant/application portals. Sits right next to
                "Process with Hamilton" because that is exactly when the user
                discovers Hamilton needs credentials, and the cards
                (SavedLoginsCard + PortalSessionsCard) otherwise live one
                screen away on the profile's Pipeline tab. Deep-links there.
              */}
              {selectedProfileId && selectedProfileId !== "all" && (
                <Button
                  variant="outline"
                  className="border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                  onClick={() =>
                    navigate(
                      createPageUrl("ProfileDetail", {
                        id: selectedProfileId,
                        tab: "pipeline",
                        focus: "portal-logins",
                      }),
                    )
                  }
                  aria-label="Manage portal logins so Hamilton can sign in"
                >
                  <KeyRound className="w-4 h-4 mr-2" />
                  Portal Logins
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

          {/* "Your funding current" track — live pipeline phases as a current,
              matching design/grantflow-dashboard.html. Shown only when there's
              something flowing, so an empty board stays clean. */}
          {fundingCurrentTotal > 0 && (
            <section className="rounded-2xl border border-current-line bg-current-card p-5">
              <h2 className="money mb-5 text-xs font-bold uppercase tracking-[0.12em] text-current-ink/55">
                Your funding current
              </h2>
              <ol className="relative grid grid-cols-2 gap-y-6 md:grid-cols-4">
                <span
                  aria-hidden="true"
                  className="absolute left-[12%] right-[12%] top-[7px] hidden h-1 rounded bg-gradient-to-r from-current-emerald via-current-sage to-current-amber md:block"
                />
                {FUNDING_CURRENT_PHASES.map((phase) => {
                  const stats = fundingCurrent[phase.key] ?? { count: 0, amount: 0 };
                  return (
                    <li key={phase.key} className="relative flex flex-col items-center text-center">
                      <span
                        aria-hidden="true"
                        className={`relative z-[1] mb-3 h-4 w-4 rounded-full border-4 bg-current-paper ${
                          phase.awarded ? "border-current-amber bg-current-amber" : "border-current-emerald"
                        }`}
                      />
                      <span className="font-display text-[15px] font-bold text-current-ink">{phase.label}</span>
                      <span className="money mt-1 text-xs text-current-ink/55">
                        {stats.count} source{stats.count === 1 ? "" : "s"}
                      </span>
                      <Money
                        className={`mt-1.5 text-sm font-bold ${phase.awarded ? "text-[#a76a16]" : "text-current-ink"}`}
                      >
                        {usdCompact.format(Math.round(stats.amount))}
                      </Money>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

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
                {!processAllJobStatus &&
                  (processAllJobQuery.isError
                    ? "Unable to fetch job status."
                    : "Status: …")}
                {processAllJobStatus &&
                  !["queued", "running", "completed", "failed"].includes(processAllJobStatus) &&
                  `Status: ${processAllJobStatus}`}
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
                  {vnextAppsQuery.isLoading
                    ? "Loading…"
                    : vnextAppsQuery.isError
                      ? "Unable to load applications."
                      : `${vnextApps.length} applications`}
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
                        {Number.isFinite(Number(a.expected_value))
                          ? Number(a.expected_value).toFixed(2)
                          : "—"}
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
                {vnextAppsQuery.isError
                  ? "Could not load vNext applications. Please try again."
                  : "Create a vNext application from Funding Opportunities (when enabled)."}
              </p>
            )}
          </div>
        ) : null}

        <div className="mt-4 flex-1 overflow-x-auto">
          {filteredGrants.length === 0 ? (
            <div className="text-center py-20">
              <h3 className="mb-2 font-display text-xl font-bold text-current-ink">
                {hasActiveFilters ? "No Grants Match Your Filters" : "No Applications Yet"}
              </h3>
              <p className="text-current-ink/60 mb-4">
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
