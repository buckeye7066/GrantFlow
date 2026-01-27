import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listProfiles, deleteProfile } from "@/api/profiles";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  Loader2, 
  AlertCircle, 
  Search,
  Plus,
  Building2
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/use-toast";
import ProfileCard from "@/components/profiles/ProfileCard";
import { createPageUrl } from "@/utils";

// Deletion confirmation message
const DELETE_CONFIRMATION_MESSAGE = 
  "Are you sure you want to delete this profile? This action cannot be undone and will remove all associated data including sections, documents, and billing information.";

export default function MyProfiles() {
  const [searchTerm, setSearchTerm] = useState("");
  const [profileToDelete, setProfileToDelete] = useState(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  // Fetch profiles with summary data
  const { 
    data: profiles = [], 
    isLoading, 
    error 
  } = useQuery({
    queryKey: ['profiles', 'summary'],
    queryFn: () => listProfiles({ summary: true, scope: 'mine' }),
  });
  
  // Filter profiles
  const filteredProfiles = useMemo(() => {
    if (!searchTerm) return profiles;
    
    const search = searchTerm.toLowerCase();
    return profiles.filter(profile => 
      profile.display_name?.toLowerCase().includes(search) ||
      profile.primary_type?.toLowerCase().includes(search) ||
      profile.organization_name?.toLowerCase().includes(search)
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
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
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
  
  const handleViewInvoices = (profile) => {
    navigate(createPageUrl("CreateInvoice", { organization_id: profile.organization_id, profile_id: profile.id }));
  };
  
  const handleDeleteProfile = (profile) => {
    setProfileToDelete(profile);
  };
  
  const confirmDelete = () => {
    if (profileToDelete) {
      deleteMutation.mutate(profileToDelete.id);
    }
  };
  
  const handleCreateProfile = () => {
    navigate(createPageUrl("Organizations"));
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
    <section className="p-6 md:p-8" aria-label="My Profiles">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">My Profiles</h1>
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
                  onViewInvoices={handleViewInvoices}
                  onDelete={handleDeleteProfile}
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
      </div>
    </section>
  );
}
