import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { apiFetch } from '@/api/client';
import { useFundingResultsStore } from '@/stores/fundingResultsStore';
import { useAuthStore } from '@/stores/authStore';
import { createPageUrl } from '@/utils';
import GrantCard from '@/components/pipeline/GrantCard';
import { AddToPipelineButton } from '@/components/discovery/SearchResults';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Search, ChevronRight } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { createLogger } from '@/utils/logger';

const SORT_OPTIONS = [
  { value: 'match', label: 'Match score' },
  { value: 'deadline', label: 'Deadline' },
  { value: 'amount', label: 'Amount' },
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
  const reasons = opp?.match_reasons ?? opp?.matchReasons ?? opp?.matched_fields ?? [];
  return Array.isArray(reasons) ? reasons : [];
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
          {reasons.map((r, i) => (
            <li key={i}>{typeof r === 'string' ? r : JSON.stringify(r)}</li>
          ))}
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
  const { results, profileId, organizationName, organizationId } = useFundingResultsStore();
  const { isAuthenticated, accessToken, sessionExpired } = useAuthStore((s) => ({
    isAuthenticated: s.isAuthenticated,
    accessToken: s.accessToken,
    sessionExpired: s.sessionExpired,
  }));

  const [sortBy, setSortBy] = useState('match');
  const [strongMatchesOnly, setStrongMatchesOnly] = useState(false);

  const tokenAvailable = useMemo(() => {
    try {
      return Boolean(accessToken || base44.getToken?.());
    } catch {
      return Boolean(accessToken);
    }
  }, [accessToken]);
  const authReady = !sessionExpired && (isAuthenticated || tokenAvailable);

  const filteredAndSorted = useMemo(() => {
    let list = [...(results || [])];
    if (strongMatchesOnly) {
      list = list.filter((o) => (Number(o?.match_score ?? o?.match ?? 0) >= 70));
    }
    if (sortBy === 'match') {
      list.sort((a, b) => (Number(b?.match_score ?? b?.match ?? 0) - Number(a?.match_score ?? a?.match ?? 0)));
    } else if (sortBy === 'deadline') {
      list.sort((a, b) => {
        const da = parseDeadline(a) ?? Infinity;
        const db = parseDeadline(b) ?? Infinity;
        return da - db;
      });
    } else if (sortBy === 'amount') {
      list.sort((a, b) => parseAmount(b) - parseAmount(a));
    }
    return list;
  }, [results, sortBy, strongMatchesOnly]);

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
    if (orgId && opportunity.url) {
      try {
        const existingGrants = await base44.entities.Grant.filter({
          organization_id: orgId,
          url: opportunity.url,
        });
        if (existingGrants.length > 0) {
          if (!silent) {
            toast({ title: 'Already in pipeline', description: `"${opportunity.title}" is already in your pipeline.` });
          }
          return { status: 'already', grant: existingGrants[0] };
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

    const reasons = getMatchReasons(opportunity);
    try {
      const newGrant = await apiFetch('/api/grants/from-opportunity', {
        method: 'POST',
        body: JSON.stringify({
          opportunity_id: opportunity.id || null,
          profile_id: profileId,
          organization_id: orgId || null,
          match_score: opportunity.match ?? opportunity.match_score,
          match_reasons: reasons,
          opportunity_data: {
            title: opportunity.title,
            sponsor: opportunity.sponsor ?? opportunity.funder,
            deadline: opportunity.deadlineAt ?? opportunity.deadline,
            url: opportunity.url ?? opportunity.application_url,
            awardMin: opportunity.awardMin ?? opportunity.amount_min,
            awardMax: opportunity.awardMax ?? opportunity.amount_max,
            descriptionMd: opportunity.descriptionMd ?? opportunity.description,
            eligibilityBullets: opportunity.eligibilityBullets ?? [],
            source: opportunity.source ?? 'discovery',
          },
        }),
      });

      if (newGrant.already_exists) {
        if (!silent) toast({ title: 'Already in pipeline', description: `"${opportunity.title}" is already in your grants pipeline.` });
        return { status: 'already', grant: newGrant };
      }
      if (newGrant.organization_id && newGrant.organization_id !== orgId) {
        queryClient.invalidateQueries({ queryKey: ['profiles'] });
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
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

  if (!results || results.length === 0) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-2xl mx-auto text-center space-y-6">
          <Search className="w-16 h-16 mx-auto text-muted-foreground" aria-hidden />
          <h2 className="text-2xl font-semibold text-foreground">No matches yet</h2>
          <p className="text-muted-foreground">
            Try lowering the match score or add ZIP/state to your profile for better results.
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <Button asChild>
              <Link to={createPageUrl('DiscoverGrants')}>Run a new search</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to={createPageUrl('MyProfiles')}>Edit profile</Link>
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
          <h1 className="text-2xl font-bold text-foreground">We found {filteredAndSorted.length} opportunities</h1>
          <p className="text-muted-foreground mt-1">
            {results.length !== filteredAndSorted.length && strongMatchesOnly
              ? `Showing ${filteredAndSorted.length} strong matches (≥70%) of ${results.length} total`
              : 'Review and add opportunities to your pipeline'}
          </p>
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
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredAndSorted.map((opp, idx) => {
            const oppKey = getOpportunityKey(opp, idx);
            const matchReasons = getMatchReasons(opp);
            const oppForCard = { ...opp, matchReasons: matchReasons };

            return (
              <div key={oppKey} className="flex flex-col bg-white rounded-xl shadow-sm border overflow-hidden">
                <div className="flex-grow">
                  <GrantCard grant={oppForCard} organizationName={organizationName} showSummary={true} />
                </div>

                {matchReasons.length > 0 && (
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
