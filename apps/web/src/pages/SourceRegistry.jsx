import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Plus, Wand2, Sparkles, Activity } from 'lucide-react';

// Custom hook
import { usePartnerSources } from '@/components/hooks/usePartnerSources';

// UI Components
import PartnerTable from '@/components/partner-sources/PartnerTable';
import CrawlLogTable from '@/components/partner-sources/CrawlLogTable';
import AISuggestionsDialog from '@/components/partner-sources/AISuggestionsDialog';
import AIAddPartnerDialog from '@/components/partner-sources/AIAddPartnerDialog';
import PartnerForm from '@/components/partner-sources/PartnerForm';

export default function SourceRegistry() {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isAIAddOpen, setIsAIAddOpen] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  // Fetch current user first
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // Use partner sources hook with user context
  const {
    partners,
    crawlLogs,
    selectedPartner,
    setSelectedPartner,
    isLoading: isHookLoading,
    createOrUpdatePartner,
    deletePartner,
    runFeed,
    getSuggestions,
    addSuggestions,
    isRunningFeed,
    runFeedVariables,
    isGettingSuggestions,
    getSuggestionsError,
    isAddingSuggestions,
  } = usePartnerSources({
    user,
    isAdmin,
  });

  // Validate selectedPartner access - reset if unauthorized
  useEffect(() => {
    if (selectedPartner && !isAdmin && selectedPartner.created_by !== user?.email) {
      setSelectedPartner(null);
    }
  }, [selectedPartner, isAdmin, user?.email, setSelectedPartner]);

  const handleSave = (partnerData) => {
    createOrUpdatePartner(partnerData);
    setIsFormOpen(false);
    setSelectedPartner(null);
  };

  const handleEdit = (partner) => {
    // Validate edit permission
    if (!isAdmin && partner.created_by !== user?.email) {
      return;
    }
    setSelectedPartner(partner);
    setIsFormOpen(true);
  };

  const handleAIAddFound = (newPartnerData) => {
    setSelectedPartner(newPartnerData);
    setIsAIAddOpen(false);
    setIsFormOpen(true);
  };

  const handleGetSuggestions = async () => {
    try {
      const result = await getSuggestions();
      setSuggestions(result.suggestions || []);
    } catch (error) {
      setSuggestions([]);
    }
  };

  const handleAddSuggestions = (selectedSuggestions) => {
    addSuggestions(selectedSuggestions);
    setIsSuggestionsOpen(false);
    setSuggestions([]);
  };

  // Combined loading state - wait for user first
  const isLoading = isLoadingUser || isHookLoading;

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Data Source Registry</h1>
            <p className="text-slate-600 mt-1">Manage partner feeds and monitor crawler health.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setIsSuggestionsOpen(true)}>
              <Wand2 className="w-4 h-4 mr-2" />
              Get Suggestions
            </Button>
            <Button variant="outline" onClick={() => setIsAIAddOpen(true)}>
              <Sparkles className="w-4 h-4 mr-2" />
              Add with AI
            </Button>
            <Button onClick={() => { setSelectedPartner(null); setIsFormOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" />
              Add Manually
            </Button>
          </div>
        </div>

        {/* Partner Feeds Table */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Partner Feeds</CardTitle>
          </CardHeader>
          <CardContent>
            <PartnerTable
              partners={partners}
              onEdit={handleEdit}
              onDelete={deletePartner}
              onRunFeed={runFeed}
              isRunningFeed={isRunningFeed}
              runFeedPartnerId={runFeedVariables}
            />
          </CardContent>
        </Card>

        {/* Crawl Logs Table */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity />
              System Activity Log
            </CardTitle>
            <CardDescription>
              Recent activity from background jobs and data crawlers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CrawlLogTable crawlLogs={crawlLogs} />
          </CardContent>
        </Card>

        {/* Partner Form Dialog */}
        {isFormOpen && (
          <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {selectedPartner?.id ? 'Edit' : 'Add'} Partner Source
                </DialogTitle>
              </DialogHeader>
              <PartnerForm
                partner={selectedPartner}
                onSave={handleSave}
                onCancel={() => {
                  setIsFormOpen(false);
                  setSelectedPartner(null);
                }}
              />
            </DialogContent>
          </Dialog>
        )}

        {/* AI Add Partner Dialog */}
        <AIAddPartnerDialog
          open={isAIAddOpen}
          onOpenChange={setIsAIAddOpen}
          onFound={handleAIAddFound}
        />

        {/* AI Suggestions Dialog */}
        <AISuggestionsDialog
          open={isSuggestionsOpen}
          onOpenChange={setIsSuggestionsOpen}
          onGetSuggestions={handleGetSuggestions}
          onAddSuggestions={handleAddSuggestions}
          isLoading={isGettingSuggestions}
          isAdding={isAddingSuggestions}
          suggestions={suggestions}
          error={getSuggestionsError}
        />
      </div>
    </div>
  );
}