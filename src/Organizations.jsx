import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";

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

export default function Organizations() {
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [activeView, setActiveView] = useState("list"); // 'list', 'quick', 'comprehensive', 'upload'
  const [editingOrg, setEditingOrg] = useState(null);
  
  const { toast } = useToast();
  const navigate = useNavigate();
  const { createMutation, updateMutation, deleteMutation } = useOrganizationMutations();

  // Fetch organizations
  const { 
    data: organizations = [], 
    isLoading, 
    error 
  } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('name'),
  });

  // Memoized filtered organizations
  const filteredOrgs = useMemo(() => {
    return organizations.filter(org => {
      const matchesSearch = org.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           org.city?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           org.state?.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesType = typeFilter === "all" || org.applicant_type === typeFilter;
      
      return matchesSearch && matchesType;
    });
  }, [organizations, searchTerm, typeFilter]);

  // Event handlers
  const handleQuickAdd = () => {
    setEditingOrg(null);
    setActiveView("quick");
  };

  const handleUploadForm = () => {
    setEditingOrg(null);
    setActiveView("upload");
  };

  const handleNewApplication = () => {
    setEditingOrg(null);
    setActiveView("comprehensive");
  };

  const handleSubmit = async (data) => {
    try {
      if (editingOrg) {
        const updated = await updateMutation.mutateAsync({ id: editingOrg.id, data });
        return updated;
      } else {
        const newOrg = await createMutation.mutateAsync(data);
        return newOrg;
      }
    } catch (error) {
      showErrorToast(
        toast,
        editingOrg ? "Update Failed" : "Creation Failed",
        error.message || "An error occurred while saving the profile."
      );
      throw error;
    }
  };

  const handleEdit = (org) => {
    setEditingOrg(org);
    setActiveView("quick");
  };

  const handleDelete = (org) => {
    if (window.confirm(
      `Are you sure you want to delete "${org.name}"? This will permanently delete the profile and ALL related data including grants, documents, invoices, and time logs. This action cannot be undone.`
    )) {
      deleteMutation.mutate(org.id);
    }
  };

  const handleCancel = () => {
    setActiveView("list");
    setEditingOrg(null);
  };

  const handleUploadSuccess = async (organization) => {
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
    
    setActiveView("list");
    setEditingOrg(null);
    
    showSuccessToast(
      toast,
      "✅ Opening Profile",
      "Everything is verified. Opening profile now..."
    );
    
    setTimeout(() => {
      navigate(createPageUrl("OrganizationProfile", { id: organization.id }));
    }, 500);
  };

  const handleInvoice = (org) => {
    navigate(createPageUrl("CreateInvoice", { organization_id: org.id }));
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
              isSubmitting={createMutation.isPending || updateMutation.isPending}
            />
          </div>
        );

      case "comprehensive":
        return (
          <div className="p-6 md:p-8">
            <ComprehensiveApplicationForm
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              isSubmitting={createMutation.isPending}
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
                    Manage organizations, students, and individuals seeking funding
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

  return renderContent();
}