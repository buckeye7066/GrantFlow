
import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import GrantCard from '../pipeline/GrantCard';
import { Button } from '@/components/ui/button';
import { Loader2, Plus, Check, CheckSquare, Square, Search } from 'lucide-react';
import { useToast } from "@/components/ui/use-toast";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from '@/components/ui/checkbox';

function getOpportunityKey(opp, idx) {
  const raw =
    opp?.id ??
    opp?.source_id ??
    opp?.url ??
    opp?.application_url ??
    opp?.source_url ??
    `${opp?.title || 'untitled'}|${opp?.sponsor || opp?.funder || ''}`;
  // Ensure uniqueness even when upstream data has duplicates/missing ids.
  return `${String(raw)}|${idx}`;
}

const AddToPipelineButton = ({ opportunity, onAddToPipeline, organizationName }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [lastStatus, setLastStatus] = React.useState(null);

  const mutation = useMutation({
    mutationFn: (opp) => onAddToPipeline(opp, { silent: true }),
    onSuccess: (result, opp) => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      const status = result?.status || (result?.already_exists ? 'already' : 'added');
      setLastStatus(status);

      if (status === 'already') {
        toast({
          title: 'Already in pipeline',
          description: `"${opp?.title || opportunity?.title || 'This item'}" is already in your pipeline.`,
          duration: 3500,
        });
        return;
      }

      if (status === 'added') {
        toast({
          title: 'Added to pipeline',
          description: `"${opp?.title || opportunity?.title || 'Opportunity'}" was added for ${organizationName}.`,
          duration: 3500,
        });
        return;
      }
    },
    onError: (error) => {
      setLastStatus('failed');
      toast({
        variant: "destructive",
        title: "Could not add to pipeline",
        description: "Please try again. If this keeps happening, refresh and sign in again.",
        duration: 4500,
      });
    }
  });

  const handleClick = () => mutation.mutate(opportunity);

  if (mutation.isPending) {
    return (
      <Button onClick={handleClick} disabled className="w-full">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Adding…
      </Button>
    );
  }

  if (lastStatus === 'added') {
    return (
      <Button variant="outline" className="w-full bg-emerald-50 text-emerald-700 border-emerald-200" disabled>
        <Check className="w-4 h-4 mr-2" /> Added
      </Button>
    );
  }

  if (lastStatus === 'already') {
    return (
      <Button variant="outline" className="w-full bg-slate-50 text-slate-700 border-slate-200" disabled>
        <Check className="w-4 h-4 mr-2" /> Already in pipeline
      </Button>
    );
  }

  return (
    <Button onClick={handleClick} className="w-full">
      <Plus className="w-4 h-4 mr-2" />
      Add to Pipeline
    </Button>
  );
};

