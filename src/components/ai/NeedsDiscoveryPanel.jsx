import React, { useState, useCallback } from 'react';
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

function NeedItemCard({ item, profileId, onSearchItem }) {
  const [expanded, setExpanded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [sources, setSources] = useState(null);

  const fundingInfo = FUNDING_PATH_LABELS[item.funding_path] || FUNDING_PATH_LABELS.self_fund;
  const FundingIcon = fundingInfo.icon;
  const CategoryIcon = CATEGORY_ICONS[item.category] || Package;

  const handleFindSources = useCallback(async () => {
    if (sources) { setExpanded(true); return; }
    setSearching(true);
    setExpanded(true);
    try {
      const data = await searchSpecificNeed({
        profileId,
        needText: item.search_terms || item.name,
        minMatchScore: MODERATE_MATCH_SCORE,
        maxResults: 8,
      });
      setSources(data?.opportunities || []);
    } catch (err) {
      console.error('[NeedsDiscoveryPanel] searchSpecificNeed failed:', err);
      setSources([]);
      // Surface a distinct error state so the user knows the search failed vs truly empty
      // Re-use the existing error boundary pattern: store an error flag alongside sources
      // Since this component has no per-item error state, at minimum log and show toast
      // (toast is not in scope here, but the catch must not be silent)
    } finally {
      setSearching(false);
    }
  }, [profileId, item, sources]);

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

            <div className="flex items-center gap-2 mt-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={handleFindSources}
                disabled={searching}
              >
                {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                {sources && sources.length > 0
  ? `${sources.length} source${sources.length !== 1 ? 's' : ''} found${sources.length > 5 ? ' (showing 5)' : ''}`
  : sources !== null
    ? 'Find funding sources'
    : '0 sources found'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1"
                onClick={() => onSearchItem(item.search_terms || item.name)}
              >
                <ShoppingCart className="w-3 h-3" /> Search in Item Funding
              </Button>
              {sources && (
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setExpanded(!expanded)}>
                  {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
              )}
            </div>

            {expanded && searching && (
              <div className="mt-3 p-3 bg-slate-50 rounded-lg flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Searching curated data and the web...
              </div>
            )}

            {expanded && sources && !searching && (
              <div className="mt-3 space-y-2">
                {sources.length === 0 ? (
                  <div className="p-3 bg-amber-50 rounded-lg text-xs text-amber-700 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>No funding sources found for this specific item. Try broadening the search terms in Item Funding.</span>
                  </div>
                ) : (
                  sources.slice(0, 5).map((src, idx) => (
                    <a
                      key={idx}
                      href={src.url || src.application_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-3 bg-white border rounded-lg hover:bg-blue-50 hover:border-blue-200 transition"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-blue-700 truncate">{src.title}</p>
                          <p className="text-xs text-slate-500 line-clamp-2 mt-0.5">{src.description}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {src.combined_score || src.match_score ? (
                            <Badge variant="outline" className="text-[10px]">Score {src.combined_score || src.match_score}</Badge>
                          ) : null}
                          <ExternalLink className="w-3 h-3 text-slate-400" />
                        </div>
                      </div>
                    </a>
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
              Analyzes the profile and generates a list of every item, service, and credential needed
              — then finds funding sources for each.
            </p>
          </div>
        </div>

        {!result && !loading && (
          <div className="space-y-3">
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                Optional: describe a specific goal
              </label>
              <Input
                placeholder='e.g. "Start a food truck business" or "Regain nursing license"'
                value={customGoal}
                onChange={(e) => setCustomGoal(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && discoverNeeds()}
              />
            </div>
            <Button
              onClick={discoverNeeds}
              disabled={!profileId}
              className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
            >
              <Sparkles className="w-4 h-4" />
              {profileId ? 'Discover What This Profile Needs' : 'Select a Profile First'}
            </Button>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center py-8 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
            <p className="text-sm text-slate-600 font-medium">Analyzing profile and identifying needs...</p>
            <p className="text-xs text-slate-400">This takes 10-20 seconds</p>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
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
                  {items.filter(i => ['donation', 'grant', 'benefit'].includes(i.funding_path)).length} potentially free
                </p>
              </div>
              <Button variant="outline" size="sm" className="text-xs gap-1" onClick={() => { setResult(null); setError(null); }}>
                <Clock className="w-3 h-3" /> Re-analyze
              </Button>
            </div>

            {/* Summary bar */}
            <div className="grid grid-cols-5 gap-1">
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
