import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

/**
 * Custom hook for managing grant backfill data and job status
 */
export function useBackfillData() {
  const [currentJobId, setCurrentJobId] = useState(null);

  // Fetch all grants
  const { data: grants, isLoading: isLoadingGrants, refetch: refetchGrants } = useQuery({
    queryKey: ['grantsToFix'],
    queryFn: () => base44.entities.Grant.list(),
  });

  // Fetch organizations
  const { data: organizations, isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizationsForFix'],
    queryFn: () => base44.entities.Organization.list(),
  });

  // Query for active backfill jobs
  const { data: activeJobs = [], refetch: refetchJobs } = useQuery({
    queryKey: ['backfillJobs'],
    queryFn: async () => {
      const allJobs = await base44.entities.SearchJob.list('-created_date');
      return allJobs.filter(job => 
        job.profile_id?.startsWith('backfill_') && 
        job.status === 'running'
      );
    },
    refetchInterval: 5000,
  });

  // Get the most recent job
  const { data: latestJob, refetch: refetchLatestJob } = useQuery({
    queryKey: ['latestBackfillJob'],
    queryFn: async () => {
      const allJobs = await base44.entities.SearchJob.list('-created_date');
      const backfillJobs = allJobs.filter(job => job.profile_id?.startsWith('backfill_'));
      return backfillJobs[0] || null;
    },
    refetchInterval: (query) => {
      const job = query.state?.data;
      return job?.status === 'running' ? 5000 : false;
    },
  });

  // Update current job ID when latest job changes
  useEffect(() => {
    if (latestJob?.status === 'running') {
      setCurrentJobId(latestJob.id);
    }
  }, [latestJob]);

  // Memoized grant filtering
  const grantsNeedingProcessing = useMemo(() => 
    grants?.filter(grant => 
      !grant.ai_summary || 
      grant.ai_status === 'idle' || 
      grant.ai_status === 'error' || 
      !grant.ai_status
    ) || [],
    [grants]
  );

  const grantsAlreadyProcessed = useMemo(() =>
    grants?.filter(grant => 
      grant.ai_summary && grant.ai_status === 'ready'
    ) || [],
    [grants]
  );

  // Parse job results
  const jobResults = useMemo(() => {
    if (!latestJob?.results) return null;
    try {
      return JSON.parse(latestJob.results);
    } catch (e) {
      console.error('Failed to parse job results:', e);
      return null;
    }
  }, [latestJob]);

  // Calculate progress
  const progressPercent = useMemo(() => {
    if (latestJob?.status === 'running') {
      return (latestJob.progress || 0) * 100;
    }
    if (latestJob?.status === 'done') {
      return 100;
    }
    return 0;
  }, [latestJob]);

  const isRunning = activeJobs.length > 0 || latestJob?.status === 'running';
  const isLoading = isLoadingGrants || isLoadingOrgs;

  return {
    grants,
    organizations,
    grantsNeedingProcessing,
    grantsAlreadyProcessed,
    latestJob,
    jobResults,
    progressPercent,
    isRunning,
    isLoading,
    currentJobId,
    setCurrentJobId,
    refetchGrants,
    refetchJobs,
    refetchLatestJob,
  };
}