export default function SearchResults({ results = [], profileId, onAddToPipeline, organizationName }) {
  const [selectedOpportunities, setSelectedOpportunities] = React.useState(new Set());
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [processingProgress, setProcessingProgress] = React.useState({ current: 0, total: 0 });
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleToggleSelection = (opportunityKey) => {
    setSelectedOpportunities(prev => {
      const newSet = new Set(Array.from(prev)); // Create proper new Set from array
      if (newSet.has(opportunityKey)) {
        newSet.delete(opportunityKey);
      } else {
        newSet.add(opportunityKey);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedOpportunities.size === results.length && results.length > 0) {
      setSelectedOpportunities(new Set());
    } else {
      const allKeys = results.map((opp, idx) => getOpportunityKey(opp, idx));
      setSelectedOpportunities(new Set(allKeys));
    }
  };

  const handleBulkAdd = async () => {
    const selectedOpps = results.filter((opp, idx) => selectedOpportunities.has(getOpportunityKey(opp, idx)));
    
    if (selectedOpps.length === 0) return;

    // Clear selection immediately
    setSelectedOpportunities(new Set());
    
    // Show a single, updatable toast (no spam)
    toast({
      id: 'bulk-add-pipeline',
      title: "Updating pipeline",
      description: `Processing ${selectedOpps.length} opportunities in the background…`,
      duration: 3500,
    });

    // Start processing in background
    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: selectedOpps.length });

    // Process all opportunities in background
    let successCount = 0;
    let failCount = 0;
    let duplicateCount = 0;

    for (let i = 0; i < selectedOpps.length; i++) {
      const opp = selectedOpps[i];
      try {
        const result = await onAddToPipeline(opp, { silent: true });
        if (result?.status === 'already') duplicateCount++;
        else if (result?.status === 'added') successCount++;
        else failCount++;
      } catch (error) {
        console.error(`Failed to add ${opp.title}:`, error);
        failCount++;
      }
      setProcessingProgress({ current: i + 1, total: selectedOpps.length });
    }

    // Invalidate grants query to refresh the list
    queryClient.invalidateQueries({ queryKey: ['grants'] });

    // Done processing
    setIsProcessing(false);
    setProcessingProgress({ current: 0, total: 0 });

    // Show completion toast
    const messageParts = [];
    if (successCount > 0) messageParts.push(`${successCount} added`);
    if (duplicateCount > 0) messageParts.push(`${duplicateCount} already in pipeline`);
    if (failCount > 0) messageParts.push(`${failCount} failed`);
    
    toast({
      id: 'bulk-add-pipeline',
      title: "Pipeline update complete",
      description: messageParts.join(' • ') || 'No changes were made.',
      duration: 5000,
    });
  };

  if (!results || results.length === 0) {
    return (
      <div className="rounded-xl border bg-white p-12 text-center space-y-4">
        <Search className="w-14 h-14 mx-auto text-slate-300" />
        <h3 className="text-xl font-semibold text-slate-900">No opportunities matched your profile</h3>
        <p className="text-slate-600 max-w-md mx-auto">
          No funding sources closely matched your profile criteria at this time. This means results would not be relevant enough to show.
        </p>
        <p className="text-sm text-muted-foreground">
          To improve results: add your location (state or ZIP code), profile type, and specific needs to your profile. The more complete your profile, the better we can find grants that truly fit you.
        </p>
      </div>
    );
  }

  const allSelected = selectedOpportunities.size === results.length && results.length > 0;

  return (
    <div data-component="SearchResults" data-results-count={results.length} data-selected-count={selectedOpportunities.size}>
      {/* Background Processing Indicator */}
      {isProcessing && (
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
            <div className="flex-1">
              <p className="font-semibold text-blue-900">Processing in Background</p>
              <p className="text-sm text-blue-700">
                Adding {processingProgress.current} of {processingProgress.total} opportunities...
              </p>
            </div>
            <Progress 
              value={(processingProgress.current / processingProgress.total) * 100} 
              className="w-32"
            />
          </div>
        </div>
      )}

      {/* Bulk Action Bar */}
      {results.length > 0 && (
        <div className="bulk-action-bar-debug mb-6 p-4 bg-white rounded-lg border shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Checkbox
                checked={allSelected}
                onCheckedChange={handleSelectAll}
                id="select-all"
              />
              <label htmlFor="select-all" className="font-medium cursor-pointer">
                {selectedOpportunities.size > 0 
                  ? `${selectedOpportunities.size} selected`
                  : 'Select all'
                }
              </label>
            </div>
            {selectedOpportunities.size > 0 && (
              <Button 
                onClick={handleBulkAdd}
                disabled={isProcessing}
                className="bg-blue-600 hover:bg-blue-700 text-white hover:text-white"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add {selectedOpportunities.size} to Pipeline
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {results.map((opp, idx) => {
          const oppKey = getOpportunityKey(opp, idx);
          const isSelected = selectedOpportunities.has(oppKey);
          
          return (
            <div 
              key={oppKey} 
              className={`flex flex-col bg-white rounded-xl shadow-sm border overflow-hidden transition-all ${
                isSelected ? 'ring-2 ring-blue-500 border-blue-500' : ''
              }`}
            >
              <div className="p-3 border-b bg-slate-50 flex items-center gap-2">
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => handleToggleSelection(oppKey)}
                  id={`select-${oppKey}`}
                />
                <label 
                  htmlFor={`select-${oppKey}`} 
                  className="text-sm font-medium cursor-pointer flex-1"
                >
                  Select
                </label>
              </div>
              <div className="flex-grow">
                 <GrantCard 
                   grant={opp} 
                   organizationName={organizationName}
                   showSummary={true}
                 />
              </div>
              <div className="p-4 bg-slate-50 border-t">
                <AddToPipelineButton 
                  opportunity={opp} 
                  onAddToPipeline={onAddToPipeline}
                  organizationName={organizationName}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
