
import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Loader2, CheckCircle, AlertTriangle, Play, Clock, Activity } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import { Progress } from '@/components/ui/progress';

export default function OneTimeFix() {
  const [currentJobId, setCurrentJobId] = useState(null);
  const { toast } = useToast();

  const { data: grants, isLoading: isLoadingGrants, refetch: refetchGrants } = useQuery({
    queryKey: ['grantsToFix'],
    queryFn: () => client.entities.Grant.list(),
  });

  const { data: organizations, isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizationsForFix'],
    queryFn: () => client.entities.Organization.list(),
  });

  // Query for active backfill jobs
  const { data: activeJobs = [], refetch: refetchJobs } = useQuery({
    queryKey: ['backfillJobs'],
    queryFn: async () => {
      const allJobs = await client.entities.SearchJob.list('-created_date');
      return allJobs.filter(job => 
        job.profile_id?.startsWith('backfill_') && 
        job.status === 'running'
      );
    },
    refetchInterval: 5000, // Poll every 5 seconds for running jobs
  });

  // Get the most recent job (running or completed)
  const { data: latestJob, refetch: refetchLatestJob } = useQuery({
    queryKey: ['latestBackfillJob'],
    queryFn: async () => {
      const allJobs = await client.entities.SearchJob.list('-created_date');
      const backfillJobs = allJobs.filter(job => job.profile_id?.startsWith('backfill_'));
      return backfillJobs[0] || null;
    },
    refetchInterval: (query) => {
      const job = query.state?.data;
      return job?.status === 'running' ? 5000 : false;
    },
  });

  useEffect(() => {
    if (latestJob?.status === 'running') {
      setCurrentJobId(latestJob.id);
    }
  }, [latestJob]);

  const grantsNeedingProcessing = grants?.filter(grant => 
    !grant.ai_summary || grant.ai_status === 'idle' || grant.ai_status === 'error' || !grant.ai_status
  ) || [];

  const grantsAlreadyProcessed = grants?.filter(grant => 
    grant.ai_summary && grant.ai_status === 'ready'
  ) || [];

  const handleStartBackfill = async () => {
    try {
      const response = await client.functions.invoke('runGrantBackfill');
      
      setCurrentJobId(response.data.jobId);
      
      toast({
        title: "🚀 Backfill Started!",
        description: `Processing ${response.data.totalGrants} grants in the background. Estimated time: ${response.data.estimatedTime}.`,
      });

      // Start polling
      setTimeout(() => {
        refetchJobs();
        refetchLatestJob();
        refetchGrants();
      }, 2000);

    } catch (error) {
      console.error('Error starting backfill:', error);
      toast({
        variant: "destructive",
        title: "Failed to Start",
        description: error.message || "Could not start the backfill process. Please try again.",
      });
    }
  };

  const isRunning = activeJobs.length > 0 || latestJob?.status === 'running';
  
  // Parse job results
  let jobResults = null;
  if (latestJob?.results) {
    try {
      jobResults = JSON.parse(latestJob.results);
    } catch (e) {
      console.error('Failed to parse job results:', e);
    }
  }

  const progressPercent = latestJob?.status === 'running' 
    ? (latestJob.progress || 0) * 100 
    : latestJob?.status === 'done' 
    ? 100 
    : 0;

  return (
    <div className="p-8">
      <Card className="max-w-4xl mx-auto">
        <CardHeader>
          <CardTitle>Grant Data Backfill</CardTitle>
          <p className="text-slate-600 text-sm mt-2">
            Automatically populate AI Analysis and Requirements for all existing grants in your pipeline.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Status Overview */}
          <div className="grid grid-cols-3 gap-4">
            <Card className="bg-blue-50 border-blue-200">
              <CardContent className="pt-6">
                <div className="text-center">
                  <div className="text-3xl font-bold text-blue-900">
                    {grants?.length || 0}
                  </div>
                  <div className="text-sm text-blue-700 mt-1">Total Grants</div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-emerald-50 border-emerald-200">
              <CardContent className="pt-6">
                <div className="text-center">
                  <div className="text-3xl font-bold text-emerald-900">
                    {grantsAlreadyProcessed.length}
                  </div>
                  <div className="text-sm text-emerald-700 mt-1">Already Processed</div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-amber-50 border-amber-200">
              <CardContent className="pt-6">
                <div className="text-center">
                  <div className="text-3xl font-bold text-amber-900">
                    {grantsNeedingProcessing.length}
                  </div>
                  <div className="text-sm text-amber-700 mt-1">Need Processing</div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Job Status */}
          {isRunning && latestJob && (
            <Alert className="bg-blue-50 border-blue-200">
              <Activity className="h-4 w-4 text-blue-600 animate-pulse" />
              <AlertDescription className="text-blue-800">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <strong>⚡ Processing in Progress...</strong>
                    <Badge variant="outline" className="bg-blue-100">
                      {jobResults ? `${jobResults.processed || 0}/${jobResults.total || grantsNeedingProcessing.length}` : 'Starting...'}
                    </Badge>
                  </div>
                  <Progress value={progressPercent} className="h-2" />
                  <p className="text-xs text-blue-700">
                    {jobResults?.processed 
                      ? `Processed: ${jobResults.processed} | Failed: ${jobResults.failed || 0}` 
                      : 'Initializing...'
                    }
                  </p>
                  <p className="text-xs text-blue-600">
                    This page will auto-refresh. You can safely navigate away and come back later.
                  </p>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {latestJob?.status === 'done' && jobResults && (
            <Alert className="bg-green-50 border-green-200">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800">
                <strong>✅ Backfill Complete!</strong>
                <br />
                Successfully processed {jobResults.processed} grants. 
                {jobResults.failed > 0 && ` ${jobResults.failed} failed.`}
                <br />
                <span className="text-xs text-green-700">
                  Completed at {jobResults.completedAt ? new Date(jobResults.completedAt).toLocaleString() : 'just now'}
                </span>
              </AlertDescription>
            </Alert>
          )}

          {latestJob?.status === 'failed' && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>❌ Backfill Failed</strong>
                <br />
                {latestJob.error || 'An unknown error occurred.'}
              </AlertDescription>
            </Alert>
          )}

          {/* Action Section */}
          {grantsNeedingProcessing.length > 0 && !isRunning && latestJob?.status !== 'done' && (
            <Alert className="bg-blue-50 border-blue-200">
              <AlertTriangle className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800">
                <strong>Ready to Process:</strong> {grantsNeedingProcessing.length} grants need AI analysis and requirements extraction.
                <br />
                <strong>Estimated Time:</strong> {Math.ceil(grantsNeedingProcessing.length * 6 / 60)} minutes
                <br />
                <strong>Background Processing:</strong> Once started, you can navigate away from this page. The process will continue in the background.
              </AlertDescription>
            </Alert>
          )}

          {grantsNeedingProcessing.length === 0 && !isRunning && (
            <Alert className="bg-emerald-50 border-emerald-200">
              <CheckCircle className="h-4 w-4 text-emerald-600" />
              <AlertDescription className="text-emerald-800">
                <strong>All Done!</strong> All grants have been processed with AI analysis and requirements extraction.
              </AlertDescription>
            </Alert>
          )}

          {/* Start Button */}
          {grantsNeedingProcessing.length > 0 && !isRunning && (
            <div className="flex justify-center pt-4">
              <Button
                onClick={handleStartBackfill}
                disabled={isLoadingGrants || isLoadingOrgs}
                size="lg"
                className="bg-blue-600 hover:bg-blue-700 px-8"
              >
                <Play className="w-5 h-5 mr-2" />
                Start Background Backfill
              </Button>
            </div>
          )}

          {/* Grant Preview */}
          {grantsNeedingProcessing.length > 0 && (
            <div>
              <h3 className="font-semibold text-slate-700 mb-3">
                {isRunning ? 'Processing Grants:' : 'Grants to be Processed:'}
              </h3>
              <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
                {grantsNeedingProcessing.slice(0, 20).map(grant => (
                  <div key={grant.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-md border border-slate-200">
                    <p className="font-medium text-slate-800 truncate flex-1">{grant.title}</p>
                    <div className="flex items-center gap-2 ml-4">
                      {grant.ai_status === 'running' ? (
                        <>
                          <Loader2 className="w-4 h-4 text-blue-600 animate-spin flex-shrink-0" />
                          <span className="text-sm text-blue-600 whitespace-nowrap">Processing...</span>
                        </>
                      ) : grant.ai_summary && grant.ai_status === 'ready' ? (
                        <>
                          <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
                          <span className="text-sm text-green-600 whitespace-nowrap">Complete</span>
                        </>
                      ) : (
                        <>
                          <Clock className="w-4 h-4 text-slate-400 flex-shrink-0" />
                          <span className="text-sm text-slate-600 whitespace-nowrap">Pending</span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {grantsNeedingProcessing.length > 20 && (
                  <p className="text-sm text-slate-500 text-center pt-2">
                    ...and {grantsNeedingProcessing.length - 20} more grants
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Back to Pipeline */}
          <div className="pt-6 border-t">
            <Link to={createPageUrl('Pipeline')}>
              <Button variant="outline" className="w-full">
                Back to Pipeline
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
