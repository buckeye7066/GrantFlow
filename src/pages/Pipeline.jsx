import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Filter, Loader2, Trash2 } from "lucide-react";
import KanbanBoard from "@/components/pipeline/KanbanBoard";
import AdvancedFilters from "@/components/pipeline/AdvancedFilters";
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
import { countBy } from "lodash";
import { listProfiles } from "@/api/profiles";

export default function Pipeline() {
  const [selectedProfileId, setSelectedProfileId] = useState("all");
  const [grantToDelete, setGrantToDelete] = useState(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
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

  const profilesQuery = useQuery({
    queryKey: ['profiles', 'pipeline-selector'],
    queryFn: () => listProfiles({ summary: true }),
  })
  const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : []

  const selectedProfile = useMemo(() => {
    if (!selectedProfileId || selectedProfileId === 'all') return null
    return profiles.find((p) => p.id === selectedProfileId) ?? null
  }, [profiles, selectedProfileId])

  const selectedProfileOrgId = selectedProfile?.organization_id ?? null

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
      base44.setActiveProfileId?.(String(selectedProfileId))
    } else {
      base44.setActiveProfileId?.(null)
    }
  }, [selectedProfileId])

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
      base44.entities.Grant.list(
        '-created_date',
        2000,
        selectedProfileId && selectedProfileId !== 'all' ? { profile_id: selectedProfileId } : {},
      ),
    initialData: [],
  });

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    initialData: [],
  });

  const updateGrantMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Grant.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
    },
  });

  const deleteGrantMutation = useMutation({
    mutationFn: (id) => base44.entities.Grant.delete(id),
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
      await Promise.all(grantIds.map(id => base44.entities.Grant.delete(id)));
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

  // Use custom hook for filtering
  const scopedGrants = useMemo(() => {
    if (!selectedProfileId || selectedProfileId === 'all') return grants
    return (Array.isArray(grants) ? grants : []).filter((g) => {
      // Prefer profile_id when present; fall back to org_id for older rows.
      if (g?.profile_id) return String(g.profile_id) === String(selectedProfileId)
      if (selectedProfileOrgId) return String(g?.organization_id || '') === String(selectedProfileOrgId)
      return false
    })
  }, [grants, selectedProfileId, selectedProfileOrgId])

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
    <div className="p-6 md:p-8 space-y-6">
      <div className="max-w-full mx-auto">
        <div className="flex flex-col gap-4 mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900">Master Grant Pipeline</h1>
              <p className="text-slate-600 mt-2">
                Track all your grants across every profile • {filteredGrants.length} of {scopedGrants.length} grants
              </p>
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
            </div>
          </div>

          {/* Advanced Filters */}
          <AdvancedFilters
            filters={filters}
            onFiltersChange={handleFiltersChange}
            allTags={allTags}
          />
        </div>

        <div className="mt-4 flex-1 overflow-x-auto">
          {filteredGrants.length === 0 ? (
            <div className="text-center py-20">
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Grants Match Your Filters
              </h3>
              <p className="text-slate-600 mb-4">
                {hasActiveFilters
                  ? "Try adjusting your search criteria or filters to see more results."
                  : "You don't have any grants yet. Start by discovering opportunities!"}
              </p>
              {hasActiveFilters && (
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
              )}
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
    </div>
  );
}