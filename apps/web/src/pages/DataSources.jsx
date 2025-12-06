import React, { useMemo, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuthContext } from '@/components/hooks/useAuthRLS';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Database, Building2 } from 'lucide-react';

// Custom hook
import { useCrawlManager } from '@/components/hooks/useCrawlManager';

// Components
import ProfileSelector from '@/components/datasources/ProfileSelector';
import CrawlStats from '@/components/datasources/CrawlStats';
import CrawlerCard from '@/components/datasources/CrawlerCard';
import RecentCrawlActivity from '@/components/datasources/RecentCrawlActivity';

// Crawler definitions - dynamic based on profile type
const BASE_CRAWLERS = [
  {
    name: 'Grants.gov',
    function: 'crawlGrantsGov',
    description: 'Federal grants database - comprehensive government funding',
    icon: '🏛️',
    needsProfile: false,
    profileTypes: ['all'],
  },
  {
    name: 'Benefits.gov',
    function: 'crawlBenefitsGov',
    description: 'Government benefits and assistance programs',
    icon: '🏥',
    needsProfile: true,
    profileTypes: ['all'],
  },
  {
    name: 'Local Sources',
    function: 'discoverLocalSources',
    description: 'Community foundations, local grants, regional funding',
    icon: '📍',
    needsProfile: true,
    profileTypes: ['all'],
  },
  {
    name: 'University Scholarships',
    function: 'crawlUniversityScholarships',
    description: 'College and university scholarship opportunities',
    icon: '🎓',
    needsProfile: true,
    profileTypes: ['high_school_student', 'college_student', 'graduate_student', 'homeschool_family'],
  },
];

// Helper to get applicable crawlers for a profile
const getCrawlersForProfile = (org) => {
  if (!org) return BASE_CRAWLERS.filter(c => !c.needsProfile);
  
  const applicantType = org.applicant_type || 'organization';
  
  return BASE_CRAWLERS.filter(crawler => {
    if (crawler.profileTypes.includes('all')) return true;
    return crawler.profileTypes.includes(applicantType);
  });
};

export default function DataSources() {
  const [selectedOrgId, setSelectedOrgId] = useState('');

  // M5 FIX: Use centralized auth context instead of duplicate query
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // Fetch organizations with RLS filtering
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Organization.list()
        : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  // Normalize org IDs to strings (defensive)
  const orgIds = useMemo(() => organizations.map((o) => String(o.id)), [organizations]);

  // Validate selectedOrgId against RLS-filtered organizations
  useEffect(() => {
    if (!selectedOrgId) return;
    if (!orgIds.includes(String(selectedOrgId))) {
      setSelectedOrgId('');
    }
  }, [selectedOrgId, orgIds]);

  // Auto-select first organization if none selected
  useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      setSelectedOrgId(String(organizations[0].id));
    }
  }, [organizations, selectedOrgId]);

  // Use crawl manager with validated org selection
  const {
    crawlLogs,
    opportunities,
    crawlingInBackground,
    isLoading: isCrawlLoading,
    getLatestLog,
    handleRunCrawler,
  } = useCrawlManager({
    user,
    isAdmin,
    organizations,
    selectedOrgId,
  });

  // Get selected organization from validated list
  const selectedOrg = useMemo(
    () => organizations.find((o) => String(o.id) === String(selectedOrgId)),
    [organizations, selectedOrgId]
  );

  // Get crawlers for selected profile type
  const crawlers = useMemo(
    () => getCrawlersForProfile(selectedOrg),
    [selectedOrg]
  );

  // Computed stats
  const stats = useMemo(
    () => ({
      totalOpportunities: opportunities.length,
      availableCrawlers: crawlers.length,
      successfulCrawls: crawlLogs.filter((log) => log.status === 'completed').length,
      failedCrawls: crawlLogs.filter((log) => log.status === 'failed').length,
    }),
    [opportunities, crawlLogs, crawlers.length]
  );

  // Loading state - wait for user, orgs, and crawl data
  if (isLoadingUser || isLoadingOrgs || isCrawlLoading) {
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
                Crawl federal databases and benefit programs for opportunities
              </p>
            </div>

            <ProfileSelector
              value={String(selectedOrgId)}
              onChange={(v) => setSelectedOrgId(String(v))}
              organizations={organizations}
              selectedOrg={selectedOrg}
              disabled={isLoadingOrgs || isCrawlLoading}
            />
          </div>

          {/* Background crawling alert */}
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

        {/* Stats Grid */}
        <div className="mb-8">
          <CrawlStats {...stats} />
        </div>

        {/* No Profile Selected State */}
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
        ) : selectedOrg ? (
          <>
            {/* Crawlers Section */}
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Data Sources for {selectedOrg.name}
            </h2>

            <div className="grid md:grid-cols-2 gap-6 mb-12">
              {crawlers.map((crawler) => {
                const latestLog = getLatestLog(crawler.name);
                const isCrawling = crawlingInBackground.includes(crawler.function);

                return (
                  <CrawlerCard
                    key={crawler.name}
                    crawler={crawler}
                    latestLog={latestLog}
                    isCrawling={isCrawling}
                    onRun={handleRunCrawler}
                  />
                );
              })}
            </div>
          </>
        ) : null}

        {/* Recent Crawl Activity */}
        <div className="mt-12">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Recent Crawl Activity</h2>
          <RecentCrawlActivity crawlLogs={crawlLogs} />
        </div>
      </div>
    </div>
  );
}