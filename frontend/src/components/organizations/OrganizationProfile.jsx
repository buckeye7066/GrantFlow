import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { useQueryClient } from '@tanstack/react-query';

// Custom hooks
import { useOrganizationData } from '@/components/hooks/useOrganizationData';
import { useProfileModals } from '@/components/hooks/useProfileModals';
import { useProfileMutations } from '@/components/hooks/useProfileMutations';
import { useSafePrint } from '@/components/hooks/useSafePrint';

// Tab components
import ProfileHeader from './ProfileHeader';
import ProfileLoadingError from './ProfileLoadingError';
import ProfileDetailsTab from './tabs/ProfileDetailsTab';
import FundingSourcesTab from './tabs/FundingSourcesTab';
import OpportunitiesTab from './tabs/OpportunitiesTab';
import PipelineTab from './tabs/PipelineTab';
import DocumentsTab from './tabs/DocumentsTab';
import ProfileDeleteDialog from './ProfileDeleteDialog';
import SuggestedEnhancementsCard from './SuggestedEnhancementsCard';

// Modals
import OrganizationEmailComposer from './OrganizationEmailComposer';
import DocumentHarvester from '../documents/DocumentHarvester';
import AutoTimeTracker from '../billing/AutoTimeTracker';

/**
 * OrganizationProfile - Main profile view component
 * 
 * Refactored for:
 * - Clear separation of concerns
 * - Reusable hooks for data/mutations/modals
 * - Extracted tab components
 * - Better performance and maintainability
 */
