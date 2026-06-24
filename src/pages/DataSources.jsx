import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Combobox from '@/components/shared/Combobox';
import {
  Loader2, Play, CheckCircle, AlertCircle, Database, TrendingUp,
  Building2, Clock, Heart, GraduationCap,
  ShieldCheck, Package, MapPin, Globe, Zap, RefreshCw,
  Gift, ChevronDown, ChevronUp, ExternalLink, X,
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { listProfiles } from '@/api/profiles';
import { runRealCrawler } from '@/api/crawlers';
import { apiFetch } from '@/api/client';
import { createLogger } from '@/utils/logger'

const RAW_CRAWLERS = [
  {
    name: 'Comprehensive',
    crawlerType: 'comprehensive',
    description: 'All-in-one: runs every sub-crawler and merges results into a single ranked list.',
    icon: <Zap className="w-5 h-5" />,
    color: 'purple',
    profileSignals: ['all'],
  },
  {
    name: 'Government Funding',
    crawlerType: 'government_funding',
    description: 'Federal and state grants from Grants.gov, SAM.gov, and state agency portals.',
    icon: <Building2 className="w-5 h-5" />,
    color: 'blue',
    profileSignals: ['financial', 'demographics', 'organization', 'military'],
  },
  {
    name: 'Local Funding',
    crawlerType: 'local_funding',
    description: 'Community foundations, county programs, and local assistance based on your ZIP code.',
    icon: <MapPin className="w-5 h-5" />,
    color: 'emerald',
    profileSignals: ['location', 'financial', 'family', 'assistance'],
  },
  {
    name: 'Student Grants',
    crawlerType: 'student_grants',
    description: 'Scholarships, tuition assistance, and student aid from education-focused sources.',
    icon: <GraduationCap className="w-5 h-5" />,
    color: 'amber',
    profileSignals: ['education', 'demographics', 'financial', 'military'],
  },
  {
    name: 'Health Resources',
    crawlerType: 'health_resources',
    description: 'Patient assistance, disease-specific support, and health benefit programs.',
    icon: <Heart className="w-5 h-5" />,
    color: 'rose',
    profileSignals: ['health', 'assistance', 'financial', 'demographics'],
  },
  {
    name: 'Special Needs',
    crawlerType: 'special_needs',
    description: 'Disability services, adaptive equipment grants, and specialized support programs.',
    icon: <ShieldCheck className="w-5 h-5" />,
    color: 'indigo',
    profileSignals: ['health', 'assistance', 'family', 'financial'],
  },
  {
    name: 'ECF / HCBS Benefits',
    crawlerType: 'ecf_benefits',
    description: 'Employment & Community First CHOICES, Medicaid waivers, and home/community-based services.',
    icon: <Globe className="w-5 h-5" />,
    color: 'teal',
    profileSignals: ['assistance', 'health', 'family', 'financial'],
  },
  {
    name: 'Item Funding',
    crawlerType: 'item_matching',
    description: 'Equipment, technology, and donated goods programs for specific item needs.',
    icon: <Package className="w-5 h-5" />,
    color: 'orange',
    profileSignals: ['financial', 'health', 'assistance', 'organization'],
    requiresItemRequest: true,
  },
];

// Validate the static crawler config to guard against malformed entries
// before they're used in application logic. Only well-formed entries pass.
const CRAWLER_TYPE_RE = /^[a-z0-9_]+$/;
const CRAWLERS = RAW_CRAWLERS.filter((c) => {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.name !== 'string' || !c.name.trim()) return false;
  if (typeof c.crawlerType !== 'string' || !CRAWLER_TYPE_RE.test(c.crawlerType)) return false;
  if (typeof c.description !== 'string') return false;
  if (c.profileSignals && !Array.isArray(c.profileSignals)) return false;
  return true;
});

