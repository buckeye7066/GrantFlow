import React from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Play, AlertTriangle, CheckCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';

// Components
import StatusCard from '@/components/backfill/StatusCard';
import BackfillJobAlert from '@/components/backfill/BackfillJobAlert';
import GrantStatusPreview from '@/components/backfill/GrantStatusPreview';

// Hooks
import { useBackfillData } from '@/components/hooks/useBackfillData';

export default function OneTimeFix() {
  const { toast } = useToast();
  
  const {
    grants,
    grantsNeedingProcessing,
    grantsAlreadyProcessed,
    latestJob,
    jobResults,
    progressPercent,
    isRunning,
    isLoading,
    setCurrentJobId,
    refetchGrants,
    refetchJobs,
    refetchLatestJob,
  } = useBackfillData();

  const handleStartBackfill = async () => {
    try {
      const response = await base44.functions.invoke('runGrantBackfill');
      
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

  const estimatedMinutes = Math.ceil(grantsNeedingProcessing.length * 6 / 60);

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
            <StatusCard 
              label="Total Grants" 
              count={grants?.length || 0} 
              color="blue" 
            />
            <StatusCard 
              label="Already Processed" 
              count={grantsAlreadyProcessed.length} 
              color="emerald" 
            />
            <StatusCard 
              label="Need Processing" 
              count={grantsNeedingProcessing.length} 
              color="amber" 
            />
          </div>

          {/* Job Status Alert */}
          <BackfillJobAlert
            latestJob={latestJob}
            jobResults={jobResults}
            progressPercent={progressPercent}
            isRunning={isRunning}
            totalGrants={grantsNeedingProcessing.length}
          />

          {/* Ready to Process Alert */}
          {grantsNeedingProcessing.length > 0 && !isRunning && latestJob?.status !== 'done' && (
            <Alert className="bg-blue-50 border-blue-200">
              <AlertTriangle className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800">
                <strong>Ready to Process:</strong> {grantsNeedingProcessing.length} grants need AI analysis and requirements extraction.
                <br />
                <strong>Estimated Time:</strong> {estimatedMinutes} minutes
                <br />
                <strong>Background Processing:</strong> Once started, you can navigate away from this page. The process will continue in the background.
              </AlertDescription>
            </Alert>
          )}

          {/* All Done Alert */}
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
                disabled={isLoading}
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
            <GrantStatusPreview 
              grants={grantsNeedingProcessing} 
              isRunning={isRunning} 
            />
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