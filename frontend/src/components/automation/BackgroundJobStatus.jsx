import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function BackgroundJobStatus({ jobId, onComplete }) {
  const completedRef = React.useRef(false);
  // FIXED: Reset completedRef when jobId changes
  React.useEffect(() => {
    completedRef.current = false;
  }, [jobId]);

  const { data: status, error, isLoading } = useQuery({
    queryKey: ['jobStatus', jobId],
    queryFn: async () => {
      if (!jobId) return null;
      try {
        const response = await base44.functions.invoke('getBackgroundJobStatus', { body: { job_id: jobId } });
        return response.data;
      } catch (err) {
        console.error('[BackgroundJobStatus] Failed to fetch job status:', err);
        throw err;
      }
    },
    refetchInterval: (query) => {
      const jobStatus = query.state.data?.status;
      // FIXED: Stop polling when completed or failed
      if (jobStatus === 'completed' || jobStatus === 'failed' || jobStatus === 'error') {
        return false;
      }
      return 2000; // Poll every 2 seconds while running
    },
    enabled: !!jobId,
    retry: 2,
    retryDelay: 1000,
  });

  // Handle completion callback - FIXED: Better completion detection
  React.useEffect(() => {
    if (!status) return;
    
    const isFinished = status.status === 'completed' || status.status === 'failed' || status.status === 'error';
    
    if (isFinished && !completedRef.current) {
      completedRef.current = true;
      console.log('[BackgroundJobStatus] Job finished:', status.status);
      if (onComplete) {
        // Delay slightly to allow UI to update
        setTimeout(() => onComplete(status), 500);
      }
    }
  }, [status, onComplete]);

  if (error) {
    return (
      <Alert className="mb-6 bg-red-50 border-red-200">
        <XCircle className="h-4 w-4 text-red-600" />
        <AlertDescription className="text-red-900">
          <strong>Error fetching job status:</strong> {error.message}
        </AlertDescription>
      </Alert>
    );
  }

  if (isLoading || !status) {
    return (
      <Alert className="mb-6 bg-blue-50 border-blue-200">
        <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
        <AlertDescription className="text-blue-900">
          <strong>Loading job status...</strong>
        </AlertDescription>
      </Alert>
    );
  }

  const { 
    status: jobStatus, 
    progress = 0, 
    total_grants = 0, 
    grants_processed = 0, 
    current_operation, 
    current_grant_title, 
    error: jobError, 
    results 
  } = status;

  const getIcon = () => {
    switch (jobStatus) {
      case 'running':
      case 'queued':
        return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />;
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-green-600" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-600" />;
      default:
        return <AlertTriangle className="h-4 w-4 text-yellow-600" />;
    }
  };

  const getAlertClass = () => {
    switch (jobStatus) {
      case 'running':
      case 'queued':
        return 'bg-blue-50 border-blue-200';
      case 'completed':
        return 'bg-green-50 border-green-200';
      case 'failed':
        return 'bg-red-50 border-red-200';
      default:
        return '';
    }
  };

  const percentage = total_grants > 0 ? Math.round(progress * 100) : 0;

  return (
    <Alert className={`mb-6 ${getAlertClass()}`}>
      {getIcon()}
      <AlertDescription>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <strong>
                {jobStatus === 'running' && '🚀 Background Job Running'}
                {jobStatus === 'queued' && '⏳ Background Job Queued'}
                {jobStatus === 'completed' && '✅ Job Complete'}
                {jobStatus === 'failed' && '❌ Job Failed'}
              </strong>
              <p className="text-sm mt-1">
                {current_operation}
              </p>
              {current_grant_title && <p className="text-xs text-gray-500 truncate">{current_grant_title}</p>}
            </div>
            <Badge variant={jobStatus === 'completed' ? 'default' : 'outline'}>
              {grants_processed} / {total_grants}
            </Badge>
          </div>

          {(jobStatus === 'running' || jobStatus === 'queued') && (
            <Progress value={percentage} className="h-2" />
          )}

          {jobStatus === 'failed' && jobError && (
            <div className="mt-2 text-xs text-red-700 bg-red-100 p-2 rounded">
              <strong>Error:</strong> {jobError}
            </div>
          )}

          {jobStatus === 'completed' && (
             <div className="mt-2 text-xs text-green-700 bg-green-100 p-2 rounded">
              <strong>Results:</strong> Analyzed: {results?.analyzed ?? 0}, Advanced: {results?.advanced ?? 0}, Billable Time: {results?.totalMinutes ?? 0} mins
              {results?.message && <span className="block mt-1 text-green-600">{results.message}</span>}
              {results?.grantsProcessed !== undefined && (
                <span className="block mt-1">Processed: {results.grantsProcessed} of {results.totalEligible} eligible grants</span>
              )}
            </div>
          )}

        </div>
      </AlertDescription>
    </Alert>
  );
}