const COLOR_MAP = {
  purple: { bg: 'bg-purple-50', icon: 'text-purple-500' },
  blue:   { bg: 'bg-blue-50',   icon: 'text-blue-500' },
  emerald:{ bg: 'bg-emerald-50',icon: 'text-emerald-500' },
  amber:  { bg: 'bg-amber-50',  icon: 'text-amber-500' },
  rose:   { bg: 'bg-rose-50',   icon: 'text-rose-500' },
  indigo: { bg: 'bg-indigo-50', icon: 'text-indigo-500' },
  teal:   { bg: 'bg-teal-50',   icon: 'text-teal-500' },
  orange: { bg: 'bg-orange-50', icon: 'text-orange-500' },
  pink:   { bg: 'bg-pink-50',   icon: 'text-pink-500' },
};

// Canonical metric for total opportunities found, used consistently across
// the aggregate, the breakdown list, and the per-crawler tiles.
function foundCount(r) {
  if (!r) return 0;
  return r.total_found ?? r.count ?? 0;
}

function StatCard({ label, value, icon: Icon, colorClass, expanded, onToggle, children }) {
  return (
    <Card
      className={`cursor-pointer transition-all hover:shadow-md ${expanded ? 'ring-2 ring-blue-300 shadow-md' : ''}`}
      onClick={onToggle}
    >
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-500">{label}</div>
            <div className="text-3xl font-bold mt-1 text-slate-900">{value}</div>
          </div>
          <div className="flex items-center gap-1">
            <Icon className={`w-10 h-10 opacity-50 ${colorClass || 'text-slate-400'}`} />
            {expanded
              ? <ChevronUp className="w-4 h-4 text-slate-400" />
              : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </div>
        </div>
        {expanded && children && (
          <div className="mt-4 pt-4 border-t border-slate-100 text-sm text-slate-600">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OpportunityDrawer({ crawlerType, result, onClose }) {
  const label = (typeof crawlerType === 'string' && crawlerType.trim())
    ? crawlerType.replace(/_/g, ' ')
    : 'Crawler';
  const opps = Array.isArray(result?.opportunities) ? result.opportunities.slice(0, 15) : [];
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex justify-end" onClick={onClose}>
      <div className="bg-white w-full max-w-lg h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between z-10">
          <h3 className="font-semibold text-lg capitalize">{label} Results</h3>
          <Button variant="ghost" size="sm" onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>
        <div className="p-4 space-y-3">
          {opps.length === 0 ? (
            <p className="text-center text-sm text-slate-400 py-8">
              No detailed opportunities were returned for this crawler
              {(result?.count ?? 0) > 0 ? ' (only summary counts available).' : '.'}
            </p>
          ) : (
            opps.map((opp, i) => (
              <Card key={opp.id || i} className="border shadow-sm">
                <CardContent className="p-4">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-900 truncate">{opp.title}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{opp.sponsor || 'Unknown sponsor'}</p>
                    </div>
                    {typeof opp.match_score === 'number' && (
                      <Badge variant="outline" className={`shrink-0 ${opp.match_score >= 70 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                        {opp.match_score}%
                      </Badge>
                    )}
                  </div>
                  {opp.description && <p className="text-xs text-slate-600 mt-2 line-clamp-2">{opp.description}</p>}
                  {opp.application_url && (
                    <a href={opp.application_url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-2">
                      <ExternalLink className="w-3 h-3" /> View opportunity
                    </a>
                  )}
                </CardContent>
              </Card>
            ))
          )}
          {(result?.count ?? 0) > 15 && opps.length > 0 && (
            <p className="text-center text-xs text-slate-400 py-2">
              Showing 15 of {result.count} results
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DataSources() {
  const [selectedProfileId, setSelectedProfileId] = useState(null);
  const [runningCrawlers, setRunningCrawlers] = useState(new Set());
  const [crawlerResults, setCrawlerResults] = useState({});
  const [expandedStat, setExpandedStat] = useState(null);
  const [itemRequest, setItemRequest] = useState('');
  const [drawerCrawler, setDrawerCrawler] = useState(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const log = useMemo(() => createLogger('DataSources'), []);

  // Synchronous mirror of running crawlers so the Run All loop never relies
  // on the async React state captured in a memoized callback closure.
  const runningCrawlersRef = useRef(new Set());

  const { data: profiles = [], isLoading: isLoadingProfiles } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => listProfiles(),
    staleTime: 60_000,
  });

  const {
    data: crawlerHealth,
    isError: crawlerHealthError,
    error: crawlerHealthErrorObj,
  } = useQuery({
    queryKey: ['crawlerHealth'],
    // Surface fetch errors instead of swallowing them with .catch(() => null);
    // React Query manages the error state so outages are no longer masked.
    queryFn: () => apiFetch('/api/crawlers/health'),
    staleTime: 30_000,
    retry: 1,
    refetchInterval: runningCrawlers.size > 0 ? 5000 : false,
  });

  useEffect(() => {
    if (!selectedProfileId && profiles.length > 0) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [profiles, selectedProfileId]);

  const profileOptions = useMemo(() => {
    return profiles
      .map((p) => ({ value: p.id, label: p.display_name || p.name || p.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [profiles]);

  const crawlMutation = useMutation({
    mutationFn: async ({ crawlerType, itemReq }) => {
      return runRealCrawler({
        profileId: selectedProfileId,
        crawlerType,
        minMatchScore: 50,
        itemRequest: itemReq || null,
      });
    },
    onMutate: ({ crawlerType }) => {
      runningCrawlersRef.current.add(crawlerType);
      setRunningCrawlers((prev) => new Set(prev).add(crawlerType));
    },
    onSuccess: (data, { crawlerType }) => {
      runningCrawlersRef.current.delete(crawlerType);
      setRunningCrawlers((prev) => {
        const next = new Set(prev);
        next.delete(crawlerType);
        return next;
      });
      setCrawlerResults((prev) => ({ ...prev, [crawlerType]: data }));
      queryClient.invalidateQueries({ queryKey: ['crawlerHealth'] });
      toast({
        title: 'Crawler complete',
        description: `${crawlerType.replace(/_/g, ' ')}: ${data?.count ?? 0} opportunities found.`,
      });
    },
    onError: (error, { crawlerType }) => {
      runningCrawlersRef.current.delete(crawlerType);
      setRunningCrawlers((prev) => {
        const next = new Set(prev);
        next.delete(crawlerType);
        return next;
      });
      setCrawlerResults((prev) => ({
        ...prev,
        [crawlerType]: { error: error.message || 'Unknown error', count: 0 },
      }));
      log.error('Crawler failed', crawlerType, error);
      toast({
        variant: 'destructive',
        title: 'Crawl Failed',
        description: `${crawlerType}: ${error.message || 'An error occurred.'}`,
      });
    },
  });

  const handleRunCrawler = useCallback((crawler) => {
    if (!selectedProfileId) {
      toast({
        variant: 'destructive',
        title: 'Profile Required',
        description: 'Please select a profile before running crawlers.',
      });
      return;
    }
    if (crawler.requiresItemRequest && !itemRequest.trim()) {
      toast({
        variant: 'destructive',
        title: 'Item Description Required',
        description: `${crawler.name} needs an item description (e.g., "wheelchair van", "laptop computers").`,
      });
      return;
    }
    if (runningCrawlersRef.current.has(crawler.crawlerType)) return;
    crawlMutation.mutate({
      crawlerType: crawler.crawlerType,
      itemReq: crawler.requiresItemRequest ? itemRequest.trim() : null,
    });
  }, [selectedProfileId, itemRequest, crawlMutation, toast]);

  const handleRunAll = useCallback(() => {
    if (!selectedProfileId) {
      toast({ variant: 'destructive', title: 'Profile Required', description: 'Select a profile first.' });
      return;
    }
    for (const crawler of CRAWLERS) {
      if (crawler.requiresItemRequest) continue;
      // Use the synchronous ref so crawlers dispatched earlier in this loop
      // (or by a rapid double-click) are correctly skipped.
      if (!runningCrawlersRef.current.has(crawler.crawlerType)) {
        crawlMutation.mutate({ crawlerType: crawler.crawlerType });
      }
    }
  }, [selectedProfileId, crawlMutation, toast]);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);
  const totalFound = Object.values(crawlerResults).reduce((sum, r) => sum + foundCount(r), 0);
  const completedCount = Object.values(crawlerResults).filter((r) => r && !r.error).length;
  const errorCount = Object.values(crawlerResults).filter((r) => r?.error).length;

  if (isLoadingProfiles) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
                <Database className="w-8 h-8 text-blue-600" />
                Data Sources
              </h1>
              <p className="text-slate-600 mt-2">
                Crawl federal, state, and community databases for funding opportunities
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-full md:w-72">
                <Combobox
                  options={profileOptions}
                  value={selectedProfileId || ''}
                  onChange={setSelectedProfileId}
                  placeholder="Select a profile..."
                  isLoading={isLoadingProfiles}
                  className="w-full"
                />
              </div>
              <Button
                onClick={handleRunAll}
                disabled={!selectedProfileId || runningCrawlers.size > 0}
                className="bg-purple-600 hover:bg-purple-700 whitespace-nowrap"
              >
                {runningCrawlers.size > 0 ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running...</>
                ) : (
                  <><RefreshCw className="w-4 h-4 mr-2" /> Run All</>
                )}
              </Button>
            </div>
          </div>

          {selectedProfile && (
            <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-900">
                <strong>Crawling for:</strong>{' '}
                <span className="font-semibold">{selectedProfile.display_name || selectedProfile.id}</span>
                {' '}&mdash; All crawlers use this profile's health, financial, education, and demographic data.
              </p>
            </div>
          )}

          {crawlerHealthError && (
            <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-red-600" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-red-900">Crawler health unavailable</p>
                  <p className="text-xs text-red-700">
                    {crawlerHealthErrorObj?.message || 'Could not reach the crawler health endpoint.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {runningCrawlers.size > 0 && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-amber-600" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-900">
                    {runningCrawlers.size} crawler{runningCrawlers.size > 1 ? 's' : ''} running
                  </p>
                  <p className="text-xs text-amber-700">{Array.from(runningCrawlers).map(s => s.replace(/_/g, ' ')).join(', ')}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Clickable Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <StatCard
            label="Opportunities Found" value={totalFound} icon={Database}
            colorClass="text-blue-400"
            expanded={expandedStat === 'found'}
            onToggle={() => setExpandedStat(expandedStat === 'found' ? null : 'found')}
          >
            {Object.entries(crawlerResults).filter(([, r]) => foundCount(r) > 0).length > 0 ? (
              Object.entries(crawlerResults).filter(([, r]) => foundCount(r) > 0).map(([type, r]) => (
                <div key={type} className="flex justify-between mt-1 cursor-pointer hover:text-blue-600"
                  onClick={(e) => { e.stopPropagation(); setDrawerCrawler(type); }}>
                  <span className="capitalize">{type.replace(/_/g, ' ')}</span>
                  <span className="font-semibold">{foundCount(r)}</span>
                </div>
              ))
            ) : (
              <p>Run crawlers to see results here.</p>
            )}
          </StatCard>

          <StatCard
            label="Active Sources" value={CRAWLERS.length} icon={TrendingUp}
            colorClass="text-emerald-400"
            expanded={expandedStat === 'sources'}
            onToggle={() => setExpandedStat(expandedStat === 'sources' ? null : 'sources')}
          >
            {CRAWLERS.map((c) => {
              const colors = COLOR_MAP[c.color] || COLOR_MAP.blue;
              return (
                <div key={c.crawlerType} className="flex items-center gap-2 mt-1">
                  <span className={colors.icon}>{c.icon}</span>
                  <span>{c.name}</span>
                  {c.profileSignals && (
                    <span className="ml-auto text-xs text-slate-400">
                      {c.profileSignals[0] === 'all' ? 'all signals' : c.profileSignals.slice(0, 2).join(', ')}
                    </span>
                  )}
                </div>
              );
            })}
          </StatCard>

          <StatCard
            label="Completed" value={completedCount} icon={CheckCircle}
            colorClass="text-green-400"
            expanded={expandedStat === 'completed'}
            onToggle={() => setExpandedStat(expandedStat === 'completed' ? null : 'completed')}
          >
            <p>{completedCount} of {CRAWLERS.length} crawlers completed this session.</p>
            {crawlerHealth?.last_24h && (
              <div className="mt-2 space-y-1">
                <p>System (24h): {crawlerHealth.last_24h.completed} completed, {crawlerHealth.last_24h.failed} failed</p>
                {crawlerHealth.last_24h.failure_rate > 20 && (
                  <p className="text-amber-600 font-medium">High failure rate: {crawlerHealth.last_24h.failure_rate}%</p>
                )}
              </div>
            )}
            {crawlerHealth?.worker_online === false && (
              <p className="text-red-600 font-medium mt-1">Worker appears offline</p>
            )}
            {crawlerHealthError && (
              <p className="text-red-600 font-medium mt-1">Health data unavailable.</p>
            )}
          </StatCard>

          <StatCard
            label="Errors" value={errorCount} icon={AlertCircle}
            colorClass={errorCount > 0 ? 'text-red-400' : 'text-slate-400'}
            expanded={expandedStat === 'errors'}
            onToggle={() => setExpandedStat(expandedStat === 'errors' ? null : 'errors')}
          >
            {Object.entries(crawlerResults).filter(([, r]) => r?.error).map(([type, r]) => (
              <div key={type} className="mt-1">
                <span className="font-semibold capitalize">{type.replace(/_/g, ' ')}:</span>{' '}
                <span className="text-red-600">{r.error}</span>
              </div>
            ))}
            {errorCount === 0 && <p>No errors.</p>}
          </StatCard>
        </div>

        {/* Item Request Input */}
        <div className="mb-6">
          <label className="text-sm font-medium text-slate-700 mb-1 block">
            Item request (for Item Funding / Gift crawlers)
          </label>
          <input
            type="text"
            value={itemRequest}
            onChange={(e) => setItemRequest(e.target.value)}
            placeholder='e.g., "15-passenger Ford van", "laptop computers", "wheelchair ramp"'
            className="w-full md:w-96 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-300 focus:border-blue-400 outline-none"
          />
        </div>

        {/* Crawler Grid */}
        {!selectedProfileId ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Profile Selected</h3>
              <p className="text-slate-600">Select a profile above to run profile-aware crawlers.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Funding Sources for {selectedProfile?.display_name || 'Selected Profile'}
            </h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {CRAWLERS.map((crawler) => {
                const colors = COLOR_MAP[crawler.color] || COLOR_MAP.blue;
                const isRunning = runningCrawlers.has(crawler.crawlerType);
                const result = crawlerResults[crawler.crawlerType];
                const hasError = result?.error;
                const hasResult = result && !hasError;

                return (
                  <Card
                    key={crawler.crawlerType}
                    className={`shadow-sm border transition-all ${
                      isRunning ? 'bg-amber-50 border-amber-300' :
                      hasError  ? 'border-red-200' :
                      hasResult ? 'border-green-200' :
                      'border-slate-200 hover:shadow-md'
                    }`}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${colors.bg}`}>
                          <span className={colors.icon}>{crawler.icon}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <CardTitle className="text-lg">{crawler.name}</CardTitle>
                          <CardDescription className="text-xs mt-0.5">{crawler.description}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {crawler.profileSignals && (
                        <div className="flex flex-wrap gap-1">
                          {(crawler.profileSignals[0] === 'all'
                            ? ['health', 'financial', 'education', 'demographics', 'assistance']
                            : crawler.profileSignals.slice(0, 4)
                          ).map((sig) => (
                            <Badge key={sig} variant="outline" className="text-xs py-0 px-1.5">
                              {sig}
                            </Badge>
                          ))}
                        </div>
                      )}

                      {hasResult && (
                        <div
                          className="grid grid-cols-2 gap-3 cursor-pointer"
                          onClick={() => setDrawerCrawler(crawler.crawlerType)}
                        >
                          <div className="bg-slate-50 rounded-lg p-3 text-center hover:bg-slate-100 transition-colors">
                            <p className="text-xs text-slate-500">Found</p>
                            <p className="text-xl font-bold text-slate-900">{foundCount(result)}</p>
                          </div>
                          <div className="bg-emerald-50 rounded-lg p-3 text-center hover:bg-emerald-100 transition-colors">
                            <p className="text-xs text-emerald-600">Returned</p>
                            <p className="text-xl font-bold text-emerald-700">{result.count ?? 0}</p>
                          </div>
                        </div>
                      )}
                      {hasResult && result.duration && (
                        <p className="text-xs text-slate-400">
                          {(result.duration / 1000).toFixed(1)}s
                          {result.used_live && <Badge variant="outline" className="ml-2 text-xs">live</Badge>}
                          {result.used_db_fallback && <Badge variant="outline" className="ml-2 text-xs">+db</Badge>}
                        </p>
                      )}
                      {hasError && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                          <p className="text-xs text-red-700">{result.error}</p>
                        </div>
                      )}
                      {isRunning && (
                        <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-300 w-full justify-center py-1">
                          <Clock className="w-3 h-3 mr-1 animate-pulse" /> Crawling...
                        </Badge>
                      )}
                      <Button
                        onClick={() => handleRunCrawler(crawler)}
                        className="w-full"
                        variant={hasResult ? 'outline' : 'default'}
                        disabled={isRunning}
                        size="sm"
                      >
                        {isRunning ? (
                          <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running...</>
                        ) : hasResult ? (
                          <><RefreshCw className="w-4 h-4 mr-2" /> Re-run</>
                        ) : (
                          <><Play className="w-4 h-4 mr-2" /> Run Crawler</>
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        )}

        {/* Session Results */}
        {Object.keys(crawlerResults).length > 0 && (
          <div className="mt-12">
            <h2 className="text-2xl font-bold text-slate-900 mb-4">Session Results</h2>
            <Card>
              <CardContent className="p-0">
                <div className="divide-y">
                  {Object.entries(crawlerResults).map(([type, result]) => {
                    const hasOpps = Array.isArray(result?.opportunities) && result.opportunities.length > 0;
                    return (
                      <div
                        key={type}
                        className={`p-4 hover:bg-slate-50 transition-colors ${hasOpps ? 'cursor-pointer' : ''}`}
                        onClick={() => hasOpps && setDrawerCrawler(type)}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <p className="font-semibold text-slate-900 capitalize">{type.replace(/_/g, ' ')}</p>
                              <Badge variant="outline" className={result.error ? 'bg-red-50 text-red-700 border-red-200' : 'bg-green-50 text-green-700 border-green-200'}>
                                {result.error ? 'failed' : 'completed'}
                              </Badge>
                            </div>
                            {result.error && <p className="text-sm text-red-600 mt-1">{result.error}</p>}
                            {result.threshold_fallback_message && <p className="text-xs text-amber-600 mt-1">{result.threshold_fallback_message}</p>}
                          </div>
                          <div className="text-right">
                            <p className="text-sm text-slate-500">Found: {foundCount(result)}</p>
                            <p className="text-sm font-semibold text-emerald-600">Returned: {result.count ?? 0}</p>
                            {result.duration && <p className="text-xs text-slate-400">{(result.duration / 1000).toFixed(1)}s</p>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Opportunity Detail Drawer */}
      {drawerCrawler && crawlerResults[drawerCrawler] && (
        <OpportunityDrawer
          crawlerType={drawerCrawler}
          result={crawlerResults[drawerCrawler]}
          onClose={() => setDrawerCrawler(null)}
        />
      )}
    </div>
  );
}
