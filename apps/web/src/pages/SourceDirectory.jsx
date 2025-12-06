import React, { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Building2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Custom hook
import { useSourceDirectory } from '@/components/hooks/useSourceDirectory';

// Components
import SourceHeader from '@/components/source-directory/SourceHeader';
import SourceStats from '@/components/source-directory/SourceStats';
import SourceToolbar from '@/components/source-directory/SourceToolbar';
import SourceCardGrid from '@/components/source-directory/SourceCardGrid';
import SourceTable from '@/components/source-directory/SourceTable';
import AIDiscoverDialog from '@/components/source-directory/AIDiscoverDialog';
import AISearchDialog from '@/components/source-directory/AISearchDialog';
import DeleteConfirmDialog from '@/components/source-directory/DeleteConfirmDialog';
import AddSourceForm from '@/components/sources/AddSourceForm';

export default function SourceDirectory() {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isDiscoverOpen, setIsDiscoverOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [editingSource, setEditingSource] = useState(null);

  // Get profileId from URL params if present
  const urlParams = new URLSearchParams(window.location.search);
  const urlProfileId = urlParams.get('profileId') || urlParams.get('profile_id') || urlParams.get('organizationId') || urlParams.get('id');

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  const {
    // Data
    organizations,
    selectedOrg,
    relevantSources,
    filteredSources,
    sourcesDue,
    sourceTypes,
    sourcesByType,
    sourceOpportunities,
    allGrants,
    
    // State
    selectedOrgId,
    setSelectedOrgId,
    sourceTypeFilter,
    setSourceTypeFilter,
    searchQuery,
    setSearchQuery,
    selectedSources,
    setSelectedSources,
    crawlingInBackground,
    expandedSourceId,
    setExpandedSourceId,
    
    // Mutations
    crawlMutation,
    bulkCrawlMutation,
    deleteMutation,
    discoverMutation,
    searchSourceMutation,
    
    // Loading
    isLoading,
    isLoadingOpportunities,
  } = useSourceDirectory({
    user,
    isAdmin,
    enabled: !!user?.email,
    initialProfileId: urlProfileId, // Pass URL profile ID for auto-selection
  });

  // Validate selectedOrgId against RLS-filtered organizations
  useEffect(() => {
    if (selectedOrgId && organizations.length > 0 && !organizations.some(org => org.id === selectedOrgId)) {
      setSelectedOrgId('');
    }
  }, [selectedOrgId, organizations, setSelectedOrgId]);

  const handleToggleSource = (sourceId) => {
    setSelectedSources((prev) =>
      prev.includes(sourceId)
        ? prev.filter((id) => id !== sourceId)
        : [...prev, sourceId]
    );
  };

  const handleToggleAll = () => {
    if (selectedSources.length === filteredSources.length) {
      setSelectedSources([]);
    } else {
      setSelectedSources(filteredSources.map((s) => s.id));
    }
  };

  const handleViewAndSelectType = (sourceType) => {
    setSourceTypeFilter(sourceType);
    setSearchQuery('');
    setSelectedSources([]);
  };

  const handleSelectAllOfType = (sourceType) => {
    const typeSources = sourcesByType[sourceType] || [];
    const typeSourceIds = typeSources.map(s => s.id);
    setSelectedSources(typeSourceIds);
    setSourceTypeFilter(sourceType);
    setSearchQuery('');
  };

  const handleDeleteClick = (type, data) => {
    setDeleteTarget({ type, ...data });
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = () => {
    deleteMutation.mutate(deleteTarget);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  };

  const handleEdit = (source) => {
    setEditingSource(source);
    setIsAddOpen(true);
  };

  const handleSearch = (data) => {
    searchSourceMutation.mutate({
      ...data,
      organization_id: selectedOrgId
    }).then((result) => {
      if (result?.source) {
        setEditingSource(result.source);
        setIsSearchOpen(false);
        setIsAddOpen(true);
      }
    });
  };

  const handleToggleExpand = (sourceId) => {
    if (expandedSourceId === sourceId) {
      setExpandedSourceId(null);
    } else {
      setExpandedSourceId(sourceId);
    }
  };

  // Combined loading state
  if (isLoadingUser || isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <SourceHeader
          organizations={organizations}
          selectedOrgId={selectedOrgId}
          onSelectOrg={setSelectedOrgId}
          selectedOrg={selectedOrg}
          isLoading={isLoading}
        />

        {crawlingInBackground.length > 0 && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-amber-600" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-900">
                  {crawlingInBackground.length} source{crawlingInBackground.length > 1 ? 's' : ''} crawling in background
                </p>
                <p className="text-xs text-amber-700">
                  Page will auto-refresh every 10 seconds. Continue working!
                </p>
              </div>
            </div>
          </div>
        )}

        {!selectedOrgId ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Profile Selected</h3>
              <p className="text-slate-600">
                Select a profile to view funding sources
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <SourceStats 
              relevantSources={relevantSources} 
              sourcesDue={sourcesDue} 
            />

            <SourceToolbar
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              sourceTypeFilter={sourceTypeFilter}
              onTypeFilterChange={setSourceTypeFilter}
              sourceTypes={sourceTypes}
              selectedSources={selectedSources}
              sourcesDue={sourcesDue}
              onBulkCrawl={() => bulkCrawlMutation.mutate(selectedSources)}
              onBulkDelete={() => handleDeleteClick('bulk', { ids: selectedSources })}
              onCrawlAllDue={() => bulkCrawlMutation.mutate(sourcesDue.map(s => s.id))}
              onOpenDiscover={() => setIsDiscoverOpen(true)}
              onOpenSearch={() => setIsSearchOpen(true)}
              onOpenAdd={() => { setEditingSource(null); setIsAddOpen(true); }}
            />

            <SourceCardGrid
              sourcesByType={sourcesByType}
              onViewAndSelect={handleViewAndSelectType}
              onSelectAll={handleSelectAllOfType}
              onDeleteByType={(type) => handleDeleteClick('by_source_type', { sourceType: type })}
            />

            <SourceTable
              filteredSources={filteredSources}
              selectedSources={selectedSources}
              onToggleSource={handleToggleSource}
              onToggleAll={handleToggleAll}
              onCrawl={(id) => crawlMutation.mutate(id)}
              onEdit={handleEdit}
              onDelete={handleDeleteClick}
              crawlingInBackground={crawlingInBackground}
              sourcesDue={sourcesDue}
              expandedSourceId={expandedSourceId}
              onToggleExpand={handleToggleExpand}
              sourceTypeFilter={sourceTypeFilter}
              onClearFilter={() => setSourceTypeFilter('all')}
              sourceOpportunities={sourceOpportunities}
              isLoadingOpportunities={isLoadingOpportunities}
              allGrants={allGrants}
              selectedOrgId={selectedOrgId}
            />
          </>
        )}

        {/* Dialogs */}
        <AIDiscoverDialog
          open={isDiscoverOpen}
          onOpenChange={setIsDiscoverOpen}
          selectedOrg={selectedOrg}
          onDiscover={() => {
            discoverMutation.mutate(selectedOrgId);
            setIsDiscoverOpen(false);
          }}
        />

        <AISearchDialog
          open={isSearchOpen}
          onOpenChange={setIsSearchOpen}
          selectedOrg={selectedOrg}
          onSearch={handleSearch}
          isSearching={searchSourceMutation.isPending}
        />

        <Dialog
          open={isAddOpen}
          onOpenChange={(open) => {
            setIsAddOpen(open);
            if (!open) setEditingSource(null);
          }}
        >
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingSource ? 'Edit Source' : 'Add New Source'}
              </DialogTitle>
            </DialogHeader>
            <AddSourceForm
              source={editingSource}
              onSuccess={() => {
                setIsAddOpen(false);
                setEditingSource(null);
              }}
              onCancel={() => {
                setIsAddOpen(false);
                setEditingSource(null);
              }}
            />
          </DialogContent>
        </Dialog>

        <DeleteConfirmDialog
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          deleteTarget={deleteTarget}
          sourcesByType={sourcesByType}
          onConfirm={handleDeleteConfirm}
          isDeleting={deleteMutation.isPending}
        />
      </div>
    </div>
  );
}