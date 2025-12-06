import React, { useMemo, useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import GrantCard from '../pipeline/GrantCard';
import { Button } from '@/components/ui/button';
import { Loader2, Plus, Check, CheckSquare, Square, Lightbulb, X, CheckCircle2, Clock, Sparkles } from 'lucide-react';
import { useToast } from "@/components/ui/use-toast";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { base44 } from '@/api/base44Client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import AIMatchResults from './AIMatchResults';

/** Normalize opportunity id (id || source_id) as a string */
const getOppId = (opp) => String(opp?.id ?? opp?.source_id ?? '');

const AddToPipelineButton = ({ opportunity, onAddToPipeline, organizationName, estimatedMinutes = 6, isAdding = false }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      // Avoid double-submission if parent already flags as adding
      if (isAdding) return null;
      return onAddToPipeline(opportunity);
    },
    onSuccess: (newGrant) => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      // Toast is already shown by the handler in DiscoverGrants
    },
    onError: (error) => {
      // Error toast is already shown by the handler
      console.error('[AddToPipelineButton] Error:', error);
    }
  });

  const handleClick = () => {
    if (!isAdding && !mutation.isPending) {
      mutation.mutate();
    }
  };

  const pending = mutation.isPending || isAdding;

  if (mutation.isSuccess) {
    return (
      <div className="space-y-2">
        <Button
          variant="outline"
          className="w-full bg-emerald-50 text-emerald-700 border-emerald-200"
          disabled
          data-testid="add-pipeline-success"
        >
          <Check className="w-4 h-4 mr-2" />
          Added & Analyzing
        </Button>
        <div className="flex items-center justify-center gap-2 text-xs text-slate-600">
          <Clock className="w-3 h-3" />
          <span>{estimatedMinutes} min billed</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        onClick={handleClick}
        disabled={pending}
        className="w-full bg-blue-600 hover:bg-blue-700"
        data-testid="add-pipeline-button"
      >
        {pending ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Adding...
          </>
        ) : (
          <>
            <Plus className="w-4 h-4 mr-2" />
            Add to Pipeline
          </>
        )}
      </Button>
      <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
        <Clock className="w-3 h-3" />
        <span>~{estimatedMinutes} min auto-work</span>
      </div>
    </div>
  );
};

