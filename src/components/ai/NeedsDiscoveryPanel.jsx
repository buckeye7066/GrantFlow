import React, { useCallback, useId, useState } from 'react';
import { apiFetch } from '@/api/client';
import { searchSpecificNeed } from '@/api/crawlers';
import { MODERATE_MATCH_SCORE } from '@/lib/matchDisplayThresholds';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Loader2, Sparkles, Search, ExternalLink, ChevronDown, ChevronUp,
  Package, GraduationCap, Wrench, Car, Heart, Scale, ShoppingCart,
  Monitor, Home, AlertTriangle, CheckCircle2, Clock,
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

const PRIORITY_COLORS = {
  critical: 'bg-red-100 text-red-800 border-red-300',
  high: 'bg-orange-100 text-orange-800 border-orange-300',
  medium: 'bg-blue-100 text-blue-800 border-blue-300',
  low: 'bg-slate-100 text-slate-700 border-slate-300',
};

const FUNDING_PATH_LABELS = {
  donation: { label: 'Can be donated', color: 'bg-green-100 text-green-800', icon: CheckCircle2 },
  grant: { label: 'Grant available', color: 'bg-blue-100 text-blue-800', icon: Sparkles },
  benefit: { label: 'Government benefit', color: 'bg-purple-100 text-purple-800', icon: Scale },
  scholarship: { label: 'Scholarship', color: 'bg-indigo-100 text-indigo-800', icon: GraduationCap },
  self_fund: { label: 'Self-funded', color: 'bg-amber-100 text-amber-800', icon: ShoppingCart },
};

const CATEGORY_ICONS = {
  equipment: Wrench,
  credential: GraduationCap,
  service: Heart,
  technology: Monitor,
  vehicle: Car,
  training: GraduationCap,
  supplies: Package,
  housing: Home,
  medical: Heart,
  legal: Scale,
};

function safeExternalUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function NeedSourceResult({ source }) {
  const sourceUrl = safeExternalUrl(source.url || source.application_url);
  const rawRelevance = source.item_relevance_score;
  const relevance = rawRelevance !== null && rawRelevance !== undefined && rawRelevance !== '' && Number.isFinite(Number(rawRelevance))
    ? Number(rawRelevance)
    : null;
  const content = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className={`truncate text-sm font-medium ${sourceUrl ? 'text-blue-700' : 'text-slate-800'}`}>{source.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{source.description}</p>
        {!sourceUrl ? <p className="mt-1 text-xs font-medium text-amber-700">No usable source link was provided.</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {relevance !== null ? <Badge variant="outline" className="text-[10px]">Item relevance {relevance}%</Badge> : null}
        {sourceUrl ? <ExternalLink className="h-3 w-3 text-slate-400" aria-hidden="true" /> : null}
      </div>
    </div>
  );

  return sourceUrl ? (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg border bg-white p-3 transition hover:border-blue-200 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
      aria-label={`Open source lead: ${source.title} (new tab)`}
    >
      {content}
    </a>
  ) : (
    <div className="rounded-lg border bg-white p-3">{content}</div>
  );
}

function NeedItemCard({ item, profileId, onSearchItem }) {
  const [expanded, setExpanded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [sources, setSources] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const sourcePanelId = `need-sources-${useId()}`;

  const fundingInfo = FUNDING_PATH_LABELS[item.funding_path] || FUNDING_PATH_LABELS.self_fund;
  const FundingIcon = fundingInfo.icon;
  const CategoryIcon = CATEGORY_ICONS[item.category] || Package;

  const handleFindSources = useCallback(async () => {
    if (sources?.length > 0 && !searchError) {
      setExpanded(true);
      return;
    }
    setSearching(true);
    setExpanded(true);
    setSearchError(null);
    try {
      const data = await searchSpecificNeed({
        profileId,
        needText: item.search_terms || item.name,
        minItemRelevance: MODERATE_MATCH_SCORE,
        maxResults: 8,
      });
      setSources(data?.opportunities || []);
    } catch (err) {
      console.error('[NeedsDiscoveryPanel] searchSpecificNeed failed:', err);
      setSources([]);
      setSearchError('The funding-source search could not be completed. Please try again.');
    } finally {
      setSearching(false);
    }
  }, [profileId, item, searchError, sources]);

  return (
    <Card className={`border-l-4 ${item.priority === 'critical' ? 'border-l-red-500' : item.priority === 'high' ? 'border-l-orange-400' : 'border-l-blue-300'}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="mt-1 p-2 rounded-lg bg-slate-100">
            <CategoryIcon className="w-4 h-4 text-slate-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h4 className="font-semibold text-sm text-slate-900">{item.name}</h4>
              <Badge variant="outline" className={`text-[10px] ${PRIORITY_COLORS[item.priority] || ''}`}>
                {item.priority}
              </Badge>
              <Badge className={`text-[10px] ${fundingInfo.color}`}>
                <FundingIcon className="w-3 h-3 mr-1" />
                {fundingInfo.label}
              </Badge>
            </div>
            <p className="text-xs text-slate-600 mb-2">{item.why_needed}</p>
            {item.estimated_cost && (
              <p className="text-xs text-slate-500">Est. cost: <span className="font-medium">{item.estimated_cost}</span></p>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={handleFindSources}
                disabled={searching}
              >
                {searching ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Search className="w-3 h-3" aria-hidden="true" />}
                {searching
                  ? 'Searching…'
                  : sources?.length > 0
                    ? `${sources.length} source${sources.length !== 1 ? 's' : ''} found${sources.length > 5 ? ' (showing 5)' : ''}`
                    : sources === null
                      ? 'Find funding sources'
                      : searchError ? 'Retry source search' : 'Search again'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1"
                onClick={() => onSearchItem(item.search_terms || item.name)}
              >
                <ShoppingCart className="w-3 h-3" /> Search in Item Funding
              </Button>
              {sources !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  onClick={() => setExpanded(!expanded)}
                  aria-label={`${expanded ? 'Hide' : 'Show'} source results for ${item.name}`}
                  aria-expanded={expanded}
                  aria-controls={sourcePanelId}
                >
                  {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
              )}
            </div>

            {expanded && searching && (
              <div role="status" className="mt-3 p-3 bg-slate-50 rounded-lg flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Searching stored sources and the web…
              </div>
            )}

            {expanded && sources && !searching && (
              <div id={sourcePanelId} className="mt-3 space-y-2">
                {searchError ? (
                  <div role="alert" className="p-3 bg-red-50 rounded-lg text-xs text-red-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>Source search failed: {searchError} No missing source is being treated as a zero result.</span>
                  </div>
                ) : sources.length === 0 ? (
                  <div className="p-3 bg-amber-50 rounded-lg text-xs text-amber-700 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>No funding sources found for this specific item. Try broadening the search terms in Item Funding.</span>
                  </div>
                ) : (
                  sources.slice(0, 5).map((source, index) => (
                    <NeedSourceResult key={source.id || source.url || source.application_url || `${source.title}-${index}`} source={source} />
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function NeedsDiscoveryPanel({ profileId, onSearchItem }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [customGoal, setCustomGoal] = useState('');
  const { toast } = useToast();

  const discoverNeeds = useCallback(async () => {
    if (!profileId) {
      toast({ title: 'Select a profile first', variant: 'destructive' });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch('/api/ai/discover-needs', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: profileId,
          custom_goal: customGoal.trim() || undefined,
        }),
      });
      if (data.success && data.result?.items) {
        setResult(data);
      } else {
        setError(data.error || 'Failed to analyze profile needs');
      }
    } catch (err) {
      setError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, [profileId, customGoal, toast]);

  const items = result?.result?.items || [];
  const goalSummary = result?.result?.goal_summary;

  return (
    <Card className="border-2 border-emerald-200 bg-gradient-to-br from-emerald-50/50 to-white">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-emerald-600" />
              AI Needs Discovery
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Suggests possible items, services, and credentials from profile information. Review each suggestion before searching for sources.
            </p>
          </div>
        </div>

        {!result && !loading && (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); discoverNeeds() }}>
            <div className="space-y-2">
              <label htmlFor="needs-custom-goal" className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                Optional: describe a specific goal
              </label>
              <Input
                id="needs-custom-goal"
                placeholder='e.g. "Start a food truck business" or "Regain nursing license"'
                value={customGoal}
                onChange={(e) => setCustomGoal(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              disabled={!profileId}
              className="w-full gap-2 bg-emerald-700 text-white hover:bg-emerald-800"
            >
              <Sparkles className="w-4 h-4" />
              {profileId ? 'Discover What This Profile Needs' : 'Select a Profile First'}
            </Button>
          </form>
        )}

        {loading && (
          <div role="status" className="flex flex-col items-center py-8 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-emerald-600" aria-hidden="true" />
            <p className="text-sm text-slate-600 font-medium">Analyzing profile and identifying needs...</p>
            <p className="text-xs text-slate-400">This takes 10-20 seconds</p>
          </div>
        )}

        {error && (
          <div role="alert" className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />
            <div>
              <p className="font-medium text-red-900 text-sm">Analysis failed</p>
              <p className="text-xs text-red-700 mt-1">{error}</p>
              <Button onClick={discoverNeeds} variant="outline" size="sm" className="mt-2">Retry</Button>
            </div>
          </div>
        )}

        {items.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                {goalSummary && (
                  <p className="text-sm text-slate-700 font-medium">{goalSummary}</p>
                )}
                <p className="text-xs text-slate-500 mt-1">
                  {items.length} items identified
                  {' '}&bull;{' '}
                  {items.filter(i => i.priority === 'critical').length} critical
                  {' '}&bull;{' '}
                  {items.filter(i => ['donation', 'grant', 'benefit'].includes(i.funding_path)).length} marked as non-repayable paths to verify
                </p>
              </div>
              <Button variant="outline" size="sm" className="text-xs gap-1" onClick={() => { setResult(null); setError(null); }}>
                <Clock className="w-3 h-3" /> Re-analyze
              </Button>
            </div>

            {/* Summary bar */}
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-5">
              {Object.entries(FUNDING_PATH_LABELS).map(([key, info]) => {
                const count = items.filter(i => i.funding_path === key).length;
                if (!count) return null;
                const Icon = info.icon;
                return (
                  <div key={key} className={`rounded-lg p-2 text-center ${info.color}`}>
                    <Icon className="w-4 h-4 mx-auto mb-1" />
                    <p className="text-lg font-bold">{count}</p>
                    <p className="text-[10px] leading-tight">{info.label}</p>
                  </div>
                );
              })}
            </div>

            {/* Item list */}
            <div className="space-y-2">
              {items.map((item, idx) => (
                <NeedItemCard
                  key={`${item.name}-${idx}`}
                  item={item}
                  profileId={profileId}
                  onSearchItem={onSearchItem}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
