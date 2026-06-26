import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Search,
  Plus,
  Loader2,
  CheckCircle,
  ExternalLink,
  Play,
  Trash2,
  Edit,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
  Building2,
  Clock,
  Filter,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  FileText,
  SearchIcon, // Added SearchIcon
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label'; // Added Label import
import AddSourceForm from '@/components/sources/AddSourceForm';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useCrawlJobTracker } from '@/hooks/useCrawlJobTracker'
import { createLogger } from '@/utils/logger'

export default function SourceDirectory() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [sourceTypeFilter, setSourceTypeFilter] = useState('all');
  const [isDiscoverOpen, setIsDiscoverOpen] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false); // New state
  const [searchSourceName, setSearchSourceName] = useState(''); // New state
  const [searchLocation, setSearchLocation] = useState(''); // New state
  const [editingSource, setEditingSource] = useState(null);
  const [prefilledSource, setPrefilledSource] = useState(null); // distinct prefill (create-with-prefill) state
  const [selectedSources, setSelectedSources] = useState([]);
  const [crawlingInBackground, setCrawlingInBackground] = useState([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // { type: 'single'|'bulk'|'by_source_type', id?, ids?, sourceType? }
  const [expandedSourceId, setExpandedSourceId] = useState(null);
  const [addingToPipeline, setAddingToPipeline] = useState([]); // per-opportunity pending ids
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const log = React.useMemo(() => createLogger('SourceDirectoryPage'), [])
  const tracker = useCrawlJobTracker({ pollMs: 5000 })

  const { data: sources = [], isLoading: isLoadingSources } = useQuery({
    queryKey: ['sourceDirectory'],
    queryFn: () => client.entities.SourceDirectory.list(),
    refetchInterval: crawlingInBackground.length > 0 ? 5000 : false,
    onError: (error) => {
      log.error('failed to load source directory', error)
      toast({ variant: 'destructive', title: 'Failed to load sources', description: error?.message || 'Could not load source directory.' })
    },
  });

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list('name'),
    onError: (error) => {
      log.error('failed to load organizations', error)
      toast({ variant: 'destructive', title: 'Failed to load profiles', description: error?.message || 'Could not load profiles.' })
    },
  });

  // NEW: Query for opportunities from expanded source
  const expandedSource = useMemo(
    () => sources.find((s) => s.id === expandedSourceId) || null,
    [sources, expandedSourceId]
  );
  const expandedSourceName = expandedSource?.name || null;

  const { data: sourceOpportunities = [], isLoading: isLoadingOpportunities } = useQuery({
    queryKey: ['sourceOpportunities', expandedSourceId, expandedSourceName],
    queryFn: async () => {
      if (!expandedSourceId || !expandedSourceName) return [];
      try {
        // Query opportunities that match this source
        const opportunities = await client.entities.FundingOpportunity.filter({
          source: 'source_directory',
          sponsor: expandedSourceName
        });
        return Array.isArray(opportunities) ? opportunities : [];
      } catch (error) {
        log.error('failed to load source opportunities', error)
        toast({ variant: 'destructive', title: 'Failed to load opportunities', description: error?.message || 'Could not load opportunities.' })
        return [];
      }
    },
    enabled: !!expandedSourceId && !!expandedSourceName,
  });

  // Query grants to check which opportunities are already in pipeline
  const { data: allGrants = [] } = useQuery({
    queryKey: ['grants'],
    queryFn: () => client.entities.Grant.list(),
    onError: (error) => {
      log.error('failed to load grants', error)
    },
  });

  async function fetchSourceById(sourceId) {
    try {
      const rows = await client.entities.SourceDirectory.filter({ id: sourceId })
      return Array.isArray(rows) ? rows[0] : null
    } catch (error) {
      log.error('failed to fetch source by id', error)
      return null
    }
  }

  // Auto-select first organization if none selected
  useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      setSelectedOrgId(organizations[0].id);
    }
  }, [organizations, selectedOrgId]);

  const crawlMutation = useMutation({
    mutationFn: async (sourceId) => {
      await client.functions.invoke('crawlSourceDirectory', { source_id: sourceId })
      return { sourceId, startedAt: Date.now() };
    },
    onSuccess: (data) => {
      const sourceId = String(data.sourceId)
      const startedAt = Number(data.startedAt || Date.now())
      const baseline = sources.find((s) => String(s?.id) === sourceId)?.last_crawled ?? null

      setCrawlingInBackground(prev => [...prev, sourceId]);
      toast({
        title: '🚀 Crawl Started',
        description: 'Crawling in background. Page will auto-refresh when complete.',
        duration: 3000,
      });

      tracker.track({
        key: `source-crawl:${sourceId}:${startedAt}`,
        timeoutMs: 4 * 60 * 1000,
        poll: async () => {
          const row = await fetchSourceById(sourceId)
          if (!row) return { done: false }
          const lastParsed = row.last_crawled ? Date.parse(String(row.last_crawled)) : NaN
          const baseParsed = baseline ? Date.parse(String(baseline)) : NaN
          const last = Number.isFinite(lastParsed) ? lastParsed : null
          const base = Number.isFinite(baseParsed) ? baseParsed : null
          if (last !== null && (base === null || last > base) && last >= startedAt - 10_000) {
            return { done: true, status: 'completed' }
          }
          return { done: false }
        },
        onDone: (res) => {
          setCrawlingInBackground((prev) => prev.filter((id) => id !== sourceId))
          queryClient.invalidateQueries({ queryKey: ['sourceDirectory'] })
          queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] })
          queryClient.invalidateQueries({ queryKey: ['sourceOpportunities'] })
          if (res?.status === 'failed') {
            toast({ variant: 'destructive', title: 'Crawl timed out', description: 'Check logs and try again.' })
          } else {
            toast({ title: '✅ Crawl complete', description: 'Source updated.' })
          }
        },
      })
    },
    onError: (error) => {
      log.error('failed to start crawlSourceDirectory', error)
      toast({ variant: 'destructive', title: 'Crawl Failed', description: error?.message || 'Failed to start crawl.' })
    },
  });

  const bulkCrawlMutation = useMutation({
    mutationFn: async (sourceIds) => {
      const results = await Promise.allSettled(
        sourceIds.map((sourceId) =>
          client.functions.invoke('crawlSourceDirectory', { source_id: sourceId }).then(() => sourceId)
        )
      );
      const started = [];
      const failed = [];
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          started.push(sourceIds[idx]);
        } else {
          failed.push(sourceIds[idx]);
        }
      });
      return { startedIds: started, failedIds: failed, count: started.length, startedAt: Date.now() };
    },
    onSuccess: (data) => {
      const startedAt = Number(data.startedAt || Date.now())
      const startedIds = Array.isArray(data.startedIds) ? data.startedIds : [];
      const failedIds = Array.isArray(data.failedIds) ? data.failedIds : [];

      setCrawlingInBackground(prev => [...prev, ...startedIds.map(String)]);
      setSelectedSources([]);

      if (startedIds.length > 0) {
        toast({
          title: '🚀 Bulk Crawl Started',
          description: `${startedIds.length} source${startedIds.length !== 1 ? 's' : ''} crawling in background. Page will auto-refresh.`,
          duration: 4000,
        });
      }
      if (failedIds.length > 0) {
        toast({
          variant: 'destructive',
          title: 'Some crawls failed to start',
          description: `${failedIds.length} source${failedIds.length !== 1 ? 's' : ''} could not be started.`,
        });
      }

      for (const id of startedIds) {
        const sourceId = String(id)
        const baseline = sources.find((s) => String(s?.id) === sourceId)?.last_crawled ?? null
        tracker.track({
          key: `source-crawl:${sourceId}:${startedAt}`,
          timeoutMs: 6 * 60 * 1000,
          poll: async () => {
            const row = await fetchSourceById(sourceId)
            if (!row) return { done: false }
            const lastParsed = row.last_crawled ? Date.parse(String(row.last_crawled)) : NaN
            const baseParsed = baseline ? Date.parse(String(baseline)) : NaN
            const last = Number.isFinite(lastParsed) ? lastParsed : null
            const base = Number.isFinite(baseParsed) ? baseParsed : null
            if (last !== null && (base === null || last > base) && last >= startedAt - 10_000) {
              return { done: true, status: 'completed' }
            }
            return { done: false }
          },
          onDone: () => {
            setCrawlingInBackground((prev) => prev.filter((x) => x !== sourceId))
            queryClient.invalidateQueries({ queryKey: ['sourceDirectory'] })
            queryClient.invalidateQueries({ queryKey: ['sourceOpportunities'] })
          },
        })
      }
    },
    onError: (error) => {
      log.error('bulk crawl failed to start', error)
      toast({ variant: 'destructive', title: 'Bulk crawl failed', description: error?.message || 'Failed to start bulk crawl.' })
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (target) => {
      let sourceIdsToDelete = [];

      // Determine which source IDs to delete
      if (target?.type === 'single') {
        sourceIdsToDelete = target.id !== null && target.id !== undefined ? [target.id] : [];
      } else if (target?.type === 'bulk') {
        sourceIdsToDelete = Array.isArray(target.ids) ? target.ids : [];
      } else if (target?.type === 'by_source_type') {
        const typeSources = sources.filter(s =>
          s.discovered_for_organization_id === selectedOrgId &&
          s.source_type === target.sourceType
        );
        sourceIdsToDelete = typeSources.map(s => s.id);
      }

      // Guard against firing a cascade delete with an empty list
      if (!Array.isArray(sourceIdsToDelete) || sourceIdsToDelete.length === 0) {
        throw new Error('No sources selected for deletion.');
      }

      // Call backend function to handle cascade deletion with service role
      const response = await client.functions.invoke('deleteSourceWithCascade', {
        source_ids: sourceIdsToDelete,
        organization_id: selectedOrgId
      });

      return response?.data;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sourceDirectory'] });
      queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] });
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
      setSelectedSources([]);

      const { count = 0, opportunitiesDeleted = 0, grantsDeleted = 0 } = result || {};

      const messageParts = [];
      messageParts.push(`${count} source${count !== 1 ? 's' : ''} removed`);
      if (opportunitiesDeleted > 0) {
        messageParts.push(`${opportunitiesDeleted} opportunity${opportunitiesDeleted !== 1 ? 's' : ''} deleted`);
      }
      if (grantsDeleted > 0) {
        messageParts.push(`${grantsDeleted} grant${grantsDeleted !== 1 ? 's' : ''} removed from pipeline`);
      }

      toast({
        title: '✅ Cascade Delete Complete',
        description: messageParts.join(', '),
      });
    },
    onError: (error) => {
      log.error('cascade delete failed', error)
      toast({
        variant: 'destructive',
        title: 'Delete Failed',
        description: error?.message || 'Delete failed',
      });
    }
  });

  const discoverMutation = useMutation({
    mutationFn: async (orgId) => {
      await client.functions.invoke('discoverLocalSources', { organization_id: orgId })
      return { orgId, startedAt: Date.now() };
    },
    onSuccess: (data) => {
      const orgId = String(data.orgId)
      const startedAt = Number(data.startedAt || Date.now())
      const baselineCount = sources.filter((s) => String(s?.discovered_for_organization_id || '') === orgId).length
      setIsDiscoverOpen(false);
      toast({
        title: '✨ Discovery Started',
        description: 'AI is discovering sources in the background. This may take 2-3 minutes.',
        duration: 5000,
      });

      tracker.track({
        key: `discover:${orgId}:${startedAt}`,
        timeoutMs: 4 * 60 * 1000,
        poll: async () => {
          try {
            const rows = await client.entities.SourceDirectory.list()
            const count = Array.isArray(rows)
              ? rows.filter((s) => String(s?.discovered_for_organization_id || '') === orgId).length
              : 0
            if (count > baselineCount) return { done: true, status: 'completed' }
            return { done: false }
          } catch (error) {
            log.error('discovery poll failed', error)
            return { done: false }
          }
        },
        onDone: (res) => {
          queryClient.invalidateQueries({ queryKey: ['sourceDirectory'] })
          toast({
            title: res?.status === 'failed' ? 'Discovery timed out' : '✅ Discovery complete',
            description:
              res?.status === 'failed'
                ? 'Discovery may still be running. Refresh later to see new sources.'
                : 'Check the source list for new discoveries!',
            variant: res?.status === 'failed' ? 'destructive' : 'default',
          })
        },
      })
    },
    onError: (error) => {
      log.error('failed to start discovery', error)
      toast({ variant: 'destructive', title: 'Discovery failed', description: error?.message || 'Failed to start discovery.' })
    },
  });

  // NEW: Search for specific source mutation
  const searchSourceMutation = useMutation({
    mutationFn: async ({ source_name, location, organization_id }) => {
      const response = await client.functions.invoke('searchForSource', {
        source_name,
        location,
        organization_id
      });
      return response?.data;
    },
    onSuccess: (data) => {
      if (data?.success && data?.source) {
        setPrefilledSource(data.source);
        setEditingSource(null);
        setIsSearchOpen(false);
        setIsAddOpen(true);
        setSearchSourceName('');
        setSearchLocation('');
        toast({
          title: '✅ Source Found',
          description: `Found ${data.source.name || 'source'}. Review and save to add to directory.`,
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Not Found',
          description: data?.message || 'Could not find information about this source.',
        });
      }
    },
    onError: (error) => {
      log.error('search for source failed', error)
      toast({
        variant: 'destructive',
        title: 'Search Failed',
        description: error?.message || 'An error occurred while searching.',
      });
    }
  });

  const selectedOrg = useMemo(() =>
    organizations.find(o => o.id === selectedOrgId),
    [organizations, selectedOrgId]
  );

  const relevantSources = useMemo(() => {
    if (!selectedOrgId || !selectedOrg) return [];

    const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(selectedOrg.applicant_type);
    const isIndividual = ['individual_need', 'medical_assistance', 'family'].includes(selectedOrg.applicant_type);
    const studentOnlyTypes = ['university', 'community_college'];
    const individualOnlyTypes = ['hospital_system'];

    return sources.filter(source => {
      if (source.discovered_for_organization_id === selectedOrgId) {
        return true;
      }
      if (source.discovered_for_organization_id && source.discovered_for_organization_id !== selectedOrgId) {
        return false;
      }
      if (!source.discovered_for_organization_id) {
        if (!isStudent && studentOnlyTypes.includes(source.source_type)) {
          return false;
        }
        if (!isIndividual && individualOnlyTypes.includes(source.source_type)) {
          return false;
        }
        if (!source.service_area || source.service_area.length === 0) {
          return true;
        }
        if (selectedOrg.state && source.service_area.includes(selectedOrg.state)) return true;
        if (selectedOrg.city && source.service_area.includes(selectedOrg.city)) return true;
        if (source.service_area.includes('National') || source.service_area.includes('USA')) return true;
      }
      return false;
    });
  }, [sources, selectedOrgId, selectedOrg]);

  const sourcesDue = useMemo(() => {
    const now = new Date();
    return relevantSources.filter((source) => {
      if (!source.active) return false;
      if (!source.last_crawled) return true;

      const lastCrawled = new Date(source.last_crawled);
      const frequency = source.crawl_frequency || 'monthly';

      const intervals = {
        daily: 1,
        weekly: 7,
        monthly: 30,
        quarterly: 90,
        annually: 365,
      };

      const daysSinceLastCrawl = (now.getTime() - lastCrawled.getTime()) / (1000 * 60 * 60 * 24);
      return daysSinceLastCrawl >= (intervals[frequency] || 30);
    });
  }, [relevantSources]);

  const filteredSources = useMemo(() => {
    let filtered = relevantSources;

    if (sourceTypeFilter !== 'all') {
      filtered = filtered.filter(s => s.source_type === sourceTypeFilter);
    }

    if (searchQuery) {
      filtered = filtered.filter((source) =>
        source.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    return filtered;
  }, [relevantSources, searchQuery, sourceTypeFilter]);

  // Get unique source types for filter dropdown
  const sourceTypes = useMemo(() => {
    const types = new Set(relevantSources.map(s => s.source_type).filter(Boolean));
    return Array.from(types).sort();
  }, [relevantSources]);

  // Group sources by type for bulk delete
  const sourcesByType = useMemo(() => {
    const grouped = {};
    relevantSources.forEach(source => {
      if (!grouped[source.source_type]) {
        grouped[source.source_type] = [];
      }
      grouped[source.source_type].push(source);
    });
    return grouped;
  }, [relevantSources]);

  const handleCrawl = (sourceId) => {
    crawlMutation.mutate(sourceId);
  };

  const handleBulkCrawl = () => {
    if (!Array.isArray(selectedSources) || selectedSources.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No Sources Selected',
        description: 'Please select at least one source to crawl.',
      });
      return;
    }
    const idsToCrawl = selectedSources.filter((id) => !crawlingInBackground.includes(id));
    if (idsToCrawl.length === 0) {
      toast({
        title: 'Already Crawling',
        description: 'All selected sources are already crawling.',
      });
      return;
    }
    bulkCrawlMutation.mutate(idsToCrawl);
  };

  const handleCrawlAllDue = () => {
    if (!Array.isArray(sourcesDue) || sourcesDue.length === 0) {
      toast({
        title: 'No Sources Due',
        description: 'All sources are up to date!',
      });
      return;
    }
    const dueIds = sourcesDue
      .map((s) => s.id)
      .filter((id) => !crawlingInBackground.includes(id));
    if (dueIds.length === 0) {
      toast({
        title: 'Already Crawling',
        description: 'All due sources are already crawling.',
      });
      return;
    }
    bulkCrawlMutation.mutate(dueIds);
  };

  const handleToggleSource = (sourceId) => {
    setSelectedSources((prev) =>
      prev.includes(sourceId)
        ? prev.filter((id) => id !== sourceId)
        : [...prev, sourceId]
    );
  };

  const handleToggleAll = () => {
    if (selectedSources.length === filteredSources.length) {
      setSelectedSources([]);
    } else {
      setSelectedSources(filteredSources.map((s) => s.id));
    }
  };

  const handleDeleteClick = (type, data) => {
    setDeleteTarget({ type, ...data });
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = () => {
    deleteMutation.mutate(deleteTarget);
  };

  const handleDeleteBySourceType = (sourceType) => {
    const count = sourcesByType[sourceType]?.length || 0;
    if (count === 0) return;

    handleDeleteClick('by_source_type', { sourceType });
  };

  const handleViewAndSelectType = (sourceType) => {
    // Filter to this type
    setSourceTypeFilter(sourceType);
    // Clear search
    setSearchQuery('');
    // Clear current selections
    setSelectedSources([]);
    // Scroll to table
    setTimeout(() => {
      document.querySelector('.sources-table')?.scrollIntoView({ behavior: 'smooth' });
    }, 100);

    toast({
      title: 'Filter Applied',
      description: `Showing only ${sourceType.replace(/_/g, ' ')} sources. Select the ones you want to delete.`,
    });
  };

  const handleSelectAllOfType = (sourceType) => {
    const typeSources = sourcesByType[sourceType] || [];
    const typeSourceIds = typeSources.map(s => s.id);
    setSelectedSources(typeSourceIds);
    setSourceTypeFilter(sourceType);
    setSearchQuery('');

    toast({
      title: `${typeSources.length} Sources Selected`,
      description: `All ${typeSources.length === 1 ? sourceType.replace(/_/g, ' ') + ' source' : sourceType.replace(/_/g, ' ') + ' sources'} are now selected.`,
    });
  };

  const handleToggleExpand = (sourceId) => {
    if (expandedSourceId === sourceId) {
      setExpandedSourceId(null);
    } else {
      setExpandedSourceId(sourceId);
    }
  };

  const isOpportunityInPipeline = (opportunityUrl) => {
    if (!opportunityUrl) return false;
    return allGrants.some(g => g.url && g.url === opportunityUrl && g.organization_id === selectedOrgId);
  };

  const openWebsite = (url) => {
    if (!url) return;
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      log.error('failed to open website', error)
      toast({ variant: 'destructive', title: 'Could not open link', description: 'Your browser blocked opening this link.' })
    }
  };

  const handleSearchForSource = () => {
    if (!searchSourceName.trim()) {
      toast({
        variant: 'destructive',
        title: 'Source Name Required',
        description: 'Please enter a source name to search for.',
      });
      return;
    }

    const trimmedLocation = (searchLocation || '').trim();
    const fallbackLocation = selectedOrg && (selectedOrg.city || selectedOrg.state)
      ? [selectedOrg.city, selectedOrg.state].filter(Boolean).join(', ')
      : '';

    searchSourceMutation.mutate({
      source_name: searchSourceName.trim(),
      location: trimmedLocation || fallbackLocation,
      organization_id: selectedOrgId
    });
  };

  const handleAddOpportunityToPipeline = async (opp) => {
    const oppKey = opp.id ?? opp.url;
    if (oppKey !== null && oppKey !== undefined && addingToPipeline.includes(oppKey)) return;
    setAddingToPipeline((prev) => [...prev, oppKey]);
    try {
      // Check for duplicates first
      if (opp.url) {
        const existingGrants = await client.entities.Grant.filter({
          organization_id: selectedOrgId,
          url: opp.url
        });

        if (Array.isArray(existingGrants) && existingGrants.length > 0) {
          toast({
            title: 'Already in Pipeline',
            description: `"${opp.title}" is already in your pipeline.`,
          });
          queryClient.invalidateQueries({ queryKey: ['grants'] });
          return;
        }
      }

      const grantData = {
        organization_id: selectedOrgId,
        title: opp.title,
        funder: opp.sponsor,
        url: opp.url,
        deadline: opp.deadlineAt,
        amount_min: opp.awardMin,
        amount_max: opp.awardMax,
        eligibility_summary: opp.eligibilityBullets?.join('\n'),
        program_description: opp.descriptionMd,
        status: 'discovered',
      };
      await client.entities.Grant.create(grantData);
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      toast({
        title: 'Added to Pipeline',
        description: `${opp.title} has been added to your pipeline`,
      });
    } catch (error) {
      log.error('failed to add opportunity to pipeline', error)
      toast({
        variant: 'destructive',
        title: 'Failed to Add',
        description: error?.message || 'Could not add this opportunity to your pipeline.',
      });
    } finally {
      setAddingToPipeline((prev) => prev.filter((k) => k !== oppKey));
    }
  };

  if (isLoadingSources || isLoadingOrgs) {
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
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
                <Target className="w-8 h-8 text-blue-600" />
                Source Directory
              </h1>
              <p className="text-slate-600 mt-2">
                Discover and manage local funding sources
              </p>
            </div>

            <div className="w-full md:w-80">
              <Select value={selectedOrgId || ""} onValueChange={(v) => setSelectedOrgId(v || null)}>
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
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-900">
                <strong>📂 Showing sources for:</strong>{' '}
                <span className="font-semibold">{selectedOrg.name}</span>
                {selectedOrg.applicant_type && (
                  <span className="ml-2 text-xs">
                    ({selectedOrg.applicant_type.replace(/_/g, ' ')})
                  </span>
                )}
              </p>
            </div>
          )}

          {crawlingInBackground.length > 0 && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-amber-600" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-900">
                    {crawlingInBackground.length} source{crawlingInBackground.length > 1 ? 's' : ''} crawling in background
                  </p>
                  <p className="text-xs text-amber-700">
                    Page will auto-refresh every 10 seconds. Continue working!
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {!selectedOrgId ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Profile Selected</h3>
              <p className="text-slate-600">
                Please select a profile from the dropdown above to view their funding sources.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-slate-500">Sources for This Profile</div>
                      <div className="text-3xl font-bold text-slate-900 mt-1">
                        {relevantSources.length}
                      </div>
                    </div>
                    <Target className="w-10 h-10 text-blue-500 opacity-50" />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-slate-500">Active Sources</div>
                      <div className="text-3xl font-bold text-emerald-600 mt-1">
                        {relevantSources.filter((s) => s.active).length}
                      </div>
                    </div>
                    <CheckCircle className="w-10 h-10 text-emerald-500 opacity-50" />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-slate-500">Due for Crawl</div>
                      <div className="text-3xl font-bold text-amber-600 mt-1">
                        {sourcesDue.length}
                      </div>
                    </div>
                    <TrendingUp className="w-10 h-10 text-amber-500 opacity-50" />
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Action Bar */}
            <div className="flex flex-col gap-4 mb-6">
              <div className="flex flex-col md:flex-row gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search sources..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>

                <Select value={sourceTypeFilter} onValueChange={setSourceTypeFilter}>
                  <SelectTrigger className="w-full md:w-48">
                    <div className="flex items-center gap-2">
                      <Filter className="w-4 h-4" />
                      <SelectValue placeholder="Filter by type..." />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {sourceTypes.map(type => (
                      <SelectItem key={type} value={type}>
                        {type.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-2 flex-wrap">
                {selectedSources.length > 0 && (
                  <>
                    <Button
                      onClick={handleBulkCrawl}
                      className="bg-blue-600 hover:bg-blue-700 text-white hover:text-white"
                    >
                      <Play className="w-4 h-4 mr-2" />
                      Crawl {selectedSources.length} Selected
                    </Button>
                    <Button
                      onClick={() => handleDeleteClick('bulk', { ids: selectedSources })}
                      variant="destructive"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete {selectedSources.length} Selected
                    </Button>
                  </>
                )}

                {sourcesDue.length > 0 && (
                  <Button
                    onClick={handleCrawlAllDue}
                    variant="outline"
                    className="border-amber-500 text-amber-600 hover:bg-amber-50"
                  >
                    <Zap className="w-4 h-4 mr-2" />
                    Crawl {sourcesDue.length} Due
                  </Button>
                )}

                <Button
                  variant="outline"
                  onClick={() => setIsDiscoverOpen(true)}
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  AI Discover More
                </Button>

                {/* NEW: Search for Source Button */}
                <Button
                  variant="outline"
                  onClick={() => setIsSearchOpen(true)}
                  className="border-emerald-500 text-emerald-600 hover:bg-emerald-50"
                >
                  <SearchIcon className="w-4 h-4 mr-2" />
                  Search for Source
                </Button>

                <Button onClick={() => { setEditingSource(null); setPrefilledSource(null); setIsAddOpen(true); }}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Source
                </Button>
              </div>
            </div>

            {/* Sources by Type - Enhanced with View & Select */}
            {Object.keys(sourcesByType).length > 0 && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Sources by Type - Quick Actions</CardTitle>
                  <p className="text-sm text-slate-600 mt-2">
                    Filter to a specific type to select and delete individual sources, or delete all at once
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {Object.entries(sourcesByType).map(([type, typeSources]) => (
                      <div key={type} className="p-4 bg-slate-50 rounded-lg border hover:border-blue-300 transition-colors">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="text-sm font-semibold capitalize">
                              {type.replace(/_/g, ' ')}
                            </p>
                            <Badge variant="outline" className="mt-1">{typeSources.length} sources</Badge>
                          </div>
                        </div>
                        <div className="flex flex-col gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full text-blue-600 hover:text-blue-700 hover:bg-blue-50 border-blue-200"
                            onClick={() => handleViewAndSelectType(type)}
                          >
                            <Filter className="w-3 h-3 mr-1" />
                            View & Select
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 border-emerald-200"
                            onClick={() => handleSelectAllOfType(type)}
                          >
                            <CheckSquare className="w-3 h-3 mr-1" />
                            Select All {typeSources.length}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDeleteBySourceType(type)}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Delete All
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Sources Table */}
            <Card className="sources-table">
              <CardHeader>
                <CardTitle>Sources ({filteredSources.length})</CardTitle>
                {sourceTypeFilter !== 'all' && (
                  <div className="flex items-center gap-2 mt-2">
                    <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                      Filtered: {sourceTypeFilter.replace(/_/g, ' ')}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSourceTypeFilter('all')}
                      className="text-xs"
                    >
                      Clear filter
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox
                          checked={
                            selectedSources.length === filteredSources.length &&
                            filteredSources.length > 0
                          }
                          onCheckedChange={handleToggleAll}
                        />
                      </TableHead>
                      <TableHead className="w-12"></TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Last Crawled</TableHead>
                      <TableHead>Frequency</TableHead>
                      <TableHead>Opportunities</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSources.map((source) => {
                      const isDue = sourcesDue.some((s) => s.id === source.id);
                      const isCrawling = crawlingInBackground.includes(source.id);
                      const isExpanded = expandedSourceId === source.id;

                      return (
                        <React.Fragment key={source.id}>
                          <TableRow className={isCrawling ? 'bg-amber-50' : ''}>
                            <TableCell>
                              <Checkbox
                                checked={selectedSources.includes(source.id)}
                                onCheckedChange={() => handleToggleSource(source.id)}
                              />
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleToggleExpand(source.id)}
                                disabled={!source.opportunities_found || source.opportunities_found === 0}
                              >
                                {isExpanded ? (
                                  <ChevronUp className="w-4 h-4" />
                                ) : (
                                  <ChevronDown className="w-4 h-4" />
                                )}
                              </Button>
                            </TableCell>
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2">
                                {source.name}
                                {isCrawling && (
                                  <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-300">
                                    <Clock className="w-3 h-3 mr-1 animate-pulse" />
                                    crawling...
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="capitalize">
                                {source.source_type?.replace(/_/g, ' ') || 'N/A'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-slate-600">
                              {source.city && source.state
                                ? `${source.city}, ${source.state}`
                                : source.state || 'N/A'}
                            </TableCell>
                            <TableCell className="text-sm text-slate-600">
                              {source.last_crawled ? (
                                <>
                                  {new Date(source.last_crawled).toLocaleDateString()}
                                  {isDue && (
                                    <Badge variant="outline" className="ml-2 bg-amber-50 text-amber-700 border-amber-200">
                                      due
                                    </Badge>
                                  )}
                                </>
                              ) : (
                                <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                                  never
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="capitalize">
                                {source.crawl_frequency || 'monthly'}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <span className="font-semibold text-slate-900">
                                {source.opportunities_found || 0}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={
                                  source.active
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : 'bg-slate-50 text-slate-700 border-slate-200'
                                }
                              >
                                {source.active ? 'active' : 'inactive'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleCrawl(source.id)}
                                  disabled={isCrawling}
                                  title="Crawl this source"
                                >
                                  {isCrawling ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Play className="w-4 h-4" />
                                  )}
                                </Button>
                                {source.website_url && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openWebsite(source.website_url)}
                                    title="Visit website"
                                  >
                                    <ExternalLink className="w-4 h-4" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => {
                                    setEditingSource(source);
                                    setPrefilledSource(null);
                                    setIsAddOpen(true);
                                  }}
                                  title="Edit source"
                                >
                                  <Edit className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDeleteClick('single', { id: source.id })}
                                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                  title="Delete source"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>

                          {/* Expanded row showing opportunities */}
                          {isExpanded && (
                            <TableRow>
                              <TableCell colSpan={10} className="bg-slate-50 p-4">
                                {isLoadingOpportunities ? (
                                  <div className="flex justify-center py-8">
                                    <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                                  </div>
                                ) : sourceOpportunities.length === 0 ? (
                                  <div className="text-center py-8 text-slate-500">
                                    <FileText className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                                    <p>No opportunities found from this source yet</p>
                                    <p className="text-xs mt-1">Try crawling this source to discover opportunities</p>
                                  </div>
                                ) : (
                                  <div className="space-y-2">
                                    <h4 className="font-semibold text-slate-900 mb-3">
                                      Opportunities from {source.name} ({sourceOpportunities.length})
                                    </h4>
                                    <div className="grid gap-2">
                                      {sourceOpportunities.map((opp) => {
                                        const inPipeline = isOpportunityInPipeline(opp.url);
                                        const grant = opp.url
                                          ? allGrants.find(g => g.url && g.url === opp.url && g.organization_id === selectedOrgId)
                                          : null;
                                        const oppKey = opp.id ?? opp.url;
                                        const isAdding = oppKey !== null && oppKey !== undefined && addingToPipeline.includes(oppKey);

                                        return (
                                          <div
                                            key={opp.id ?? opp.url}
                                            className="flex items-center justify-between p-3 bg-white rounded-lg border hover:border-blue-300 transition-colors"
                                          >
                                            <div className="flex-1">
                                              <div className="flex items-center gap-2 mb-1">
                                                <h5 className="font-medium text-slate-900">{opp.title}</h5>
                                                {inPipeline && (
                                                  <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">
                                                    In Pipeline
                                                  </Badge>
                                                )}
                                              </div>
                                              {opp.awardMax && (
                                                <p className="text-sm text-emerald-600 font-semibold">
                                                  ${opp.awardMax.toLocaleString()}
                                                </p>
                                              )}
                                              {opp.deadlineAt && !opp.rolling && (
                                                <p className="text-xs text-slate-500">
                                                  Deadline: {new Date(opp.deadlineAt).toLocaleDateString()}
                                                </p>
                                              )}
                                              {opp.rolling && (
                                                <p className="text-xs text-blue-600">Rolling deadline</p>
                                              )}
                                            </div>
                                            <div className="flex items-center gap-2">
                                              {opp.url && (
                                                <Button
                                                  variant="ghost"
                                                  size="sm"
                                                  onClick={() => openWebsite(opp.url)}
                                                >
                                                  <ExternalLink className="w-4 h-4" />
                                                </Button>
                                              )}
                                              {inPipeline && grant ? (
                                                <Link to={createPageUrl("GrantDetail", { id: grant.id })}>
                                                  <Button size="sm" variant="outline">
                                                    <FileText className="w-4 h-4 mr-2" />
                                                    View in Pipeline
                                                  </Button>
                                                </Link>
                                              ) : (
                                                <Button
                                                  size="sm"
                                                  disabled={isAdding}
                                                  onClick={() => handleAddOpportunityToPipeline(opp)}
                                                  className="bg-blue-600 hover:bg-blue-700 text-white hover:text-white"
                                                >
                                                  {isAdding ? (
                                                    <>
                                                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                      Adding...
                                                    </>
                                                  ) : (
                                                    <>
                                                      <Plus className="w-4 h-4 mr-2" />
                                                      Add to Pipeline
                                                    </>
                                                  )}
                                                </Button>
                                              )}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </TableBody>
                </Table>

                {filteredSources.length === 0 && (
                  <div className="text-center py-12 text-slate-500">
                    <Target className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p className="font-semibold">No sources found</p>
                    <p className="text-sm mt-1">
                      {searchQuery || sourceTypeFilter !== 'all'
                        ? 'Try adjusting your filters'
                        : 'Use AI Discovery to find sources relevant to this profile'}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* AI Discovery Dialog */}
        <Dialog open={isDiscoverOpen} onOpenChange={setIsDiscoverOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-600" />
                AI Source Discovery
              </DialogTitle>
              <DialogDescription>
                Discover more funding sources for {selectedOrg?.name}
              </DialogDescription>
            </DialogHeader>

            <div className="py-4">
              <p className="text-sm text-slate-600 mb-4">
                AI will search for universities, service clubs, foundations, and other local organizations
                that offer funding in <strong>{selectedOrg?.city && selectedOrg?.state ? `${selectedOrg.city}, ${selectedOrg.state}` : selectedOrg?.state || 'your area'}</strong>.
              </p>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs text-blue-900">
                  💡 Discovery will run in the background (2-3 minutes). You can continue working!
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDiscoverOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => discoverMutation.mutate(selectedOrgId)}
                disabled={!selectedOrgId || discoverMutation.isPending}
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Start Discovery
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* NEW: Search for Source Dialog */}
        <Dialog open={isSearchOpen} onOpenChange={setIsSearchOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <SearchIcon className="w-5 h-5 text-emerald-600" />
                Search for Funding Source
              </DialogTitle>
              <DialogDescription>
                Enter a source name and AI will find all the details
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="source-name">Source Name *</Label>
                <Input
                  id="source-name"
                  placeholder="e.g., Cleveland Lions Club, Lee University"
                  value={searchSourceName}
                  onChange={(e) => setSearchSourceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !searchSourceMutation.isPending) {
                      handleSearchForSource();
                    }
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="location">Location (Optional)</Label>
                <Input
                  id="location"
                  placeholder={selectedOrg ? `${selectedOrg.city}, ${selectedOrg.state}` : "e.g., Cleveland, TN"}
                  value={searchLocation}
                  onChange={(e) => setSearchLocation(e.target.value)}
                />
                <p className="text-xs text-slate-500">
                  Leave blank to use profile location ({selectedOrg?.city}, {selectedOrg?.state})
                </p>
              </div>

              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <p className="text-xs text-emerald-900">
                  💡 AI will search the web to find:
                </p>
                <ul className="text-xs text-emerald-800 mt-2 space-y-1 ml-4">
                  <li>• Official website and scholarship pages</li>
                  <li>• Contact information (email, phone)</li>
                  <li>• Typical award amounts</li>
                  <li>• Eligibility requirements</li>
                  <li>• How to apply</li>
                </ul>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setIsSearchOpen(false);
                  setSearchSourceName('');
                  setSearchLocation('');
                }}
                disabled={searchSourceMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSearchForSource}
                disabled={!searchSourceName.trim() || searchSourceMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white hover:text-white"
              >
                {searchSourceMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <SearchIcon className="w-4 h-4 mr-2" />
                    Search
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>


        {/* Add/Edit Source Dialog */}
        <Dialog
          open={isAddOpen}
          onOpenChange={(open) => {
            setIsAddOpen(open);
            if (!open) {
              setEditingSource(null);
              setPrefilledSource(null);
            }
          }}
        >
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingSource ? 'Edit Source' : 'Add New Source'}
              </DialogTitle>
              <DialogDescription>
                {editingSource
                  ? 'Update the funding source details for this profile.'
                  : 'Add a new funding source to this profile’s directory.'}
              </DialogDescription>
            </DialogHeader>
            <AddSourceForm
              source={editingSource}
              prefill={prefilledSource}
              organizationId={selectedOrgId}
              onSuccess={() => {
                setIsAddOpen(false);
                setEditingSource(null);
                setPrefilledSource(null);
                queryClient.invalidateQueries({ queryKey: ['sourceDirectory'] });
                toast({
                  title: editingSource ? 'Source Updated' : 'Source Added',
                  description: editingSource ? 'The source has been updated.' : 'A new source has been added.',
                });
              }}
              onCancel={() => {
                setIsAddOpen(false);
                setEditingSource(null);
                setPrefilledSource(null);
              }}
            />
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm Deletion</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget?.type === 'single' && (
                  <>Are you sure you want to delete this source? This action cannot be undone and will also delete related opportunities and grants for this organization.</>
                )}
                {deleteTarget?.type === 'bulk' && (
                  <>Are you sure you want to delete {deleteTarget.ids?.length} selected sources? This action cannot be undone and will also delete related opportunities and grants for this organization.</>
                )}
                {deleteTarget?.type === 'by_source_type' && (
                  <>
                    Are you sure you want to delete all <strong>{deleteTarget.sourceType?.replace(/_/g, ' ')}</strong> sources
                    ({sourcesByType[deleteTarget.sourceType]?.length} total)? This action cannot be undone and will also delete related opportunities and grants for this organization.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteConfirm}
                className="bg-red-600 hover:bg-red-700 text-white hover:text-white"
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  'Delete'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
