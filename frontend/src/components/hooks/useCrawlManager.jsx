import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Custom hook for managing data source crawling with RLS filtering
 * @param {Object} options
 * @param {Object} options.user - Current user object
 * @param {boolean} options.isAdmin - Whether user is admin
 * @param {Array} options.organizations - RLS-filtered organizations
 * @param {string} options.selectedOrgId - Currently selected org ID
 */
export function useCrawlManager({ user, isAdmin, organizations = [], selectedOrgId } = {}) {
  const [crawlingInBackground, setCrawlingInBackground] = useState([]);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Fetch crawl logs with user-aware query key
  const { data: crawlLogs = [], isLoading: isLoadingLogs } = useQuery({
    queryKey: ['crawlLogs', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.CrawlLog.list('-created_date', 50)
        : base44.entities.CrawlLog.filter({ created_by: user.email }, '-created_date', 50),
    enabled: !!user?.email,
  });

  // Fetch opportunities with user-aware query key
  const { data: opportunities = [], isLoading: isLoadingOpportunities } = useQuery({
    queryKey: ['fundingOpportunities', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.FundingOpportunity.list('-created_date', 100)
        : base44.entities.FundingOpportunity.filter({ created_by: user.email }, '-created_date', 100),
    enabled: !!user?.email,
  });

  // Auto-refresh when crawling in background
  useEffect(() => {
    if (crawlingInBackground.length > 0) {
      const interval = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ['crawlLogs', user?.email, isAdmin] });
        queryClient.invalidateQueries({ queryKey: ['fundingOpportunities', user?.email, isAdmin] });
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [crawlingInBackground, queryClient, user?.email, isAdmin]);

  // Get selected organization from validated list
  const selectedOrg = useMemo(() => 
    organizations.find(o => o.id === selectedOrgId),
    [organizations, selectedOrgId]
  );

  // Crawl mutation
  const crawlMutation = useMutation({
    mutationFn: async ({ crawlerName, payload }) => {
      console.log(`[useCrawlManager] Starting ${crawlerName} with payload:`, payload);
      
      // Fire and forget - don't wait for response
      base44.functions.invoke(crawlerName, { body: payload }).catch(err => {
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
        queryClient.invalidateQueries({ queryKey: ['crawlLogs', user?.email, isAdmin] });
        queryClient.invalidateQueries({ queryKey: ['fundingOpportunities', user?.email, isAdmin] });
        toast({
          title: '✅ Crawler Complete',
          description: 'Check the results below!',
        });
      }, 120000);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Crawl Failed",
        description: error.message || "An error occurred while starting the crawler.",
      });
    },
  });

  // Get latest log for a source
  const getLatestLog = useCallback((source) => {
    return crawlLogs.find(log => log.source === source.toLowerCase().replace('.', '_'));
  }, [crawlLogs]);

  // Combined loading flag
  const isLoading = isLoadingLogs || isLoadingOpportunities;

  // Handle crawler run with permission verification
  const handleRunCrawler = useCallback((crawler) => {
    // Verify user is loaded
    if (!user?.email) {
      toast({
        variant: "destructive",
        title: "Not Authenticated",
        description: "Please sign in to run crawlers.",
      });
      return;
    }

    // Verify profile is selected for profile-aware crawlers
    if (crawler.needsProfile && !selectedOrgId) {
      toast({
        variant: "destructive",
        title: "Profile Required",
        description: "Please select a profile before running this crawler.",
      });
      return;
    }

    // Verify user owns the selected organization (unless admin)
    if (crawler.needsProfile && selectedOrgId) {
      if (!selectedOrg) {
        toast({
          variant: "destructive",
          title: "Access Denied",
          description: "You do not have permission to run crawlers for this profile.",
        });
        return;
      }
    }

    const payload = {};
    
    if (crawler.needsProfile && selectedOrgId) {
      payload.organization_id = selectedOrgId;
      console.log(`[useCrawlManager] Running ${crawler.function} with profile:`, selectedOrgId);
    }

    crawlMutation.mutate({ 
      crawlerName: crawler.function,
      payload 
    });
  }, [user?.email, selectedOrgId, selectedOrg, toast, crawlMutation]);

  return {
    crawlLogs,
    opportunities,
    selectedOrg,
    crawlingInBackground,
    isLoading,
    getLatestLog,
    handleRunCrawler,
    isCrawling: crawlMutation.isPending,
  };
}