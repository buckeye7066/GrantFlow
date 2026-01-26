
import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import GrantCard from '../pipeline/GrantCard';
import { Button } from '@/components/ui/button';
import { Loader2, Plus, Check, CheckSquare, Square } from 'lucide-react';
import { useToast } from "@/components/ui/use-toast";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from '@/components/ui/checkbox';

const AddToPipelineButton = ({ opportunity, onAddToPipeline, organizationName }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: onAddToPipeline,
    onSuccess: (newGrant) => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      toast({
        title: "Added to Pipeline!",
        description: `"${newGrant.title}" is now in the discovery stage for ${organizationName}.`,
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Could not add to pipeline.",
      });
    }
  });

  const handleClick = () => mutation.mutate(opportunity);

  if (mutation.isSuccess) {
    return <Button variant="outline" className="w-full bg-emerald-50 text-emerald-700" disabled><Check className="w-4 h-4 mr-2" /> Added</Button>;
  }

  return (
    <Button onClick={handleClick} disabled={mutation.isPending} className="w-full">
      {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
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

  const handleToggleSelection = (opportunityId) => {
    setSelectedOpportunities(prev => {
      const newSet = new Set(Array.from(prev)); // Create proper new Set from array
      if (newSet.has(opportunityId)) {
        newSet.delete(opportunityId);
      } else {
        newSet.add(opportunityId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedOpportunities.size === results.length && results.length > 0) {
      setSelectedOpportunities(new Set());
    } else {
      const allIds = results.map(opp => opp.id || opp.source_id);
      setSelectedOpportunities(new Set(allIds));
    }
  };

  const handleBulkAdd = async () => {
    const selectedOpps = results.filter(opp => 
      selectedOpportunities.has(opp.id || opp.source_id)
    );
    
    if (selectedOpps.length === 0) return;

    // Clear selection immediately
    setSelectedOpportunities(new Set());
    
    // Show initial toast
    toast({
      title: "🚀 Processing in Background",
      description: `Adding ${selectedOpps.length} opportunities to pipeline. Checking for duplicates...`,
      duration: 3000,
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
        const result = await onAddToPipeline(opp);
        if (result) {
          successCount++;
        }
      } catch (error) {
        // Check if error is due to duplicate (the onAddToPipeline returns existing grant)
        if (error?.message?.includes('already in pipeline') || error?.message?.includes('Already in Pipeline')) {
          duplicateCount++;
        } else {
          console.error(`Failed to add ${opp.title}:`, error);
          failCount++;
        }
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
      title: "✅ Bulk Add Complete",
      description: messageParts.join(' • '),
      duration: 5000,
    });
  };

  if (!results || results.length === 0) {
    return null;
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
        {results.map((opp) => {
          const oppId = opp.id || opp.source_id;
          const isSelected = selectedOpportunities.has(oppId);
          
          return (
            <div 
              key={oppId} 
              className={`flex flex-col bg-white rounded-xl shadow-sm border overflow-hidden transition-all ${
                isSelected ? 'ring-2 ring-blue-500 border-blue-500' : ''
              }`}
            >
              <div className="p-3 border-b bg-slate-50 flex items-center gap-2">
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => handleToggleSelection(oppId)}
                  id={`select-${oppId}`}
                />
                <label 
                  htmlFor={`select-${oppId}`} 
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
