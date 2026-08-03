import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Plus, Check, CheckSquare, Square, Search, Database, Star, Home, Info } from 'lucide-react';
import { useToast } from "@/components/ui/use-toast";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSavedGrantsStore } from '@/stores/savedGrantsStore';
import FundingResultCard from '@/components/funding/FundingResultCard';
import { toCanonicalResult } from '@/components/funding/toCanonicalResult';
import { dedupeFundingResults } from '@/utils/fundingDedupe';

const SOURCE_LABELS = {
  local_funding: 'Local funding',
  government_funding: 'Government',
  student_grants: 'Student grants',
  health_resources: 'Health resources',
  special_needs: 'Special needs',
  ecf_benefits: 'ECF Benefits',
  item_matching: 'Item funding',
  comprehensive: 'Search',
  catalog: 'Catalog',
  discovery: 'Discovery',
  pro_bono_legal: 'Pro Bono Legal',
  charity_care: 'Charity Care',
  workforce_training: 'Workforce Training',
  in_kind: 'In-Kind',
  pro_bono_in_kind: 'Pro Bono / In-Kind',
};

const OPPORTUNITY_TYPE_LABELS = {
  grant: 'Grant',
  scholarship: 'Scholarship',
  benefit: 'Benefit',
  program: 'Program',
  pro_bono: 'Pro Bono',
  in_kind: 'In-Kind',
  charity_care: 'Charity Care',
  training_paid: 'Free Training',
  legal_aid: 'Legal Aid',
  clinic_service: 'Clinic Service',
  equipment_donation: 'Equipment Donation',
};

const FUNDING_TYPE_LABELS = {
  cash: 'Cash',
  service: 'Service',
  cost_coverage: 'Cost Coverage',
  referral: 'Referral',
};

function getOpportunityTypeBadge(opp) {
  const oppType = opp?.opportunity_type || opp?.type || '';
  const fundingType = opp?.funding_type || '';
  const label = OPPORTUNITY_TYPE_LABELS[oppType] || null;
  const fundingLabel = FUNDING_TYPE_LABELS[fundingType] || null;
  const isProBono = ['pro_bono', 'in_kind', 'charity_care', 'training_paid', 'legal_aid', 'clinic_service', 'equipment_donation'].includes(oppType);
  return { label, fundingLabel, isProBono };
}

// Visible label + tooltip explaining what KIND of result this is. Critical
// for trust — users must never mistake a directory/referral for a grant.
const RESULT_KIND_BADGE = {
  direct:        { label: 'Direct Grant',         classes: 'border-emerald-300 text-emerald-800 bg-emerald-50',  tooltip: 'A grant, scholarship, or award you can apply for directly.' },
  benefit:       { label: 'Benefit Program',      classes: 'border-blue-300 text-blue-800 bg-blue-50',           tooltip: 'A public or nonprofit program you can apply to for assistance.' },
  directory:     { label: 'Directory / Referral', classes: 'border-amber-300 text-amber-800 bg-amber-50',        tooltip: 'A place to search, call, or contact — not itself the funding source. Use it to find help near you.' },
  school_portal: { label: 'School Aid Portal',    classes: 'border-indigo-300 text-indigo-800 bg-indigo-50',     tooltip: 'A school-specific financial aid page. Apply through the institution.' },
  action_step:   { label: 'Action Step',          classes: 'border-purple-300 text-purple-800 bg-purple-50',     tooltip: 'A task, training, or program — not direct cash. Useful next step toward funding.' },
};

function getResultKindBadge(opp) {
  const kind = String(opp?.result_kind || '').toLowerCase();
  return RESULT_KIND_BADGE[kind] || null;
}

