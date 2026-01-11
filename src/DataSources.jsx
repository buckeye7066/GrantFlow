import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Combobox from '@/components/shared/Combobox';
import { Loader2, Play, CheckCircle, AlertCircle, Database, TrendingUp, Building2, Clock } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { format } from 'date-fns';

export default function DataSources() {
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [crawlingInBackground, setCrawlingInBackground] = useState([]);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('name'),
  });

  const { data: crawlLogs = [], isLoading: isLoadingLogs } = useQuery({
    queryKey: ['crawlLogs'],
    queryFn: () => base44.entities.CrawlLog.list('-created_date', 50),
  });

  const { data: opportunities = [], isLoading: isLoadingOpportunities } = useQuery({
    queryKey: ['fundingOpportunities'],
    queryFn: () => base44.entities.FundingOpportunity.list('-created_date', 100),
  });

  // Auto-refresh every 10 seconds if there are background crawls
  useEffect(() => {
    if (crawlingInBackground.length > 0) {
      const interval = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ['crawlLogs'] });
        queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] });
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [crawlingInBackground, queryClient]);

  // Auto-select first organization if none selected
  useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      setSelectedOrgId(organizations[0].id);
    }
  }, [organizations, selectedOrgId]);

  const organizationOptions = React.useMemo(() => {
    return organizations
      .map((org) => ({
        value: org.id,
        label: org.name || org.display_name || org.id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [organizations]);

  const crawlMutation = useMutation({
    mutationFn: async ({ crawlerName, payload }) => {
      // TODO: Remove debug log - console.log(`[DataSources] Starting ${crawlerName} with payload:`, payload);
      
      // Fire and forget - don't wait for response
      base44.functions.invoke(crawlerName, payload).catch(err => {
        console.error(`Background crawl error for ${crawlerName}:`, err);
      });
      
      return { crawlerName };
    },
    onSuccess: (data) => {
      setCrawlingInBackground(prev => [...prev, data.crawlerName]);
      toast({
        title: '🚀 Crawler Started',
        description: `${data.crawlerName} is running in the background. Check back in 1-2 minutes.`,
        duration: 4000,
      });

      // Remove from background list after 2 minutes and refresh
      setTimeout(() => {
        setCrawlingInBackground(prev => prev.filter(name => name !== data.crawlerName));
        queryClient.invalidateQueries({ queryKey: ['crawlLogs'] });
        queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] });
        toast({
          title: '✅ Crawler Complete',
          description: 'Check the results below!',
        });
      }, 120000);
    },
    onError: (error, variables) => {
      toast({
        variant: "destructive",
        title: "Crawl Failed",
        description: error.message || "An error occurred while starting the crawler.",
      });
    },
  });

  const crawlers = [
    {
      name: 'Grants.gov',
      function: 'crawlGrantsGov',
      description: 'Federal grants database - comprehensive government funding',
      icon: '🏛️',
      needsProfile: false,
    },
    {
      name: 'Benefits.gov',
      function: 'crawlBenefitsGov',
      description: 'Government benefits and assistance programs',
      icon: '🏥',
      needsProfile: true,
    },
  ];

  const getLatestLog = (source) => {
    return crawlLogs.find(log => log.source === source.toLowerCase().replace('.', '_'));
  };

  const handleRunCrawler = (crawler) => {
    if (!selectedOrgId && crawler.needsProfile) {
      toast({
        variant: "destructive",
        title: "Profile Required",
        description: "Please select a profile before running this crawler.",
      });
      return;
    }

    const payload = {};
    
    // Add organization_id for crawlers that need profile context
    if (crawler.needsProfile && selectedOrgId) {
      payload.organization_id = selectedOrgId;
      // TODO: Remove debug log - console.log(`[DataSources] Running ${crawler.function} with profile:`, selectedOrgId);
    }

    crawlMutation.mutate({ 
      crawlerName: crawler.function,
      payload 
    });
  };

  const selectedOrg = organizations.find(o => o.id === selectedOrgId);

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
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-slate-500" />
                <Combobox
                  options={organizationOptions}
                  value={selectedOrgId || ""}
                  onChange={setSelectedOrgId}
                  placeholder="Select a profile..."
                  isLoading={isLoadingOrgs}
                  className="w-full"
                />
              </div>
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
                    {crawlingInBackground.length} crawler{crawlingInBackground.length > 1 ? 's' : ''} running in background
                  </p>
                  <p className="text-xs text-amber-700">
                    Page will auto-refresh every 10 seconds. Continue working!
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-slate-500">Total Opportunities</div>
                  <div className="text-3xl font-bold text-slate-900 mt-1">
                    {opportunities.length}
                  </div>
                </div>
                <Database className="w-10 h-10 text-blue-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-slate-500">Available Crawlers</div>
                  <div className="text-3xl font-bold text-emerald-600 mt-1">
                    {crawlers.length}
                  </div>
                </div>
                <TrendingUp className="w-10 h-10 text-emerald-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-slate-500">Successful Crawls</div>
                  <div className="text-3xl font-bold text-green-600 mt-1">
                    {crawlLogs.filter(log => log.status === 'completed').length}
                  </div>
                </div>
                <CheckCircle className="w-10 h-10 text-green-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-slate-500">Recent Errors</div>
                  <div className="text-3xl font-bold text-red-600 mt-1">
                    {crawlLogs.filter(log => log.status === 'failed').length}
                  </div>
                </div>
                <AlertCircle className="w-10 h-10 text-red-500 opacity-50" />
              </div>
            </CardContent>
          </Card>
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
              Data Sources for {selectedOrg.name}
            </h2>

            <div className="grid md:grid-cols-2 gap-6">
              {crawlers.map(crawler => {
                const latestLog = getLatestLog(crawler.name);
                const isCrawling = crawlingInBackground.includes(crawler.function);

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
                        <div>
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

                      <Button
                        onClick={() => handleRunCrawler(crawler)}
                        className="w-full bg-blue-600 hover:bg-blue-700"
                        disabled={isCrawling}
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
    </div>
  );
}