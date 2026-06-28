import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import client, { apiFetch } from '@/api/client';
import { useFundingResultsStore } from '@/stores/fundingResultsStore';
import { useAuthStore } from '@/stores/authStore';
import { createPageUrl } from '@/utils';
import { AddToPipelineButton } from '@/components/discovery/SearchResults';
import FundingResultCard from '@/components/funding/FundingResultCard';
import { toCanonicalResult } from '@/components/funding/toCanonicalResult';
import { dedupeFundingResults } from '@/utils/fundingDedupe';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Search, ChevronRight, Home, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/use-toast';
import { createLogger } from '@/utils/logger';
import { formatReasonText } from '@/utils/reasonText';

const SORT_OPTIONS = [
  { value: 'match', label: 'Match score' },
  { value: 'deadline', label: 'Deadline' },
  { value: 'amount', label: 'Amount' },
  { value: 'recently_added', label: 'Recently Added' },
];

function getOpportunityKey(opp, idx) {
  const raw =
    opp?.id ??
    opp?.source_id ??
    opp?.url ??
    opp?.application_url ??
    opp?.source_url ??
    `${opp?.title || 'untitled'}|${opp?.sponsor || opp?.funder || ''}`;
  return `${String(raw)}|${idx}`;
}

function parseDeadline(opp) {
  const raw = opp?.deadline ?? opp?.deadlineAt ?? null;
  if (!raw || String(raw).toLowerCase() === 'rolling') return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function parseAmount(opp) {
  const val = opp?.amount_max ?? opp?.awardMax ?? opp?.typical_award ?? opp?.amount_min ?? opp?.awardMin ?? 0;
  return Number(val) || 0;
}

function getMatchReasons(opp) {
  // Only trust match_reasons (snake_case) written by the server-side decision engine.
  // matchReasons (camelCase) may come from client-side crawler data and is not engine-authoritative.
  const reasons = opp?.match_reasons;
  if (Array.isArray(reasons) && reasons.length > 0) return reasons;
  // Engine reasons absent: surface a non-empty placeholder so the user is not silently given nothing.
  // This is a display-layer fallback only; it does not affect pipeline insertion logic.
  const decision = (opp?.match_decision ?? opp?.matchDecision ?? '').toUpperCase();
  if (decision === 'ACCEPT') return ['Engine accepted this opportunity for your profile.'];
  if (decision === 'REVIEW') return ['Engine flagged this opportunity for manual review.'];
  return [];
}

function MatchReasonsCollapsible({ reasons }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-between text-sm text-muted-foreground hover:text-foreground">
          <span>Why it matched</span>
          <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="list-disc list-inside text-xs text-muted-foreground space-y-1 pl-2 pb-2">
          {reasons.map((r, i) => {
            const text = formatReasonText(r)
            return text ? <li key={i}>{text}</li> : null
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function FundingResults() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const log = useMemo(() => createLogger('FundingResults'), []);
  const { isAuthenticated, accessToken, sessionExpired, activeProfileId } = useAuthStore((s) => ({
    isAuthenticated: s.isAuthenticated,
    accessToken: s.accessToken,
    sessionExpired: s.sessionExpired,
    activeProfileId: s.activeProfileId,
  }));
  const storedResultsProfileId = useFundingResultsStore((s) => s.profileId);
  const requestedResultsProfileId =
    (activeProfileId && activeProfileId !== '__admin__'
      ? activeProfileId
      : null) ||
    storedResultsProfileId ||
    null;
  const {
    results,
    profileId,
    organizationName,
    organizationId,
    returned,
    totalFound,
    totalScored,
    truncated,
    thresholdFallbackMessage,
    diagnostics,
  } = useFundingResultsStore((s) => s.getResultsForProfile(requestedResultsProfileId));

  const [sortBy, setSortBy] = useState('match');
  const [strongMatchesOnly, setStrongMatchesOnly] = useState(false);
  const [showHousingOnly, setShowHousingOnly] = useState(false);

  const tokenAvailable = useMemo(() => {
    try {
      return Boolean(accessToken || client.getToken?.());
    } catch {
      return Boolean(accessToken);
    }
  }, [accessToken]);
  const authReady = !sessionExpired && (isAuthenticated || tokenAvailable);
  const uniqueResults = useMemo(() => dedupeFundingResults(results || []), [results]);
  const displayedReturned = uniqueResults.length;
  const displayedTotalFound = Number.isFinite(Number(totalFound)) ? Number(totalFound) : displayedReturned;

  const filteredAndSorted = useMemo(() => {
    let list = [...uniqueResults];
    if (showHousingOnly) {
      list = list.filter((o) => o.usable_for_housing === true || o.usable_for_housing === 1);
    }
    if (strongMatchesOnly) {
      // Only suppress when the engine has NOT already made an ACCEPT/REVIEW decision.
      // If match_decision is ACCEPT or REVIEW, honour the engine regardless of score.
      list = list.filter((o) => {
        const decision = (o?.match_decision ?? o?.matchDecision ?? '').toUpperCase();
        // Honour all engine decisions unconditionally.
        if (decision === 'ACCEPT' || decision === 'REVIEW') return true;
        // If the engine explicitly rejected, respect that.
        if (decision === 'REJECT') return false;
        // Engine decision absent: use match_score only (never the raw crawler
        // `match` field). Unscored rows are not "strong" on a page with add buttons.
        // because this page never inserts grants â it only presents candidates.
        const score = Number(o?.match_score ?? null);
        if (isNaN(score) || o?.match_score === null) {
          return false;
        }
        return score >= 70;
      });
    }
    if (sortBy === 'match') {
      list.sort((a, b) => (Number(b?.match_score ?? 0) - Number(a?.match_score ?? 0)));
    } else if (sortBy === 'deadline') {
      list.sort((a, b) => {
        const da = parseDeadline(a) ?? Infinity;
        const db = parseDeadline(b) ?? Infinity;
        return da - db;
      });
    } else if (sortBy === 'amount') {
      list.sort((a, b) => parseAmount(b) - parseAmount(a));
    } else if (sortBy === 'recently_added') {
      list.sort((a, b) => new Date(b?.created_at ?? 0) - new Date(a?.created_at ?? 0));
    }
    return list;
  }, [uniqueResults, sortBy, strongMatchesOnly, showHousingOnly]);

  const handleAddToPipeline = async (opportunity, { silent = false } = {}) => {
    log.debug('add to pipeline requested');
    if (!authReady) {
      if (!silent) {
        toast({
          variant: 'destructive',
          title: 'Sign in required',
          description: 'Your session has expired. Please sign in again before updating the pipeline.',
        });
      }
      return { status: 'failed', error: 'not_authenticated' };
    }
    if (!profileId) {
      if (!silent) {
        toast({
          variant: 'destructive',
          title: 'No profile selected',
          description: 'Please run a new search from Discover Grants and select a profile.',
        });
      }
      return { status: 'failed', error: 'missing_profile' };
    }

    const orgId = organizationId ?? null;
    const candidateUrl = opportunity.application_url ?? opportunity.apply_url ?? null;
    if (orgId && candidateUrl) {
      try {
        const lookupUrl = candidateUrl;
        if (!lookupUrl) {
          // No URL available to check duplicates against; let the server decide.
        } else {
          const existingGrants = await client.entities.Grant.filter({
            organization_id: orgId,
            url: lookupUrl,
          });
          if (existingGrants.length > 0) {
            if (!silent) {
              toast({ title: 'Already in pipeline', description: `"${opportunity.title}" is already in your pipeline.` });
            }
            return { status: 'already', grant: existingGrants[0] };
          }
        }
      } catch (e) {
        console.warn('Duplicate check failed:', e);
      }
    }

    if (!opportunity.title) {
      if (!silent) {
        toast({ variant: 'destructive', title: 'Invalid opportunity', description: 'The opportunity is missing required information (title).' });
      }
      return { status: 'failed', error: 'missing_title' };
    }
    const applicationUrl = opportunity.application_url ?? opportunity.apply_url ?? null;
    if (!applicationUrl) {
      if (!silent) {
        toast({ variant: 'destructive', title: 'No application link', description: `"${opportunity.title}" has no application URL and cannot be added to the pipeline.` });
      }
      return { status: 'failed', error: 'missing_application_url' };
    }

    try {
      const newGrant = await apiFetch('/api/grants/from-opportunity', {
        method: 'POST',
        body: JSON.stringify({
          opportunity_id: opportunity.id || null,
          profile_id: profileId,
          organization_id: orgId || null,
          // Do NOT forward client-side match_score or match_reasons.
          // The server must re-run relevanceFilter + computeMatchDecision
          // using the authoritative opportunity record and full profile.
          // All scoring, explanation, and audit fields are written server-side.
          opportunity_data: {
            title: opportunity.title,
            sponsor: opportunity.sponsor ?? opportunity.funder,
            deadline: opportunity.deadlineAt ?? opportunity.deadline,
            // application_url is the authoritative Goal 1 field. url is the detail/source page.
            // Both are forwarded explicitly so the server can distinguish them.
            // The server must use application_url as the primary application path.
            application_url: opportunity.application_url ?? null,
            url: opportunity.url ?? null,
            awardMin: opportunity.awardMin ?? opportunity.amount_min,
            awardMax: opportunity.awardMax ?? opportunity.amount_max,
            descriptionMd: opportunity.descriptionMd ?? opportunity.description,
            eligibilityBullets: opportunity.eligibilityBullets ?? [],
            source: opportunity.source ?? 'discovery',
            record_origin:
              opportunity.record_origin ||
              (String(opportunity.source || '').toLowerCase() === 'web_llm' ? 'web_search' : null),
            source_id: opportunity.source_id ?? opportunity.external_id ?? null,
          },
        }),
      });

      if (newGrant.not_added_to_pipeline || newGrant.status === 'skipped') {
        if (!silent) {
          toast({
            title: 'Kept out of this pipeline',
            description: newGrant.message || `"${opportunity.title}" was cataloged but did not pass the profile match gates.`,
          });
        }
        return { status: 'skipped', grant: newGrant, reason: newGrant.reason, gate: newGrant.gate, message: newGrant.message };
      }

      if (newGrant.already_exists) {
        if (!silent) toast({ title: 'Already in pipeline', description: `"${opportunity.title}" is already in your grants pipeline.` });
        return { status: 'already', grant: newGrant };
      }
      if (newGrant.organization_id && newGrant.organization_id !== orgId) {
        queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' });
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
        useAuthStore.getState().refreshProfiles({ reason: 'new-org-from-funding', force: true });
      }
      if (!silent) {
        queryClient.invalidateQueries({ queryKey: ['grants'] });
        toast({ title: 'Added to pipeline', description: `${opportunity.title} has been added to your grants pipeline.` });
      }
      return { status: 'added', grant: newGrant };
    } catch (error) {
      console.error('Failed to add grant to pipeline:', error);
      const errorCode = error?.errorCode ?? error?.error ?? 'unknown_error';
      let userMessage = error?.message ?? 'An unexpected error occurred. Please try again.';
      if (!silent) {
        toast({ variant: 'destructive', title: 'Failed to add grant', description: userMessage });
      }
      return { status: 'failed', error: errorCode, message: userMessage };
    }
  };

  if (!uniqueResults || uniqueResults.length === 0) {
    // Explain the zero-result state using the backend's staged-ladder
    // diagnostics instead of a dead end (Mission System 5, RC-12): what was
    // searched/expanded, and what profile info would unlock more matches.
    const diag = diagnostics || {};
    const gaps = Array.isArray(diag.profileGaps) ? diag.profileGaps : [];
    const gapLabel = (g) =>
      typeof g === 'string' ? g : (g?.label || g?.message || g?.field || g?.section || JSON.stringify(g));
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-2xl mx-auto text-center space-y-6">
          <Search className="w-16 h-16 mx-auto text-muted-foreground" aria-hidden />
          <h2 className="text-2xl font-semibold text-foreground">No verified direct matches yet</h2>
          <p className="text-muted-foreground">
            {diag.tierExplanation
              || 'We searched for funding that fits your profile but did not find verified direct matches yet. Try the steps below.'}
          </p>
          {(diag.directoryOnly || diag.geoExpanded) && (
            <p className="text-xs text-muted-foreground">
              {diag.directoryOnly ? 'Some results are directory/referral resources, not direct grants. ' : ''}
              {diag.geoExpanded ? 'The search was expanded beyond your immediate area to find options.' : ''}
            </p>
          )}
          {gaps.length > 0 && (
            <div className="text-left inline-block">
              <p className="text-sm font-medium text-foreground">
                Add these to your profile to unlock more matches:
              </p>
              <ul className="list-disc list-inside text-sm text-muted-foreground mt-1">
                {gaps.slice(0, 6).map((g, i) => (
                  <li key={i}>{gapLabel(g)}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-3 justify-center">
            <Button asChild>
              <Link to={createPageUrl('DiscoverGrants')}>Run a deeper search</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to={createPageUrl('MyProfiles')}>Improve your profile</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">
            We found {displayedReturned} {displayedReturned === 1 ? 'opportunity' : 'opportunities'}
          </h1>
          <p className="text-muted-foreground mt-1">
            {uniqueResults.length !== filteredAndSorted.length
              ? `Showing ${filteredAndSorted.length} of ${displayedReturned} returned${strongMatchesOnly ? ' (strong matches ≥70%)' : ''}${showHousingOnly ? ' (housing-usable)' : ''}`
              : 'Review and add opportunities to your pipeline'}
          </p>
          {(totalScored !== null || displayedTotalFound > displayedReturned || truncated || thresholdFallbackMessage) && (
            <p className="text-xs text-muted-foreground mt-2">
              {thresholdFallbackMessage || [
                totalScored !== null ? `${totalScored} scored` : null,
                displayedTotalFound > displayedReturned ? `${displayedTotalFound} candidates found` : null,
                truncated ? 'results truncated' : null,
              ].filter(Boolean).join(' · ')}
            </p>
          )}
        </header>

        {/* Filters */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between p-4 bg-muted/30 rounded-lg border">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="strong-only" checked={strongMatchesOnly} onCheckedChange={setStrongMatchesOnly} />
              <Label htmlFor="strong-only" className="text-sm cursor-pointer">Only strong matches (≥70%)</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="housing-only" checked={showHousingOnly} onCheckedChange={setShowHousingOnly} />
              <Label htmlFor="housing-only" className="text-sm cursor-pointer">Show funding usable for housing</Label>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredAndSorted.map((opp, idx) => {
            const oppKey = getOpportunityKey(opp, idx);
            const matchReasons = getMatchReasons(opp);
            const canonical = toCanonicalResult({
              ...opp,
              matched_profile_facts: opp.matched_profile_facts ?? matchReasons,
            });

            return (
              <div key={oppKey} className="flex flex-col bg-white rounded-xl shadow-sm border overflow-hidden">
                <div className="flex-grow p-2">
                  <FundingResultCard
                    result={canonical}
                    className="border-0 shadow-none"
                  />
                </div>

                {(opp.usable_for_housing === true || opp.usable_for_housing === 1) && (
                  <div className="px-4 pt-2">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-xs font-medium text-emerald-700 cursor-help">
                            <Home className="h-3.5 w-3.5" />
                            Can be used for housing
                            <Info className="h-3 w-3 text-emerald-500" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-sm">
                          <p>Funds exceeding tuition may be refunded to cover living expenses such as rent, utilities, and food.</p>
                          {opp.funding_category && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Category: {opp.funding_category.replace(/_/g, ' ')}
                              {(opp.refund_potential === true || opp.refund_potential === 1) && ' · Refund eligible'}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                )}

                {/* Why-it-matched is rendered by FundingResultCard above; keep
                    legacy collapsible only when the canonical card couldn't
                    surface facts (defensive — should not trigger in practice). */}
                {matchReasons.length > 0 && !canonical?.matched_profile_facts?.length && (
                  <div className="px-4 pb-2">
                    <MatchReasonsCollapsible reasons={matchReasons} />
                  </div>
                )}

                <div className="p-4 bg-slate-50 border-t">
                  <AddToPipelineButton
                    opportunity={opp}
                    onAddToPipeline={handleAddToPipeline}
                    organizationName={organizationName ?? 'your profile'}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