function getPipelineAddBlockReason(opp) {
  if (!opp || typeof opp !== 'object') return 'Missing opportunity data.';
  const decision = String(opp.match_decision || opp.matchDecision || '').toLowerCase();
  if (decision === 'reject') return 'This source did not pass the profile match gate.';
  if (opp.link_status === 'broken') return 'The application link is marked broken.';

  const kind = String(opp.result_kind || opp.opportunity_kind || opp.kind || opp.type || '').toLowerCase();
  const provenance = String(opp.record_origin || opp.source || '').toLowerCase();
  if (
    kind.includes('directory') ||
    kind.includes('referral') ||
    kind === 'past_award_intel' ||
    provenance.startsWith('directory')
  ) {
    return 'This is a referral or search source, not a direct pipeline opportunity.';
  }

  if (!(opp.application_url || opp.apply_url)) {
    return opp.source_url || opp.url
      ? 'Only a source link is available. Visit the source and verify the application link before adding this to the pipeline.'
      : 'No application link is available yet.';
  }
  return null;
}

/**
 * Returns housing usability info for an opportunity.
 * Checks: usable_for_housing flag, refund_potential flag, and funding_category.
 */
function getHousingInfo(opp) {
  const isUsable =
    Boolean(opp?.usable_for_housing) ||
    Boolean(opp?.refund_potential) ||
    ['refund_eligible', 'stipend', 'housing_direct', 'faith_based', 'talent_based', 'coa_adjustment']
      .includes(opp?.funding_category)

  if (!isUsable) return null

  const category = opp?.funding_category || null
  const explanations = {
    refund_eligible: 'This scholarship may generate a refund check paid directly to you — use it for rent, utilities, and groceries after tuition is covered.',
    stipend: 'This program pays you a stipend directly, with no restrictions on use. You can apply it to off-campus rent, food, and utilities.',
    housing_direct: 'This program pays housing costs directly or provides free/reduced campus housing — freeing your cash for other expenses.',
    faith_based: 'This faith-based scholarship is often paid directly to you as a stipend, usable for housing and living costs.',
    talent_based: 'This talent-based award is typically a cash stipend with no restrictions — it can cover off-campus rent and utilities.',
    coa_adjustment: 'A successful Cost of Attendance (COA) appeal may increase your financial aid eligibility, unlocking more grant funds for housing.',
  }

  const explanation = explanations[category] ||
    (opp?.refund_potential
      ? 'This award may generate a refund after tuition — use it toward off-campus rent, utilities, or food.'
      : 'This funding can be applied toward off-campus living expenses.')

  return { explanation, category }
}

function formatSourceLabel(source) {
  if (!source || typeof source !== 'string') return 'Funding source';
  const key = source.toLowerCase().replace(/\s+/g, '_');
  return SOURCE_LABELS[key] || source.replace(/_/g, ' ');
}