export default function OrganizationProfile({
  organizationId,
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  
  const [activeTab, setActiveTab] = useState('details');
  const [manualRetryCount, setManualRetryCount] = useState(0);
  const [scrollToSection, setScrollToSection] = useState(null);
  
  // Handle scroll to section from enhancement cards
  const handleScrollToSection = (section) => {
    console.log('[OrganizationProfile] handleScrollToSection called with:', section);
    setActiveTab('details'); // Switch to details tab first
    // Use a unique key each time to force re-render
    const sectionWithTimestamp = `${section}_${Date.now()}`;
    setTimeout(() => {
      setScrollToSection(sectionWithTimestamp);
    }, 200);
  };

  // Data fetching
  const {
    organization,
    contactMethods,
    emails,
    phones,
    grants,
    fundingSources,
    documents,
    taxonomyItems,
    isLoading,
    isLoadingOrg,
    isLoadingContacts,
    isLoadingGrants,
    isLoadingSources,
    isLoadingDocuments,
    orgError,
    refetchOrg,
    refetchDocuments,
    refetchFundingSources,
  } = useOrganizationData(organizationId, manualRetryCount);

  // Modal management
  const {
    isEmailComposerOpen,
    openEmailComposer,
    closeEmailComposer,
    isHarvesterOpen,
    openHarvester,
    closeHarvester,
    showDeleteConfirm,
    openDeleteConfirm,
    closeDeleteConfirm,
  } = useProfileModals();

  // Mutations
  const {
    updateOrganization,
    deleteOrganization,
    findPicture,
    updateGrant,
    deleteGrant,
    isUpdatingOrg,
    isDeletingOrg,
    isFindingPicture,
  } = useProfileMutations(organizationId);

  // Safe print
  const triggerPrint = useSafePrint({
    isLoadingOrg,
    isLoadingContacts,
    isLoadingGrants,
  });

  // Memoized subtitle
  const subtitle = useMemo(() => {
    if (!organization) return '';
    
    if (organization.applicant_type === 'organization') {
      const orgType = taxonomyItems.find(t => 
        t.group === 'organization_type' && t.slug === organization.nonprofit_type
      );
      return orgType ? orgType.label : 'Organization';
    }
    
    return (organization.applicant_type || '')
      .replace(/_/g, ' ')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }, [organization, taxonomyItems]);

  // FIX: Safer numeric coercion to avoid string concatenation
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Calculate total grant funding for header display
  const totalGrantFunding = useMemo(() => {
    const awardedGrants = (grants || []).filter(g => g.status === 'awarded');
    return awardedGrants.reduce((sum, g) => sum + (toNum(g.award_ceiling) || toNum(g.award_floor)), 0);
  }, [grants]);

  // Handlers
  const handleBack = () => navigate(createPageUrl('Organizations'));

  const handleUpdate = ({ id, data }) => {
    console.log('[OrganizationProfile] 📝 handleUpdate called');
    console.log('[OrganizationProfile] ID:', id);
    console.log('[OrganizationProfile] Data:', JSON.stringify(data));
    console.log('[OrganizationProfile] Data keys:', Object.keys(data || {}));
    console.log('[OrganizationProfile] updateOrganization function exists:', !!updateOrganization);
    
    if (!id || !data) {
      console.error('[OrganizationProfile] ❌ Missing id or data');
      toast({
        variant: 'destructive',
        title: 'Update Error',
        description: 'Missing required data for update',
      });
      return;
    }
    
    // Check if data has any actual values - INCLUDING empty strings (user may clear a field)
    const hasValues = Object.values(data).some(v => v !== undefined && v !== null);
    if (!hasValues) {
      console.log('[OrganizationProfile] No changes detected, skipping update');
      return;
    }
    
    // IMPORTANT: Don't skip empty strings - user may want to clear a field
    // Also accept string fields even when they contain content
    console.log('[OrganizationProfile] ✅ Calling updateOrganization...');
    console.log('[OrganizationProfile] Values being saved:', Object.entries(data).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.substring(0, 30) + '...' : v}`));
    updateOrganization(id, data);
  };

  const handleConfirmDelete = () => {
    if (organization?.id) {
      deleteOrganization(organization.id);
    }
  };

  const handleHarvestComplete = () => {
    closeHarvester();
    queryClient.invalidateQueries({ queryKey: ['documents', organizationId] });
    queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
  };

  const handleFindPicture = () => {
    if (!organization?.website) {
      toast({
        title: "Website Missing",
        description: "Please add a website to the profile before searching for a picture.",
        variant: "destructive",
      });
      return;
    }
    
    findPicture(organization.id, organization.name, organization.website);
  };

  const handleRetry = () => {
    setManualRetryCount(prev => prev + 1);
    refetchOrg();
  };

  const handleWaitAndRetry = () => {
    toast({
      title: "Waiting for sync...",
      description: "Waiting 3 seconds for the database to sync, then retrying...",
    });
    
    setTimeout(() => {
      setManualRetryCount(prev => prev + 1);
      refetchOrg();
    }, 3000);
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col justify-center items-center h-full min-h-[400px] gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        <p className="text-slate-500">Loading organization details...</p>
        <p className="text-xs text-slate-400">
          This may take a moment for newly created profiles
        </p>
      </div>
    );
  }

  // Error state
  if (orgError) {
    return (
      <ProfileLoadingError
        onRetry={handleRetry}
        onWaitAndRetry={handleWaitAndRetry}
        onBack={handleBack}
      />
    );
  }

  // Not found state
  if (!organization) {
    return (
      <div className="flex flex-col justify-center items-center h-full min-h-[400px] gap-4">
        <p className="text-slate-500">Organization not found.</p>
        <Button onClick={handleBack}>← Back to Organizations</Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <ProfileHeader
        organization={organization}
        subtitle={subtitle}
        totalGrantFunding={totalGrantFunding}
        onBack={handleBack}
        onDelete={openDeleteConfirm}
        onEmailComposer={openEmailComposer}
        onFindPicture={handleFindPicture}
        onPrint={triggerPrint}
        onUpdate={handleUpdate}
        hasEmails={Array.isArray(emails) && emails.length > 0}
        isLoadingContacts={isLoadingContacts}
        isFindingPicture={isFindingPicture}
        isUpdating={isUpdatingOrg}
      />

      <main className="flex-1 overflow-y-auto bg-slate-50 printable-profile-container">
        <Tabs 
          value={activeTab} 
          onValueChange={setActiveTab} 
          className="p-4 printable-section"
        >
          <TabsList className="printable-hidden">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="sources">
              Funding Sources {Array.isArray(fundingSources) && fundingSources.length > 0 && `(${fundingSources.length})`}
            </TabsTrigger>
            <TabsTrigger value="matches">
              Opportunities {Array.isArray(grants) && grants.length > 0 && `(${grants.length})`}
            </TabsTrigger>
            <TabsTrigger value="pipeline">Pipeline View</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          <TabsContent value="details">
            {/* Suggested Enhancements - Fetches fresh from API for THIS profile */}
            <div className="mb-4">
              <SuggestedEnhancementsCard 
                organizationId={organizationId}
                organizationName={organization?.name}
                onScrollToSection={handleScrollToSection}
              />
            </div>
            
            <ProfileDetailsTab
              organization={organization}
              contactMethods={contactMethods}
              taxonomyItems={taxonomyItems}
              onUpdate={handleUpdate}
              isUpdating={isUpdatingOrg}
              scrollToSection={scrollToSection}
            />
          </TabsContent>

          <TabsContent value="sources">
            <FundingSourcesTab
              fundingSources={fundingSources}
              isLoading={isLoadingSources}
              organization={organization}
              onRefresh={refetchFundingSources}
            />
          </TabsContent>

          <TabsContent value="matches">
            <OpportunitiesTab
              grants={grants}
              isLoading={isLoadingGrants}
            />
          </TabsContent>

          <TabsContent value="pipeline">
            <PipelineTab
              grants={grants}
              organization={organization}
              isLoading={isLoadingGrants}
              onGrantUpdate={updateGrant}
              onGrantDelete={deleteGrant}
              organizationId={organizationId}
            />
          </TabsContent>

          <TabsContent value="documents">
            <DocumentsTab
              documents={documents}
              isLoading={isLoadingDocuments}
              onOpenHarvester={openHarvester}
            />
          </TabsContent>
        </Tabs>
      </main>

      {/* Auto Time Tracker */}
      {organization && (
        <AutoTimeTracker
          organizationId={organization.id}
          organizationName={organization.name}
        />
      )}

      {/* Modals */}
      {isEmailComposerOpen && Array.isArray(emails) && emails.length > 0 && (
        <OrganizationEmailComposer
          open={isEmailComposerOpen}
          onClose={closeEmailComposer}
          organization={organization}
          emails={emails}
        />
      )}

      {isHarvesterOpen && (
        <DocumentHarvester
          organizationId={organizationId}
          organizationName={organization?.name}
          open={isHarvesterOpen}
          onClose={closeHarvester}
          onComplete={handleHarvestComplete}
        />
      )}

      <ProfileDeleteDialog
        open={showDeleteConfirm}
        onOpenChange={closeDeleteConfirm}
        organizationName={organization?.name}
        onConfirm={handleConfirmDelete}
        isDeleting={isDeletingOrg}
      />
    </div>
  );
}