import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { runRealCrawler } from '@/api/crawlers';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Loader2, Play, CheckCircle, AlertCircle, Database, TrendingUp, Building2, Clock, ExternalLink, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { format } from 'date-fns';
import { useCrawlJobTracker } from '@/hooks/useCrawlJobTracker'
import { createLogger } from '@/utils/logger'

const PROFILE_SIGNAL_TAGS = {
  comprehensive: ['health', 'financial', 'education', 'demographics', 'military'],
  government_funding: ['government', 'organization', 'financial'],
  local_funding: ['financial', 'family', 'demographics'],
  student_grants: ['education', 'financial', 'demographics'],
  health_resources: ['health', 'family', 'government'],
  special_needs: ['health', 'family', 'demographics'],
  ecf_benefits: ['health', 'government', 'family'],
  item_matching: ['financial', 'health', 'family'],
}

export default function DataSources() {
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [crawlingInBackground, setCrawlingInBackground] = useState([]);
  const [expandedStat, setExpandedStat] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerResults, setDrawerResults] = useState([]);
  const [drawerTitle, setDrawerTitle] = useState('');
  const [itemRequests, setItemRequests] = useState({});
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const log = React.useMemo(() => createLogger('DataSourcesPage'), [])
  const tracker = useCrawlJobTracker({ pollMs: 5000 })

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('name'),
  });

  const { data: crawlLogs = [], isLoading: isLoadingLogs } = useQuery({
    queryKey: ['crawlLogs'],
    queryFn: () => base44.entities.CrawlLog.list('-created_date', 50),
    refetchInterval: crawlingInBackground.length > 0 ? 5000 : false,
  });

  const { data: opportunities = [], isLoading: isLoadingOpportunities } = useQuery({
    queryKey: ['fundingOpportunities'],
    queryFn: () => base44.entities.FundingOpportunity.list('-created_date', 100),
  });

  function normalizeLogSource(name) {
    return String(name || '').toLowerCase().replace(/\./g, '_')
  }

  useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      setSelectedOrgId(organizations[0].id);
    }
  }, [organizations, selectedOrgId]);

  const crawlers = [
    {
      name: 'Grants.gov',
      function: 'crawlGrantsGov',
      crawlerType: 'government_funding',
      logSource: 'grants_gov',
      description: 'Federal grants database — comprehensive government funding',
      icon: '🏛️',
      needsProfile: false,
    },
    {
      name: 'Benefits.gov',
      function: 'crawlBenefitsGov',
      crawlerType: 'comprehensive',
      logSource: 'benefits_gov',
      description: 'Government benefits and assistance programs',
      icon: '🏥',
      needsProfile: true,
    },
    {
      name: 'Health Resources',
      function: 'crawlHealthResources',
      crawlerType: 'health_resources',
      logSource: 'health_resources',
      description: 'Health-related grants, patient assistance, and medical funding',
      icon: '💊',
      needsProfile: true,
    },
    {
      name: 'Special Needs',
      function: 'crawlSpecialNeeds',
      crawlerType: 'special_needs',
      logSource: 'special_needs',
      description: 'Disability, special education, and accessibility funding',
      icon: '♿',
      needsProfile: true,
    },
    {
      name: 'Student Grants',
      function: 'crawlStudentGrants',
      crawlerType: 'student_grants',
      logSource: 'student_grants',
      description: 'Scholarships, FAFSA-linked aid, and campus-based funding',
      icon: '🎓',
      needsProfile: true,
    },
    {
      name: 'ECF Benefits',
      function: 'crawlEcfBenefits',
      crawlerType: 'ecf_benefits',
      logSource: 'ecf_benefits',
      description: 'Emergency Connectivity Fund and digital access programs',
      icon: '📡',
      needsProfile: true,
    },
    {
      name: 'Local Funding',
      function: 'crawlLocalFunding',
      crawlerType: 'local_funding',
      logSource: 'local_funding',
      description: 'Community foundations, local nonprofits, and regional grants',
      icon: '📍',
      needsProfile: true,
    },
    {
      name: 'Item Funding',
      function: 'crawlItemFunding',
      crawlerType: 'item_matching',
      logSource: 'item_matching',
      description: 'Funding for specific requested items (vehicles, equipment, etc.)',
      icon: '🛒',
      needsProfile: true,
      hasItemInput: true,
    },
  ];

  const getLatestLog = (crawler) => {
    const src = crawler?.logSource ? String(crawler.logSource) : normalizeLogSource(crawler?.name)
    return crawlLogs.find((log) => String(log?.source || '') === src);
  };

  const handleRunCrawler = async (crawler) => {
    if (!selectedOrgId && crawler.needsProfile) {
      toast({
        variant: "destructive",
        title: "Profile Required",
        description: "Please select a profile before running this crawler.",
      });
      return;
    }

    const jobKey = String(crawler.function)
    setCrawlingInBackground(prev => [...prev, jobKey]);

    try {
      const data = await runRealCrawler({
        profileId: selectedOrgId || 'default',
        crawlerType: crawler.crawlerType,
        minMatchScore: 0,
        itemRequest: crawler.hasItemInput ? (itemRequests[crawler.function] || null) : null,
      })

      toast({
        title: '🚀 Crawler Complete',
        description: `${crawler.name}: found ${data?.opportunities?.length ?? 0} results.`,
        duration: 4000,
      });

      if (data?.opportunities?.length > 0) {
        setDrawerTitle(crawler.name)
        setDrawerResults(data.opportunities)
        setDrawerOpen(true)
      }

      queryClient.invalidateQueries({ queryKey: ['crawlLogs'] })
      queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] })
    } catch (err) {
      log.error('crawler failed', crawler.function, err)
      toast({
        variant: "destructive",
        title: "Crawl Failed",
        description: err.message || "An error occurred while running the crawler.",
      });
    } finally {
      setCrawlingInBackground(prev => prev.filter(name => name !== jobKey));
    }
  };

  const selectedOrg = organizations.find(o => o.id === selectedOrgId);

  const statCards = [
    {
      id: 'total',
      label: 'Total Opportunities',
      value: opportunities.length,
      icon: Database,
      color: 'text-blue-500',
      valueColor: 'text-slate-900',
      detail: () => {
        const bySource = {}
        for (const opp of opportunities) {
          const s = opp.source || 'unknown'
          bySource[s] = (bySource[s] || 0) + 1
        }
        return Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ')
      }
    },
    {
      id: 'crawlers',
      label: 'Available Crawlers',
      value: crawlers.length,
      icon: TrendingUp,
      color: 'text-emerald-500',
      valueColor: 'text-emerald-600',
      detail: () => crawlers.map(c => `${c.icon} ${c.name}`).join(', ')
    },
    {
      id: 'completed',
      label: 'Successful Crawls',
      value: crawlLogs.filter(log => log.status === 'completed').length,
      icon: CheckCircle,
      color: 'text-green-500',
      valueColor: 'text-green-600',
      detail: () => {
        const completed = crawlLogs.filter(l => l.status === 'completed')
        const bySource = {}
        for (const l of completed) {
          const s = l.source || 'unknown'
          bySource[s] = (bySource[s] || 0) + 1
        }
        return Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ')
      }
    },
    {
      id: 'errors',
      label: 'Recent Errors',
      value: crawlLogs.filter(log => log.status === 'failed').length,
      icon: AlertCircle,
      color: 'text-red-500',
      valueColor: 'text-red-600',
      detail: () => {
        const failed = crawlLogs.filter(l => l.status === 'failed')
        return failed.slice(0, 5).map(l => `${l.source}: ${l.errorMessage || 'unknown'}`).join('; ') || 'No recent errors'
      }
    },
  ]

  if (isLoadingOrgs || isLoadingLogs || isLoadingOpportunities) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
                <Database className="w-8 h-8 text-blue-600" />
                Data Sources
              </h1>
              <p className="text-slate-600 mt-2">
                Crawl federal databases and benefit programs for opportunities
              </p>
            </div>

            <div className="w-full md:w-80">
              <Select value={selectedOrgId || ""} onValueChange={setSelectedOrgId}>
                <SelectTrigger>
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-slate-500" />
                    <SelectValue placeholder="Select a profile..." />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {organizations.map(org => (
                    <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {selectedOrg && (
            <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-900">
                <strong>🎯 Crawling for:</strong>{' '}
                <span className="font-semibold">{selectedOrg.name}</span>
                {selectedOrg.applicant_type && (
                  <span className="ml-2 text-xs">
                    ({selectedOrg.applicant_type.replace(/_/g, ' ')})
                  </span>
                )}
                {' '}— Profile-aware crawlers will search for opportunities relevant to this profile.
              </p>
            </div>
          )}

          {crawlingInBackground.length > 0 && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-amber-600" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-900">
                    {crawlingInBackground.length} crawler{crawlingInBackground.length > 1 ? 's' : ''} running
                  </p>
                  <p className="text-xs text-amber-700">
                    Results will appear when complete.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Clickable Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          {statCards.map(stat => {
            const Icon = stat.icon
            const isExpanded = expandedStat === stat.id
            return (
              <Card
                key={stat.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setExpandedStat(isExpanded ? null : stat.id)}
              >
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-slate-500">{stat.label}</div>
                      <div className={`text-3xl font-bold mt-1 ${stat.valueColor}`}>
                        {stat.value}
                      </div>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <Icon className={`w-10 h-10 opacity-50 ${stat.color}`} />
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-slate-400" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-slate-400" />
                      )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t text-xs text-slate-600 leading-relaxed">
                      {stat.detail()}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>

        {!selectedOrgId ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Profile Selected</h3>
              <p className="text-slate-600">
                Please select a profile from the dropdown above to run profile-aware crawlers.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Data Sources for {selectedOrg?.name}
            </h2>

            <div className="grid md:grid-cols-2 gap-6">
              {crawlers.map(crawler => {
                const latestLog = getLatestLog(crawler);
                const isCrawling = crawlingInBackground.includes(crawler.function);
                const signalTags = PROFILE_SIGNAL_TAGS[crawler.crawlerType] || []

                return (
                  <Card key={crawler.name} className={`shadow-lg border-0 ${isCrawling ? 'bg-amber-50 border-amber-200 border-2' : ''}`}>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="flex items-center gap-2 text-xl">
                            <span className="text-2xl">{crawler.icon}</span>
                            {crawler.name}
                            {crawler.needsProfile && (
                              <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                                profile-aware
                              </Badge>
                            )}
                            {isCrawling && (
                              <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-300">
                                <Clock className="w-3 h-3 mr-1 animate-pulse" />
                                crawling...
                              </Badge>
                            )}
                          </CardTitle>
                          <CardDescription className="mt-2">{crawler.description}</CardDescription>
                          {signalTags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {signalTags.map(tag => (
                                <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        {latestLog?.status === 'completed' && !isCrawling && (
                          <Badge className="bg-green-100 text-green-700 border-green-200">
                            <CheckCircle className="w-3 h-3 mr-1" />
                            completed
                          </Badge>
                        )}
                        {latestLog?.status === 'failed' && !isCrawling && (
                          <Badge variant="destructive">
                            <AlertCircle className="w-3 h-3 mr-1" />
                            failed
                          </Badge>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div
                          className="cursor-pointer hover:bg-slate-50 rounded-lg p-2 -m-2 transition-colors"
                          onClick={() => {
                            if (latestLog?.recordsFound > 0) {
                              setDrawerTitle(`${crawler.name} — Found`)
                              setDrawerResults([])
                              setDrawerOpen(true)
                            }
                          }}
                        >
                          <p className="text-sm text-slate-500">Records Found</p>
                          <p className="text-2xl font-bold text-slate-900">
                            {latestLog?.recordsFound || 0}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-slate-500">Records Added</p>
                          <p className="text-2xl font-bold text-emerald-600">
                            {latestLog?.recordsAdded || 0}
                          </p>
                        </div>
                      </div>

                      {latestLog?.created_date && (
                        <p className="text-xs text-slate-500">
                          Last crawled: {format(new Date(latestLog.created_date), 'MMM d, yyyy h:mm a')}
                        </p>
                      )}

                      {latestLog?.errorMessage && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                          <p className="text-xs text-red-700">{latestLog.errorMessage}</p>
                        </div>
                      )}

                      {crawler.hasItemInput && (
                        <Input
                          placeholder="What item do you need? (e.g., wheelchair van)"
                          value={itemRequests[crawler.function] || ''}
                          onChange={(e) => setItemRequests(prev => ({ ...prev, [crawler.function]: e.target.value }))}
                          className="text-sm"
                        />
                      )}

                      <Button
                        onClick={() => handleRunCrawler(crawler)}
                        className="w-full bg-blue-600 hover:bg-blue-700"
                        disabled={isCrawling || (crawler.hasItemInput && !itemRequests[crawler.function])}
                      >
                        {isCrawling ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Running...
                          </>
                        ) : (
                          <>
                            <Play className="w-4 h-4 mr-2" />
                            Run Crawler
                          </>
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        )}

        {/* Recent Crawl Activity */}
        <div className="mt-12">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Recent Crawl Activity</h2>
          <Card>
            <CardContent className="p-0">
              {crawlLogs.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <AlertCircle className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No crawl activity yet.</p>
                </div>
              ) : (
                <div className="divide-y">
                  {crawlLogs.slice(0, 10).map(log => (
                    <div key={log.id} className="p-4 hover:bg-slate-50 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="font-semibold text-slate-900">
                              {log.source.replace(/_/g, '.')}
                            </p>
                            <Badge
                              variant="outline"
                              className={
                                log.status === 'completed'
                                  ? 'bg-green-50 text-green-700 border-green-200'
                                  : log.status === 'failed'
                                  ? 'bg-red-50 text-red-700 border-red-200'
                                  : 'bg-slate-50 text-slate-700 border-slate-200'
                              }
                            >
                              {log.status}
                            </Badge>
                          </div>
                          <p className="text-sm text-slate-600">
                            {log.created_date && format(new Date(log.created_date), 'MMM d, yyyy h:mm a')}
                          </p>
                          {log.errorMessage && (
                            <p className="text-sm text-red-600 mt-2">
                              Error: {log.errorMessage}
                            </p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-slate-500">Found: {log.recordsFound || 0}</p>
                          <p className="text-sm font-semibold text-emerald-600">
                            Added: {log.recordsAdded || 0}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Results Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{drawerTitle}</SheetTitle>
            <SheetDescription>
              {drawerResults.length} opportunity{drawerResults.length !== 1 ? 'ies' : 'y'} found
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            {drawerResults.length === 0 && (
              <p className="text-sm text-slate-500 text-center py-8">
                No detailed results available for this view.
              </p>
            )}
            {drawerResults.map((opp, i) => (
              <Card key={opp.id || opp.source_url || i} className="border">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-semibold text-sm text-slate-900 leading-tight">
                      {opp.title || 'Untitled'}
                    </h4>
                    {opp.match_score != null && (
                      <Badge variant={opp.match_score >= 70 ? 'default' : 'secondary'} className="shrink-0">
                        {Math.round(opp.match_score)}%
                      </Badge>
                    )}
                  </div>
                  {opp.sponsor && (
                    <p className="text-xs text-slate-500">{opp.sponsor}</p>
                  )}
                  {opp.description && (
                    <p className="text-xs text-slate-600 line-clamp-3">{opp.description}</p>
                  )}
                  {(opp.application_url || opp.source_url || opp.url) && (
                    <a
                      href={opp.application_url || opp.source_url || opp.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Apply / Learn more
                    </a>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
