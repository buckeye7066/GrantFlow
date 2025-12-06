import React, { useState, useMemo, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

// Components
import OrganizationCard from "@/components/organizations/OrganizationCard";
import OrganizationForm from "@/components/organizations/OrganizationForm";
import OrganizationFilters from "@/components/organizations/OrganizationFilters";
import OrganizationActions from "@/components/organizations/OrganizationActions";
import OrganizationEmptyState from "@/components/organizations/OrganizationEmptyState";
import ComprehensiveApplicationForm from "@/components/organizations/ComprehensiveApplicationForm";
import UploadApplicationForm from "@/components/organizations/UploadApplicationForm";
import { useOrganizationMutations } from "@/components/hooks/useOrganizationMutations";
import { useToast } from "@/components/ui/use-toast";
import { showSuccessToast, showErrorToast } from "@/components/shared/toastHelpers";
import { verifyOrganizationAccess } from "@/components/shared/accessVerification";
import { normalize } from "@/components/shared/stringUtils";
import { RLS_PROPAGATION_DELAY_MS } from "@/components/shared/constants";
import { OWNER_EMAIL } from "@/Layout";

export default function Organizations() {
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [activeView, setActiveView] = useState("list"); // 'list', 'quick', 'comprehensive', 'upload'
  const [editingOrg, setEditingOrg] = useState(null);
  const [orgToDelete, setOrgToDelete] = useState(null);
  
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { createMutation, updateMutation, deleteMutation } = useOrganizationMutations();

  // Combined submitting state
  const isSubmitting = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  // Fetch current user
  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: async () => {
      try {
        return await base44.auth.me();
      } catch (error) {
        console.error('[Organizations] Failed to fetch user:', error);
        return null;
      }
    },
  });

  const isAdmin = user?.role === 'admin';
  const isOwner = user?.email === OWNER_EMAIL;

  // Fetch organizations - admin sees all, others see only their own
  const { 
    data: organizations = [], 
    isLoading, 
    error 
  } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin 
      ? base44.entities.Organization.list('name')
      : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  // Memoized filtered organizations with safe normalization
  const filteredOrgs = useMemo(() => {
    const search = normalize(searchTerm);

    return organizations.filter(org => {
      const name = normalize(org.name);
      const city = normalize(org.city);
      const state = normalize(org.state);

      const matchesSearch =
        search === "" ||
        name.includes(search) ||
        city.includes(search) ||
        state.includes(search);

      const type = normalize(org.applicant_type);
      const matchesType =
        typeFilter === "all" || type === normalize(typeFilter);

      return matchesSearch && matchesType;
    });
  }, [organizations, searchTerm, typeFilter]);

  // Event handlers with useCallback
  const handleQuickAdd = useCallback(() => {
    setEditingOrg(null);
    setActiveView("quick");
  }, []);

  const handleUploadForm = useCallback(() => {
    setEditingOrg(null);
    setActiveView("upload");
  }, []);

  const handleNewApplication = useCallback(() => {
    setEditingOrg(null);
    setActiveView("comprehensive");
  }, []);

  // Listen for switch-to-upload event from ComprehensiveApplicationForm
  React.useEffect(() => {
    const handleSwitchToUpload = () => {
      setActiveView("upload");
    };
    window.addEventListener('switch-to-upload', handleSwitchToUpload);
    return () => window.removeEventListener('switch-to-upload', handleSwitchToUpload);
  }, []);

  const handleCancel = useCallback(() => {
    setActiveView("list");
    setEditingOrg(null);
  }, []);

  const handleUploadSuccess = useCallback(async (organization) => {
    console.log('[Organizations] Upload success, received organization:', organization);
    
    if (!organization || !organization.id) {
      console.error('[Organizations] No organization ID returned from upload');
      showErrorToast(
        toast,
        "Error",
        "Profile was created but couldn't navigate to it. Please refresh the page and look for it in the list."
      );
      setActiveView("list");
      setEditingOrg(null);
      return;
    }
    
    showSuccessToast(
      toast,
      "✅ Profile Created Successfully!",
      `"${organization.name}" is ready. Verifying access...`
    );
    
    // Verify access using utility function
    console.log('[Organizations] Verifying user can access the new profile...');
    const canAccess = await verifyOrganizationAccess(organization.id, 5);
    
    if (!canAccess) {
      console.error('[Organizations] ❌ User cannot access the created profile');
      showErrorToast(
        toast,
        "Access Issue",
        "Profile was created but there's an access issue. Please refresh the page - it should appear in the list."
      );
      setActiveView("list");
      setEditingOrg(null);
      return;
    }
    
    // C2 FIX: Refetch queries and wait before navigating to prevent race condition
    await queryClient.refetchQueries({ queryKey: ['organizations', user?.email, isAdmin] });
    
    // L2 FIX: Using constant for RLS propagation delay
    await new Promise(r => setTimeout(r, RLS_PROPAGATION_DELAY_MS));
    
    setActiveView("list");
    setEditingOrg(null);
    
    showSuccessToast(
      toast,
      "✅ Opening Profile",
      "Everything is verified. Opening profile now..."
    );
    
    console.log('[Organizations] Navigating to profile:', organization.id);
    navigate(createPageUrl("OrganizationProfile") + `?id=${organization.id}`);
  }, [toast, queryClient, navigate, user?.email, isAdmin]);

  const handleSubmit = useCallback(async (data) => {
    try {
      if (editingOrg) {
        const updated = await updateMutation.mutateAsync({ id: editingOrg.id, data });
        handleCancel(); // Go back to list view
        return updated;
      } else {
        const newOrg = await createMutation.mutateAsync(data);
        if (newOrg) {
          await handleUploadSuccess(newOrg);
        }
        return newOrg;
      }
    } catch (error) {
      // Always show error toast for unhandled errors
      showErrorToast(
        toast,
        editingOrg ? "Update Failed" : "Creation Failed",
        error?.message || "An error occurred while saving the profile."
      );
      throw error; // Let the form know an error occurred
    }
  }, [editingOrg, updateMutation, createMutation, handleCancel, handleUploadSuccess, toast]);

  const handleEdit = useCallback((org) => {
    setEditingOrg(org);
    setActiveView("quick");
  }, []);

  const handleDelete = useCallback((org) => {
    // Only owner can delete
    if (!isOwner) {
      showErrorToast(toast, "Permission Denied", "Only the system owner can delete profiles.");
      return;
    }
    setOrgToDelete(org);
  }, [isOwner, toast]);

  const confirmDelete = useCallback(async () => {
    if (!orgToDelete) return;
    
    try {
      await deleteMutation.mutateAsync(orgToDelete.id);
      // M11 FIX: Include user context in invalidation key
      await queryClient.invalidateQueries({ queryKey: ['organizations', user?.email, isAdmin] });
      setOrgToDelete(null);
    } catch (error) {
      showErrorToast(
        toast,
        "Delete Failed",
        error?.message || "Failed to delete the profile."
      );
      setOrgToDelete(null);
    }
  }, [orgToDelete, deleteMutation, queryClient, toast, user?.email, isAdmin]);

  const handleInvoice = useCallback((org) => {
    navigate(createPageUrl("CreateInvoice") + `?organization_id=${org.id}`);
  }, [navigate]);

  const handleCardClick = useCallback((org) => {
    navigate(createPageUrl("OrganizationProfile") + `?id=${org.id}`);
  }, [navigate]);

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
            Failed to load organizations. Please try refreshing the page.
            {errorMessage && <span className="block mt-2 text-sm">{errorMessage}</span>}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Render based on active view
  const renderContent = () => {
    switch (activeView) {
      case "quick":
        return (
          <div className="p-6 md:p-8">
            <OrganizationForm
              organization={editingOrg}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              isSubmitting={isSubmitting}
            />
          </div>
        );

      case "comprehensive":
        return (
          <div className="p-6 md:p-8">
            <ComprehensiveApplicationForm
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              isSubmitting={isSubmitting}
            />
          </div>
        );

      case "upload":
        return (
          <div className="p-6 md:p-8">
            <UploadApplicationForm
              onSuccess={handleUploadSuccess}
              onCancel={handleCancel}
              existingOrganizationId={editingOrg?.id}
            />
          </div>
        );

      case "list":
      default:
        const hasFilters = searchTerm !== "" || typeFilter !== "all";
        
        return (
          <section className="p-6 md:p-8" aria-label="Organizations management">
            <div className="max-w-7xl mx-auto">
              {/* Header */}
              <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                <div>
                  <h1 className="text-3xl font-bold text-slate-900">Profiles</h1>
                  <p className="text-slate-600 mt-2">
                    Manage all profiles seeking funding
                  </p>
                </div>
                <OrganizationActions
                  onQuickAdd={handleQuickAdd}
                  onUpload={handleUploadForm}
                  onNewApplication={handleNewApplication}
                />
              </header>

              {/* Filters */}
              <OrganizationFilters
                searchTerm={searchTerm}
                onSearchChange={setSearchTerm}
                typeFilter={typeFilter}
                onTypeChange={setTypeFilter}
              />

              {/* Results */}
              {filteredOrgs.length === 0 ? (
                <OrganizationEmptyState
                  hasFilters={hasFilters}
                  onCreateFirst={handleNewApplication}
                />
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filteredOrgs.map((org) => (
                      <OrganizationCard
                        key={org.id}
                        organization={org}
                        onClick={() => handleCardClick(org)}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onInvoice={handleInvoice}
                      />
                    ))}
                  </div>

                  <footer className="mt-6 text-center text-sm text-slate-500">
                    Showing {filteredOrgs.length} of {organizations.length} profiles
                  </footer>
                </>
              )}
            </div>
          </section>
        );
    }
  };

  return (
    <>
      {renderContent()}
      
      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!orgToDelete} onOpenChange={(open) => !open && setOrgToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Profile</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{orgToDelete?.name}"? This will permanently delete the profile and ALL related data including grants, documents, invoices, and time logs. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting...</>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}