export default function SearchResults({ results = [], onAddToPipeline, isLoading, selectedOrgId }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [addingIds, setAddingIds] = useState(new Set());
  const [suggestedFields, setSuggestedFields] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [totalBilledMinutes, setTotalBilledMinutes] = useState(0);

  // SORT RESULTS BY MATCH SCORE (HIGHEST FIRST)
  const sortedResults = useMemo(() => {
    return [...results].sort((a, b) => ((b.match ?? b.match_score) || 0) - ((a.match ?? a.match_score) || 0));
  }, [results]);

  // Precompute the normalized ID set for this render to keep "Select all" stable
  const normalizedIds = useMemo(() => new Set(sortedResults.map(getOppId).filter(Boolean)), [sortedResults]);

  const allSelected = useMemo(() => {
    if (normalizedIds.size === 0) return false;
    // Check if every normalized ID is in selectedIds
    for (const id of normalizedIds) {
      if (!selectedIds.has(id)) return false;
    }
    return true;
  }, [normalizedIds, selectedIds]);

  const toggleSelect = (opportunityId) => {
    if (!opportunityId) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(opportunityId)) next.delete(opportunityId);
      else next.add(opportunityId);
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedIds(prev => {
      if (allSelected) {
        return new Set();
      } else {
        // Create new Set from all valid IDs
        return new Set([...normalizedIds]);
      }
    });
  };

  // ANALYZE RESULTS FOR MISSING PROFILE DATA (guarded, case-insensitive, avoids false positives on empty content)
  useEffect(() => {
    if (sortedResults && sortedResults.length > 0) {
      const textChunks = sortedResults.map(r => {
        const bullets = Array.isArray(r?.eligibilityBullets) ? r.eligibilityBullets.join(' ') : '';
        const desc = typeof r?.descriptionMd === 'string' ? r.descriptionMd : '';
        const tags = Array.isArray(r?.audience_tags) ? r.audience_tags.join(' ') : '';
        return [bullets, desc, tags].filter(Boolean).join(' ');
      });
      const allText = textChunks.join(' ').toLowerCase();

      if (!allText.trim()) {
        setSuggestedFields([]);
        setShowSuggestions(false);
        return;
      }

      const suggestions = [];

      const includesAny = (arr) => arr.some(w => allText.includes(w));

      // Firearms / Second Amendment
      if (includesAny([' nra ', ' shooting', ' hunter', ' firearm'])) {
        suggestions.push({
          category: 'Firearms / Second Amendment',
          fields: [
            { key: 'gun_owner', label: 'Gun Owner' },
            { key: 'nra_member', label: 'NRA Member' },
            { key: 'hunter', label: 'Hunter' },
            { key: 'competitive_shooter', label: 'Competitive Shooter' }
          ]
        });
      }

      // Political / Civic
      if (includesAny(['elected', 'official', 'council', 'mayor', 'civic leader'])) {
        suggestions.push({
          category: 'Political / Civic Engagement',
          fields: [
            { key: 'elected_official', label: 'Elected Official' },
            { key: 'political_candidate', label: 'Political Candidate' },
            { key: 'municipal_official', label: 'Municipal Official' },
            { key: 'party_committee_member', label: 'Party Committee Member' }
          ]
        });
      }

      // Heritage
      if (includesAny(['irish', 'italian', 'polish', 'greek'])) {
        suggestions.push({
          category: 'Cultural Heritage',
          fields: [
            { key: 'irish_heritage', label: 'Irish Heritage' },
            { key: 'italian_heritage', label: 'Italian Heritage' },
            { key: 'polish_heritage', label: 'Polish Heritage' },
            { key: 'greek_heritage', label: 'Greek Heritage' }
          ]
        });
      }

      // Religious
      if (includesAny(['catholic', ' jewish', ' christian', ' faith'])) {
        suggestions.push({
          category: 'Religious Affiliation',
          fields: [
            { key: 'religious_affiliation_catholic', label: 'Catholic' },
            { key: 'religious_affiliation_jewish', label: 'Jewish' },
            { key: 'religious_affiliation_christian', label: 'Christian' },
            { key: 'religious_affiliation_protestant', label: 'Protestant' }
          ]
        });
      }

      // Medical
      if (includesAny(['cancer', 'dialysis', 'transplant', 'rare disease'])) {
        suggestions.push({
          category: 'Medical Conditions',
          fields: [
            { key: 'cancer_survivor', label: 'Cancer Survivor' },
            { key: 'dialysis_patient', label: 'Dialysis Patient' },
            { key: 'organ_transplant', label: 'Organ Transplant' },
            { key: 'rare_disease', label: 'Rare Disease' }
          ]
        });
      }

      // Geographic
      if (includesAny(['rural', 'appalachian', 'frontier'])) {
        suggestions.push({
          category: 'Geographic Qualifiers',
          fields: [
            { key: 'rural_resident', label: 'Rural Resident' },
            { key: 'appalachian_region', label: 'Appalachian Region' },
            { key: 'frontier_county', label: 'Frontier County' }
          ]
        });
      }

      setSuggestedFields(suggestions);
      setShowSuggestions(suggestions.length > 0);
    } else {
      setSuggestedFields([]);
      setShowSuggestions(false);
    }
  }, [sortedResults]);

  const handleApplySuggestions = async (categoryFields) => {
    if (!selectedOrgId) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'No organization selected to update profile.'
      });
      return;
    }

    try {
      const updates = {};
      categoryFields.forEach(field => { updates[field.key] = true; });

      await base44.entities.Organization.update(selectedOrgId, updates);

      // Log time for profile enhancement (3 min)
      const user = await base44.auth.me();
      const now = new Date();
      await base44.entities.TimeEntry.create({
        organization_id: selectedOrgId,
        user_id: user?.id,
        task_category: 'Updates',
        start_at: new Date(now.getTime() - 3 * 60 * 1000).toISOString(),
        end_at: now.toISOString(),
        raw_minutes: 3,
        rounded_minutes: 3,
        note: `Automated profile enhancement - added ${categoryFields.length} data points`,
        source: 'auto',
        invoiced: false
      });
      queryClient.invalidateQueries({ queryKey: ['recentTimeEntries'] });

      toast({
        title: '✅ Profile Updated',
        description: `Added ${categoryFields.length} data points. 3 min logged for billing.`,
      });

      // Remove applied category
      setSuggestedFields(prev => prev.filter(cat => {
        const thisIds = cat.fields.map((f) => f.key).sort();
        const appliedIds = categoryFields.map(f => f.key).sort();
        return JSON.stringify(thisIds) !== JSON.stringify(appliedIds);
      }));

      // Hide banner if no categories remain
      setShowSuggestions(prev => (prev && suggestedFields.length - 1 > 0));
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Update Failed',
        description: error?.message || 'Unable to update profile.',
      });
    }
  };

  const handleBulkAdd = async () => {
    const selectedOpps = sortedResults.filter(opp => selectedIds.has(getOppId(opp)));
    if (selectedOpps.length === 0) return;

    setSelectedIds(new Set());

    const estimatedMinutesPerGrant = 6;
    const totalEstimatedMinutes = selectedOpps.length * estimatedMinutesPerGrant;

    toast({
      title: "🚀 Automation Starting",
      description: `Adding ${selectedOpps.length} opportunities with AI analysis. ~${totalEstimatedMinutes} min will be billed.`,
      duration: 5000,
    });

    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: selectedOpps.length });
    setTotalBilledMinutes(0);

    let successCount = 0;
    let failCount = 0;
    let duplicateCount = 0;
    let actualBilledMinutes = 0;

    for (let i = 0; i < selectedOpps.length; i++) {
      const opp = selectedOpps[i];
      const id = getOppId(opp);
      if (!id) continue;

      setAddingIds(prev => new Set(prev).add(id));

      try {
        const result = await onAddToPipeline(opp);
        if (result) {
          successCount++;
          actualBilledMinutes += estimatedMinutesPerGrant;
          setTotalBilledMinutes(actualBilledMinutes);
        }
      } catch (error) {
        const msg = error?.message || '';
        if (msg.toLowerCase().includes('already in pipeline')) {
          duplicateCount++;
        } else {
          console.error(`[SearchResults] Failed to add ${opp?.title || id}:`, error);
          failCount++;
        }
      } finally {
        setAddingIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }

      setProcessingProgress({ current: i + 1, total: selectedOpps.length });
    }

    queryClient.invalidateQueries({ queryKey: ['grants'] });
    queryClient.invalidateQueries({ queryKey: ['recentTimeEntries'] });

    setIsProcessing(false);
    setProcessingProgress({ current: 0, total: 0 });

    const summary = [];
    if (successCount > 0) summary.push(`${successCount} added & analyzing`);
    if (duplicateCount > 0) summary.push(`${duplicateCount} already in pipeline`);
    if (failCount > 0) summary.push(`${failCount} failed`);
    summary.push(`${actualBilledMinutes} min billed`);

    toast({
      title: "✅ Automation Complete",
      description: summary.join(' • '),
      duration: 8000,
    });
  };

  const scoreStats = useMemo(() => {
    if (sortedResults.length === 0) return null;
    const scores = sortedResults.map(r => (r.match ?? r.match_score) || 0);
    const highest = Math.max(...scores);
    const lowest = Math.min(...scores);
    const average = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const excellent = sortedResults.filter(r => ((r.match ?? r.match_score) || 0) >= 80).length;
    const good = sortedResults.filter(r => {
      const s = (r.match ?? r.match_score) || 0;
      return s >= 60 && s < 80;
    }).length;
    const fair = sortedResults.filter(r => {
      const s = (r.match ?? r.match_score) || 0;
      return s >= 40 && s < 60;
    }).length;
    const poor = sortedResults.filter(r => (((r.match ?? r.match_score) || 0) < 40)).length;
    return { highest, lowest, average, excellent, good, fair, poor };
  }, [sortedResults]);

  const hasAIAnalysis = useMemo(
    () => results.some(r =>
      (Array.isArray(r?.matchReasons) && r.matchReasons.length > 0) ||
      (Array.isArray(r?.match_reasons) && r.match_reasons.length > 0) ||
      (Array.isArray(r?.why_this_matches) && r.why_this_matches.length > 0) ||
      typeof r?.strategic_fit_summary === 'string'
    ),
    [results]
  );

  if (!results || results.length === 0) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Suggested Profile Enhancements */}
      {showSuggestions && suggestedFields.length > 0 && (
        <Card className="border-2 border-blue-200 bg-blue-50">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-blue-900">
                  <Lightbulb className="w-5 h-5" />
                  Suggested Profile Enhancements
                </CardTitle>
                <CardDescription className="text-blue-700">
                  Based on the opportunities found, these profile data points might help you discover more relevant funding
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSuggestions(false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {suggestedFields.map((category, idx) => (
              <div key={idx} className="p-4 bg-white rounded-lg">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-semibold text-slate-900">{category.category}</h4>
                  <Button
                    size="sm"
                    onClick={() => handleApplySuggestions(category.fields)}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add All (3 min)
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {category.fields.map((field, fIdx) => (
                    <Badge key={fIdx} variant="outline" className="text-sm">
                      {field.label}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Processing Indicator */}
      {isProcessing && (
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg" data-testid="processing-indicator">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
            <div className="flex-1">
              <p className="font-semibold text-blue-900">Automation Running</p>
              <p className="text-sm text-blue-700">
                Adding {processingProgress.current} of {processingProgress.total} • {totalBilledMinutes} min billed so far
              </p>
            </div>
            <Progress
              value={(processingProgress.current / processingProgress.total) * 100}
              className="w-32"
            />
          </div>
        </div>
      )}

      {/* Bulk Selection Bar */}
      {results.length > 0 && (
        <div className="mb-6 p-4 bg-white rounded-lg border shadow-sm" data-testid="bulk-action-bar">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div 
              className="flex items-center gap-3 cursor-pointer select-none"
              onClick={handleSelectAll}
            >
              <Checkbox
                checked={allSelected}
                onCheckedChange={handleSelectAll}
                id="select-all"
                aria-label={allSelected ? "Deselect all opportunities" : "Select all opportunities"}
              />
              <label htmlFor="select-all" className="font-medium cursor-pointer">
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
              </label>
              {selectedIds.size > 0 && (
                <Badge variant="outline" className="ml-2">
                  ~{selectedIds.size * 6} min auto-work
                </Badge>
              )}
            </div>
            {selectedIds.size > 0 && (
              <Button
                onClick={handleBulkAdd}
                disabled={isProcessing}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="bulk-add-button"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add {selectedIds.size} to Pipeline
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Search Results Header with Score Stats */}
      <Card className="shadow-lg border-0">
        <CardHeader className="bg-gradient-to-r from-emerald-600 to-blue-600 text-white">
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="w-6 h-6" />
            {sortedResults.length} Opportunit{sortedResults.length !== 1 ? 'ies' : 'y'} Found
          </CardTitle>
          <CardDescription className="text-blue-50">
            Ranked by match score (best first) • Each add triggers AI analysis
          </CardDescription>
        </CardHeader>
        {scoreStats && (
          <CardContent className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="text-center p-3 bg-slate-50 rounded-lg">
                <p className="text-2xl font-bold text-emerald-600">{scoreStats.highest}%</p>
                <p className="text-xs text-slate-600">Highest</p>
              </div>
              <div className="text-center p-3 bg-blue-600 rounded-lg">
                <p className="text-2xl font-bold text-white">{scoreStats.average}%</p>
                <p className="text-xs text-blue-100">Average</p>
              </div>
              <div className="text-center p-3 bg-green-50 rounded-lg">
                <p className="text-lg font-bold text-green-700">{scoreStats.excellent}</p>
                <p className="text-xs text-green-600">80%+ Excellent</p>
              </div>
              <div className="text-center p-3 bg-blue-50 rounded-lg">
                <p className="text-lg font-bold text-blue-700">{scoreStats.good}</p>
                <p className="text-xs text-blue-600">60-79% Good</p>
              </div>
              <div className="text-center p-3 bg-amber-50 rounded-lg">
                <p className="text-lg font-bold text-amber-700">{scoreStats.fair + scoreStats.poor}</p>
                <p className="text-xs text-amber-600">&lt;60% Review</p>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* AI Analysis Notice */}
      {hasAIAnalysis && (
        <Alert className="bg-purple-50 border-purple-300">
          <Sparkles className="h-4 w-4 text-purple-600" />
          <AlertDescription className="text-purple-900">
            <strong>AI-Enhanced Results:</strong> These opportunities have been analyzed by AI to provide match scores, 
            strategic fit summaries, funder tone analysis, and MBA-level narrative recommendations based on parsed funder website data.
          </AlertDescription>
        </Alert>
      )}

      {/* Results Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {sortedResults.map((opp) => {
          const oppId = getOppId(opp);
          const hasOppAIAnalysis =
            (Array.isArray(opp?.matchReasons) && opp.matchReasons.length > 0) ||
            (Array.isArray(opp?.match_reasons) && opp.match_reasons.length > 0) ||
            (Array.isArray(opp?.why_this_matches) && opp.why_this_matches.length > 0) ||
            typeof opp?.strategic_fit_summary === 'string';

          return (
            <div key={oppId} className="relative">
              {/* Selection checkbox overlay */}
              <div className="absolute top-3 left-3 z-10">
                <Checkbox
                  checked={selectedIds.has(oppId)}
                  onCheckedChange={() => toggleSelect(oppId)}
                  className="bg-white border-2 shadow-sm"
                />
              </div>
              
              {hasOppAIAnalysis ? (
                <AIMatchResults
                  opportunity={opp}
                  onAddToPipeline={onAddToPipeline}
                  isAdding={addingIds.has(oppId)}
                />
              ) : (
                <GrantCard
                  grant={opp}
                  isSelected={selectedIds.has(oppId)}
                  onSelect={() => toggleSelect(oppId)}
                  addButton={
                    <AddToPipelineButton
                      opportunity={opp}
                      onAddToPipeline={onAddToPipeline}
                      isAdding={addingIds.has(oppId)}
                    />
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}