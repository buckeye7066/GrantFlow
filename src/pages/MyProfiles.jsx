import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listProfiles, deleteProfile, hardDeleteProfileAdmin, restoreProfileAccessAdmin } from "@/api/profiles";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  Loader2, 
  AlertCircle, 
  Search,
  Plus,
  Building2,
  Users,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/use-toast";
import ProfileCard from "@/components/profiles/ProfileCard";
import { createPageUrl } from "@/utils";
import { useAuthStore, normalizeUserAdmin } from "@/stores/authStore";
import { Checkbox } from "@/components/ui/checkbox";

// Deletion confirmation message
const DELETE_CONFIRMATION_MESSAGE = 
  "Are you sure you want to delete this profile? This action cannot be undone and will remove all associated data including sections, documents, and billing information.";

export default function MyProfiles() {
  const [searchTerm, setSearchTerm] = useState("");
  const [profileToDelete, setProfileToDelete] = useState(null);
  const [profileToHardDelete, setProfileToHardDelete] = useState(null);
  const [hardDeleteConfirmText, setHardDeleteConfirmText] = useState("");
  const [hardDeleteReason, setHardDeleteReason] = useState("orphan_cleanup");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const user = useAuthStore((state) => state.user);
  const isAdmin = normalizeUserAdmin(user);

  const [viewMode, setViewMode] = useState(() => (isAdmin ? "all" : "mine"));
  const [includeDeleted, setIncludeDeleted] = useState(false);
  
  // Fetch profiles with summary data
  const { 
    data: profiles = [], 
    isLoading, 
    error 
  } = useQuery({
    queryKey: ['profiles', 'summary', viewMode, includeDeleted],
    queryFn: () => {
      const mode = isAdmin ? viewMode : "mine";
      return listProfiles({
        summary: true,
        ...(mode === "mine" ? { scope: "mine" } : {}),
        ...(includeDeleted ? { includeDeleted: true } : {}),
      });
    },
  });
  
  // Filter + sort profiles alphabetically by person/organization name.
  // The API already returns A→Z, but we sort defensively so the list stays
  // alphabetical regardless of fetch/merge order.
  const filteredProfiles = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    const matched = !search
      ? profiles
      : profiles.filter(profile =>
          profile.display_name?.toLowerCase().includes(search) ||
          profile.primary_type?.toLowerCase().includes(search) ||
          profile.organization_name?.toLowerCase().includes(search)
        );
    const nameOf = (p) => (p.display_name || p.organization_name || '').trim();
    return [...matched].sort((a, b) =>
      nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' })
    );
  }, [profiles, searchTerm]);
  
  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deleteProfile,
    onSuccess: () => {
      toast({
        title: "Profile deleted",
        description: "The profile has been successfully removed.",
      });
      // Invalidate the WHOLE 'profiles' family by PREFIX. React Query v5 matches
      // query keys by prefix, so ['profiles'] covers this page's key AND the
      // other pages' ('profiles', isAdmin / 'profiles','summary',...). Narrowing
      // this to one exact key leaves the other views stale after a mutation, and
      // dropping refetchType:'all' stops inactive queries from refetching.
      queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' });
      useAuthStore.getState().refreshProfiles({ reason: 'profile-deleted', force: true });
      setProfileToDelete(null);
    },
    onError: (error) => {
      toast({
        title: "Error deleting profile",
        description: error.message || "Failed to delete the profile. Please try again.",
        variant: "destructive",
      });
    },
  });

  const hardDeleteMutation = useMutation({
    mutationFn: async ({ id, payload }) => hardDeleteProfileAdmin(id, payload),
    onSuccess: (_res, vars) => {
      toast({
        title: "Profile hard-deleted",
        description: "The profile was permanently removed and tombstoned so it cannot return.",
      });
      queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' });
      if (vars?.id) queryClient.invalidateQueries({ queryKey: ['profile', vars.id] });
      useAuthStore.getState().refreshProfiles({ reason: 'profile-hard-deleted', force: true });
      setProfileToHardDelete(null);
      setHardDeleteConfirmText("");
      setHardDeleteReason("orphan_cleanup");
    },
    onError: (error) => {
      toast({
        title: "Error hard-deleting profile",
        description: error.message || "Failed to hard delete the profile. Please try again.",
        variant: "destructive",
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async ({ id }) => {
      return restoreProfileAccessAdmin(id, { restore_deleted: true })
    },
    onSuccess: () => {
      toast({
        title: "Profile restored",
        description: "The profile was restored and should now appear in the main list.",
      })
      queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' });
      useAuthStore.getState().refreshProfiles({ reason: 'profile-restored', force: true });
    },
    onError: (error) => {
      toast({
        title: "Error restoring profile",
        description: error.message || "Failed to restore the profile. Please try again.",
        variant: "destructive",
      })
    },
  })
  
  const handleViewInvoices = (profile) => {
    navigate(createPageUrl("CreateInvoice", { organization_id: profile.organization_id, profile_id: profile.id }));
  };
  
  const handleDeleteProfile = (profile) => {
    setProfileToDelete(profile);
  };

  const handleHardDeleteProfile = (profile) => {
    setProfileToHardDelete(profile);
    setHardDeleteConfirmText("");
    setHardDeleteReason("orphan_cleanup");
  };

  const handleRestoreProfile = (profile) => {
    if (!profile?.id) return
    const ok = window.confirm(`Restore "${profile.display_name || profile.name || profile.id}"?\n\nThis will clear the deleted status so it appears again.`)
    if (!ok) return
    restoreMutation.mutate({ id: profile.id })
  }
  
  const confirmDelete = () => {
    if (profileToDelete) {
      deleteMutation.mutate(profileToDelete.id);
    }
  };
  
  const handleCreateProfile = () => {
    // Land directly in the Quick Add create flow on Organizations rather than
    // just dropping the user on the list (Organizations reads ?quickAdd=1).
    navigate(createPageUrl("Organizations", { quickAdd: 1 }));
  };
  
  // Loading state
  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }
  
  // Error state
  if (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    return (
      <div className="p-6 md:p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load profiles. Please try refreshing the page.
            {errorMessage && <span className="block mt-2 text-sm">{errorMessage}</span>}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  
  return (
    <section className="p-6 md:p-8" aria-label="Profiles">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Profiles</h1>
            <p className="text-slate-600 mt-2">
              View and manage your profiles with billing and funding information
            </p>
          </div>
          <Button 
            onClick={handleCreateProfile}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Profile
          </Button>
        </header>

        {/* Admin controls */}
        {isAdmin ? (
          <div className="mb-6 flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={viewMode === "mine" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("mine")}
              >
                My Profiles
              </Button>
              <Button
                type="button"
                variant={viewMode === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("all")}
              >
                All Profiles
              </Button>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <Checkbox checked={includeDeleted} onCheckedChange={(v) => setIncludeDeleted(Boolean(v))} />
                Include deleted
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate(createPageUrl("Admin"))}
              >
                <Users className="w-4 h-4 mr-2" />
                Merge similar profiles
              </Button>
            </div>
          </div>
        ) : null}
        
        {/* Search */}
        <div className="mb-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5" />
            <Input
              type="text"
              placeholder="Search profiles..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        
        {/* Results */}
        {filteredProfiles.length === 0 ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                {profiles.length === 0 ? "No Profiles Yet" : "No Matching Profiles"}
              </h3>
              <p className="text-slate-600 mb-6">
                {profiles.length === 0 
                  ? "Get started by creating your first profile to track grants and billing."
                  : "Try adjusting your search to find what you're looking for."}
              </p>
              {profiles.length === 0 && (
                <Button onClick={handleCreateProfile}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Your First Profile
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredProfiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  isAdmin={isAdmin}
                  onViewInvoices={handleViewInvoices}
                  onDelete={handleDeleteProfile}
                  onHardDelete={handleHardDeleteProfile}
                  onRestore={handleRestoreProfile}
                />
              ))}
            </div>
            
            <footer className="mt-6 text-center text-sm text-slate-500">
              Showing {filteredProfiles.length} of {profiles.length} profiles
            </footer>
          </>
        )}
        
        {/* Delete Confirmation Dialog */}
        <AlertDialog open={!!profileToDelete} onOpenChange={(open) => !open && setProfileToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Profile</AlertDialogTitle>
              <AlertDialogDescription>
                {DELETE_CONFIRMATION_MESSAGE.replace(
                  'this profile',
                  `the profile "${profileToDelete?.display_name || profileToDelete?.organization_name || profileToDelete?.name || 'Unnamed profile'}"`,
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                disabled={deleteMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  'Delete'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Hard Delete Confirmation Dialog (admin-only) */}
        <AlertDialog open={!!profileToHardDelete} onOpenChange={(open) => !open && setProfileToHardDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Hard delete profile (permanent)</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes the profile and creates a tombstone so it cannot be recreated by startup seeding.
                To confirm, type <strong>DELETE</strong> below.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-3">
              <div className="text-sm text-slate-700">
                Target:{" "}
                <strong>{profileToHardDelete?.display_name || profileToHardDelete?.organization_name || profileToHardDelete?.id}</strong>
              </div>
              <div className="grid grid-cols-1 gap-2">
                <Input
                  placeholder="Reason (optional)"
                  value={hardDeleteReason}
                  onChange={(e) => setHardDeleteReason(e.target.value)}
                />
                <Input
                  placeholder='Type "DELETE" to confirm'
                  value={hardDeleteConfirmText}
                  onChange={(e) => setHardDeleteConfirmText(e.target.value)}
                />
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={hardDeleteMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (!profileToHardDelete?.id) return;
                  hardDeleteMutation.mutate({
                    id: profileToHardDelete.id,
                    payload: {
                      reason: hardDeleteReason || undefined,
                      tombstone: true,
                      force: false,
                    },
                  });
                }}
                disabled={
                  !isAdmin ||
                  hardDeleteMutation.isPending ||
                  String(hardDeleteConfirmText || "").trim().toUpperCase() !== "DELETE"
                }
                className="bg-red-700 hover:bg-red-800"
              >
                {hardDeleteMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  "Hard Delete"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