function truncateLabel(s, max = 52) {
  const t = (s === null || s === undefined) ? '' : String(s).trim()
  if (!t) return ''
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

function getOpportunityRawKey(opp) {
  const raw =
    opp?.id ??
    opp?.source_id ??
    opp?.url ??
    opp?.application_url ??
    opp?.source_url ??
    `${opp?.title || 'untitled'}|${opp?.sponsor || opp?.funder || ''}`;
  return String(raw);
}

/**
 * Stable per-result React keys. The key must NOT embed the list index: the
 * discovery list re-sorts by score on every catalog refetch (staleTime 0 +
 * explicit refetchQueries during crawl polling), and an index-bearing key
 * remounts every card downstream of any reorder — wiping the
 * AddToPipelineButton's local "Added" state so a just-added card silently
 * reverts to an addable "Add to Pipeline" (the 4-of-5-clicks-did-nothing
 * walkthrough class, 2026-08-03). Only genuine raw-key collisions (upstream
 * duplicates with no id) get a positional disambiguator.
 */
function computeOpportunityKeys(list) {
  const seen = new Map();
  return (list || []).map((opp) => {
    const raw = getOpportunityRawKey(opp);
    const n = seen.get(raw) || 0;
    seen.set(raw, n + 1);
    return n === 0 ? raw : `${raw}#dup${n}`;
  });
}

export const AddToPipelineButton = ({ opportunity, onAddToPipeline, organizationName, disabledReason = null }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [lastStatus, setLastStatus] = React.useState(null);
  // Reset local status if the opportunity prop changes (e.g. new search results)
  const opportunityRef = React.useRef(opportunity?.id ?? opportunity?.title);
  React.useEffect(() => {
    const currentKey = opportunity?.id ?? opportunity?.title;
    if (opportunityRef.current !== currentKey) {
      opportunityRef.current = currentKey;
      setLastStatus(null);
    }
  }, [opportunity]);

  const mutation = useMutation({
    mutationFn: (opp) => onAddToPipeline(opp, { silent: true }),
    onSuccess: (result, opp) => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      // Refresh the discovery catalog so the server-side already_in_pipeline
      // flag (#5) reflects this add on the next fetch — the button no longer
      // depends solely on remount-fragile local state.
      queryClient.invalidateQueries({ queryKey: ['discover-catalog'] });
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

      if (['filtered', 'rejected', 'ineligible', 'skipped'].includes(status)) {
        toast({
          title: 'Kept out of this pipeline',
          description: result?.message || result?.reason || `"${opp?.title || opportunity?.title || 'This item'}" did not pass the profile match gates.`,
          duration: 4500,
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

      // Anything else — including the page handler's swallowed-error
      // `{ status: 'failed' }` return — is a FAILURE and must say so. This
      // used to fall through every branch above: no toast, no state change,
      // the button just sat there (the silent 4-of-5-clicks walkthrough bug).
      setLastStatus('failed');
      toast({
        variant: 'destructive',
        title: 'Could not add to pipeline',
        description:
          result?.message ||
          (typeof result?.error === 'string'
            ? `Not added — ${result.error.replace(/_/g, ' ')}.`
            : `"${opp?.title || opportunity?.title || 'This item'}" was not added. Try again.`),
        duration: 4500,
      });
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

  if (disabledReason) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block">
              <Button variant="outline" className="w-full bg-slate-50 text-slate-600 border-slate-200" disabled>
                <Info className="w-4 h-4 mr-2" /> Review source only
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">
            <p>{disabledReason}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

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

  // Server-declared duplicate (#5): the discovery route now annotates results
  // that resolve to an existing pipeline/application row via the canonical
  // opportunity identity. Surface WHY it isn't addable instead of hiding it
  // or rendering an addable button that can only ever answer "already".
  if (lastStatus === 'already' || (!lastStatus && opportunity?.already_in_pipeline)) {
    return (
      <Button variant="outline" className="w-full bg-slate-50 text-slate-700 border-slate-200" disabled>
        <Check className="w-4 h-4 mr-2" /> Already in pipeline
      </Button>
    );
  }

  if (['filtered', 'rejected', 'ineligible', 'skipped'].includes(lastStatus)) {
    return (
      <Button variant="outline" className="w-full bg-amber-50 text-amber-800 border-amber-200" disabled>
        <Check className="w-4 h-4 mr-2" /> Kept out
      </Button>
    );
  }

  if (lastStatus === 'failed') {
    // A failed add stays actionable: the toast said why, the button offers a
    // retry instead of silently reverting to a state that looks untouched.
    return (
      <Button onClick={handleClick} variant="outline" className="w-full bg-red-50 text-red-700 border-red-200 hover:bg-red-100">
        <Plus className="w-4 h-4 mr-2" />
        Retry add
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

export default function SearchResults({ results = [], profileId, onAddToPipeline, organizationName, diagnostics = null }) {
  const [selectedOpportunities, setSelectedOpportunities] = React.useState(new Set());
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [processingProgress, setProcessingProgress] = React.useState({ current: 0, total: 0 });
  const [filterHousingOnly, setFilterHousingOnly] = React.useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { savedIds, toggleGrant, isSaved } = useSavedGrantsStore();

  const uniqueResults = React.useMemo(() => dedupeFundingResults(results), [results]);

  // Apply housing filter
  const displayResults = React.useMemo(() => {
    if (!filterHousingOnly) return uniqueResults;
    return uniqueResults.filter((opp) => Boolean(getHousingInfo(opp)));
  }, [uniqueResults, filterHousingOnly]);

  const housingUsableCount = React.useMemo(
    () => uniqueResults.filter((opp) => Boolean(getHousingInfo(opp))).length,
    [uniqueResults]
  );

  // Keys that correspond to the currently displayed results. Stable across
  // re-sorts (no index component); selection state is still reconciled against
  // displayResults so filter toggles drop keys that left the view.
  const displayKeys = React.useMemo(
    () => computeOpportunityKeys(displayResults),
    [displayResults]
  );
  const addableDisplayKeys = React.useMemo(
    () => displayResults
      .map((opp, idx) => ({
        key: displayKeys[idx],
        blocked: Boolean(getPipelineAddBlockReason(opp)) || Boolean(opp?.already_in_pipeline),
      }))
      .filter((item) => !item.blocked)
      .map((item) => item.key),
    [displayResults, displayKeys]
  );

  // Reconcile selection whenever the displayed set changes (e.g. filter toggle).
  // Drop any selected keys that no longer correspond to a displayed result.
  React.useEffect(() => {
    setSelectedOpportunities((prev) => {
      if (prev.size === 0) return prev;
      const validKeys = new Set(addableDisplayKeys);
      let changed = false;
      const next = new Set();
      prev.forEach((k) => {
        if (validKeys.has(k)) next.add(k);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [addableDisplayKeys]);

  /** Distinct crawler / catalog pipeline keys (often one per run, e.g. "national" or a directory name). */
  const uniqueSources = React.useMemo(() => {
    if (!uniqueResults || uniqueResults.length === 0) return [];
    const set = new Set();
    uniqueResults.forEach((opp) => {
      const s = opp.source || opp.crawler_type || 'catalog';
      if (s) set.add(s);
    });
    return Array.from(set);
  }, [uniqueResults]);

  /** Distinct funders / program owners — better reflects "how many different programs" users expect. */
  const distinctFunders = React.useMemo(() => {
    if (!uniqueResults || uniqueResults.length === 0) return [];
    const set = new Set();
    uniqueResults.forEach((opp) => {
      const sp = (opp.sponsor || opp.funder || '').trim();
      if (sp) set.add(sp);
    });
    return Array.from(set);
  }, [uniqueResults]);

  /** Badges: show per-funder labels when one pipeline returned many programs; otherwise pipeline keys. */
  const summaryBadges = React.useMemo(() => {
    if (!uniqueResults?.length) return [];
    if (uniqueSources.length === 1 && distinctFunders.length > 1) return distinctFunders;
    return uniqueSources;
  }, [uniqueResults?.length, uniqueSources, distinctFunders]);

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
    if (selectedOpportunities.size === addableDisplayKeys.length && addableDisplayKeys.length > 0) {
      setSelectedOpportunities(new Set());
    } else {
      setSelectedOpportunities(new Set(addableDisplayKeys));
    }
  };

  const handleBulkAdd = async () => {
    // displayKeys is computed from displayResults in render order, so the
    // parallel index lookup here always matches the keys the checkboxes used.
    const selectedOpps = displayResults.filter((opp, idx) =>
      selectedOpportunities.has(displayKeys[idx]) &&
      !getPipelineAddBlockReason(opp) &&
      !opp?.already_in_pipeline
    );
    
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
    let skippedCount = 0;

    const failedTitles = [];
    for (let i = 0; i < selectedOpps.length; i++) {
      const opp = selectedOpps[i];
      try {
        // Silent per-item adds: only the summary toast below should be shown.
        const result = await onAddToPipeline(opp, { silent: true });
        if (result?.status === 'already') duplicateCount++;
        else if (result?.status === 'added') successCount++;
        else if (['filtered', 'rejected', 'ineligible', 'skipped'].includes(result?.status)) {
          // Valid non-error outcomes: not added but not a pipeline error.
          // These are distinct from duplicates — count them separately.
          skippedCount++;
        } else {
          failCount++;
          failedTitles.push(opp?.title || 'Unknown');
        }
      } catch (error) {
        console.error(`Failed to add ${opp?.title}:`, error);
        failCount++;
        failedTitles.push(opp?.title || 'Unknown');
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
    if (skippedCount > 0) messageParts.push(`${skippedCount} skipped`);
    if (failCount > 0) messageParts.push(`${failCount} failed`);
    
    toast({
      id: 'bulk-add-pipeline',
      title: "Pipeline update complete",
      description: messageParts.join(' • ') || 'No changes were made.',
      duration: 5000,
    });
  };

  if (!uniqueResults || uniqueResults.length === 0) {
    // Zero-result is a diagnosable state, never a dead end (mission Goals 8/9).
    // When the staged-ladder diagnostics are available, explain what was
    // searched/expanded and which profile fields to fill in next.
    const profileGaps = Array.isArray(diagnostics?.profileGaps) ? diagnostics.profileGaps : [];
    const tierExplanation = diagnostics?.tierExplanation || null;
    const tierAttempts = Number(diagnostics?.tierAttempts);
    const expansions = [
      diagnostics?.geoExpanded ? 'expanded the search radius' : null,
      diagnostics?.directoryOnly ? 'included funding directories' : null,
      tierAttempts > 1 ? `relaxed the match threshold across ${tierAttempts} tiers` : null,
    ].filter(Boolean);
    return (
      <div className="rounded-xl border bg-white p-12 text-center space-y-4">
        <Search className="w-14 h-14 mx-auto text-slate-300" />
        <h3 className="text-xl font-semibold text-slate-900">No opportunities matched your profile yet</h3>
        <p className="text-slate-600 max-w-md mx-auto">
          {tierExplanation
            || 'No funding sources closely matched your profile criteria at this time.'}
        </p>
        {expansions.length > 0 && (
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            We already {expansions.join(', ')} — still no strong matches.
          </p>
        )}
        <div className="max-w-md mx-auto text-left">
          <p className="text-sm font-medium text-slate-800 mb-1">Next steps to surface real matches:</p>
          {profileGaps.length > 0 ? (
            <ul className="list-disc list-inside text-sm text-slate-600 space-y-1">
              {profileGaps.slice(0, 6).map((gap, gapIdx) => {
                let key;
                let text;
                if (typeof gap === 'string') {
                  key = `gap-${gapIdx}-${gap}`;
                  text = gap;
                } else if (gap && typeof gap === 'object') {
                  const idPart = gap.field || gap.id || gap.key || '';
                  key = `gap-${gapIdx}-${String(idPart)}`;
                  text = gap.label || gap.message || gap.field || JSON.stringify(gap);
                } else {
                  key = `gap-${gapIdx}`;
                  text = String(gap);
                }
                return <li key={key}>{text}</li>;
              })}
            </ul>
          ) : (
            <ul className="list-disc list-inside text-sm text-slate-600 space-y-1">
              <li>Add your location (state or ZIP code).</li>
              <li>Set your profile type (individual, nonprofit, church, school, business…).</li>
              <li>Describe your specific needs or focus areas.</li>
            </ul>
          )}
        </div>
      </div>
    );
  }

  // Compute how many of the currently displayed results are selected, so the
  // "select all" checkbox reflects the displayed subset rather than stale keys.
  const selectedDisplayCount = displayKeys.reduce(
    (acc, key) => (selectedOpportunities.has(key) ? acc + 1 : acc),
    0
  );
  const allSelected = addableDisplayKeys.length > 0 && selectedDisplayCount === addableDisplayKeys.length;

  return (
    <div data-component="SearchResults" data-results-count={uniqueResults.length} data-selected-count={selectedOpportunities.size}>
      {/* Search pipeline vs program diversity: `source` is often identical per run; sponsors differ per card. */}
      {uniqueSources.length > 0 && (
        <div className="mb-4 flex flex-col gap-1.5 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Database className="w-4 h-4 shrink-0" />
            <span>
              {uniqueSources.length === 1 && distinctFunders.length > 1
                ? `1 search pipeline · ${distinctFunders.length} different funders or programs in these results`
                : `From ${uniqueSources.length} search pipeline${uniqueSources.length !== 1 ? 's' : ''}`}
              {uniqueSources.length > 1 && distinctFunders.length > 0
                ? ` · ${distinctFunders.length} distinct funder${distinctFunders.length !== 1 ? 's' : ''}`
                : null}
              :
            </span>
            {summaryBadges.slice(0, 8).map((src, idx) => (
              <Badge
                key={`${idx}-${String(src).slice(0, 48)}`}
                variant="secondary"
                className="font-normal max-w-[min(100%,24rem)] truncate"
              >
                {uniqueSources.length === 1 && distinctFunders.length > 1
                  ? truncateLabel(src, 56)
                  : formatSourceLabel(src)}
              </Badge>
            ))}
            {summaryBadges.length > 8 && (
              <Badge variant="outline">+{summaryBadges.length - 8} more</Badge>
            )}
          </div>
          {uniqueSources.length === 1 && uniqueResults.length > 1 && (
            <p className="text-xs text-slate-500 pl-6 max-w-3xl">
              The number above is the data pipeline (how results were gathered). Each card is still a separate opportunity
              {distinctFunders.length > 1 ? ', often from different funders or portals.' : '.'}
            </p>
          )}
        </div>
      )}

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
              value={processingProgress.total > 0 ? (processingProgress.current / processingProgress.total) * 100 : 0} 
              className="w-32"
            />
          </div>
        </div>
      )}

      {/* Housing filter bar */}
      {housingUsableCount > 0 && (
        <div className="mb-4 p-3 rounded-lg border border-teal-200 bg-teal-50 flex items-center gap-3 flex-wrap">
          <Home className="w-4 h-4 text-teal-600 shrink-0" />
          <label
            htmlFor="filter-housing"
            className="flex items-center gap-2 cursor-pointer text-sm text-teal-800 font-medium select-none"
          >
            <Checkbox
              id="filter-housing"
              checked={filterHousingOnly}
              onCheckedChange={(v) => setFilterHousingOnly(Boolean(v))}
              className="border-teal-400 data-[state=checked]:bg-teal-600 data-[state=checked]:border-teal-600"
            />
            Show funding usable for housing only
          </label>
          <span className="text-xs text-teal-700 ml-auto">
            {housingUsableCount} of {uniqueResults.length} result{uniqueResults.length !== 1 ? 's' : ''} can help with off-campus living
          </span>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help">
                  <Info className="w-4 h-4 text-teal-500" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs bg-teal-900 text-white border-teal-700">
                <p>
                  These are funding sources whose awards can be applied to rent, utilities, and food —
                  either because the payment is refunded to you after tuition, paid as a direct stipend,
                  or because a COA (Cost of Attendance) adjustment increases your eligible aid.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}

      {/* Bulk Action Bar */}
      {displayResults.length > 0 && (
        <div className="bulk-action-bar-debug mb-6 p-4 bg-white rounded-lg border shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Checkbox
                checked={allSelected}
                onCheckedChange={handleSelectAll}
                id="select-all"
                disabled={addableDisplayKeys.length === 0}
              />
              <label htmlFor="select-all" className="font-medium cursor-pointer">
                {selectedDisplayCount > 0 
                  ? `${selectedDisplayCount} selected`
                  : addableDisplayKeys.length > 0 ? 'Select all pipeline-ready' : 'No pipeline-ready items'
                }
              </label>
            </div>
            {selectedDisplayCount > 0 && (
              <Button 
                onClick={handleBulkAdd}
                disabled={isProcessing}
                className="bg-blue-600 hover:bg-blue-700 text-white hover:text-white"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add {selectedDisplayCount} to Pipeline
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {displayResults.map((opp, idx) => {
          const oppKey = displayKeys[idx];
          const isSelected = selectedOpportunities.has(oppKey);
          const savedId = opp.id ?? opp.source_id;
          const pipelineBlockReason = getPipelineAddBlockReason(opp);
          const alreadyInPipeline = Boolean(opp?.already_in_pipeline);

          return (
            <div
              key={oppKey}
              className={`flex flex-col bg-white rounded-xl shadow-sm border overflow-hidden transition-all ${
                isSelected ? 'ring-2 ring-blue-500 border-blue-500' : ''
              }`}
            >
              <div className="p-3 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => handleToggleSelection(oppKey)}
                  id={`select-${oppKey}`}
                  disabled={Boolean(pipelineBlockReason) || alreadyInPipeline}
                />
                <label
                  htmlFor={`select-${oppKey}`}
                  className={`text-sm font-medium flex-1 min-w-0 ${(pipelineBlockReason || alreadyInPipeline) ? 'cursor-not-allowed text-slate-500' : 'cursor-pointer'}`}
                  title={pipelineBlockReason || (alreadyInPipeline ? 'This opportunity is already in the pipeline for this profile.' : undefined)}
                >
                  {alreadyInPipeline ? 'In pipeline' : pipelineBlockReason ? 'Source only' : 'Select'}
                </label>
                {alreadyInPipeline && (
                  <Badge variant="outline" className="text-xs shrink-0 border-slate-300 text-slate-700 bg-slate-100">
                    Already in pipeline
                  </Badge>
                )}
                {/* Save / star bookmark */}
                {savedId !== null && savedId !== undefined && (
                  <button
                    type="button"
                    title={isSaved(savedId) ? 'Remove from saved' : 'Save this grant'}
                    onClick={() => toggleGrant(savedId)}
                    className="shrink-0 text-slate-400 hover:text-yellow-500 transition-colors"
                  >
                    <Star
                      className="w-4 h-4"
                      fill={isSaved(savedId) ? 'currentColor' : 'none'}
                      style={isSaved(savedId) ? { color: '#f59e0b' } : {}}
                    />
                  </button>
                )}
                {(() => {
                  const kindBadge = getResultKindBadge(opp);
                  if (!kindBadge) return null;
                  return (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className={`text-xs shrink-0 cursor-help ${kindBadge.classes}`}>
                            {kindBadge.label}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
                          <p>{kindBadge.tooltip}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })()}
                {(opp.source || opp.crawler_type) && (
                  <Badge variant="outline" className="text-xs shrink-0">
                    {formatSourceLabel(opp.source || opp.crawler_type)}
                  </Badge>
                )}
                {!(opp.application_url || opp.apply_url) && (opp.source_url || opp.url) && (
                  <Badge variant="outline" className="text-xs shrink-0 border-amber-300 text-amber-700 bg-amber-50">
                    Source only
                  </Badge>
                )}
                {!(opp.application_url || opp.apply_url || opp.url || opp.source_url) && (
                  <Badge variant="outline" className="text-xs shrink-0 border-amber-300 text-amber-700 bg-amber-50">
                    No apply link
                  </Badge>
                )}
                {opp.link_status === 'broken' && (
                  <Badge variant="outline" className="text-xs shrink-0 border-red-300 text-red-700 bg-red-50">
                    Link broken
                  </Badge>
                )}
                {(() => {
                  const { label, fundingLabel, isProBono } = getOpportunityTypeBadge(opp);
                  return isProBono ? (
                    <>
                      <Badge variant="secondary" className="text-xs shrink-0 bg-purple-100 text-purple-800 border-purple-200">
                        {label || 'Service'}
                      </Badge>
                      {fundingLabel && (
                        <Badge variant="outline" className="text-xs shrink-0 border-purple-200 text-purple-700">
                          {fundingLabel}
                        </Badge>
                      )}
                    </>
                  ) : null;
                })()}
                {/* Housing-usable badge with tooltip */}
                {(() => {
                  const housingInfo = getHousingInfo(opp);
                  if (!housingInfo) return null;
                  return (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="text-xs shrink-0 border-teal-300 text-teal-700 bg-teal-50 flex items-center gap-1 cursor-help"
                          >
                            <Home className="w-3 h-3" />
                            Can be used for housing
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent
                          side="bottom"
                          className="max-w-xs text-xs leading-relaxed bg-teal-900 text-white border-teal-700"
                        >
                          <p>{housingInfo.explanation}</p>
                          {opp.funding_category && (
                            <p className="mt-1 opacity-75">
                              Category: {opp.funding_category.replace(/_/g, ' ')}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })()}
              </div>
              <div className="flex-grow p-2">
                <FundingResultCard
                  result={toCanonicalResult(opp)}
                  className="border-0 shadow-none"
                  onSecondaryAction={(savedId !== null && savedId !== undefined) ? () => toggleGrant(savedId) : undefined}
                />
              </div>
              <div className="p-4 bg-slate-50 border-t">
                <AddToPipelineButton 
                  opportunity={opp} 
                  onAddToPipeline={onAddToPipeline}
                  organizationName={organizationName}
                  disabledReason={pipelineBlockReason}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
