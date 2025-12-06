import React from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Activity, CheckCircle, AlertTriangle } from 'lucide-react';

/**
 * Alert component showing backfill job status
 */
export default function BackfillJobAlert({ latestJob, jobResults, progressPercent, isRunning, totalGrants }) {
  if (!latestJob) return null;

  // Running state
  if (isRunning) {
    return (
      <Alert className="bg-blue-50 border-blue-200">
        <Activity className="h-4 w-4 text-blue-600 animate-pulse" />
        <AlertDescription className="text-blue-800">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <strong>⚡ Processing in Progress...</strong>
              <Badge variant="outline" className="bg-blue-100">
                {jobResults 
                  ? `${jobResults.processed || 0}/${jobResults.total || totalGrants}` 
                  : 'Starting...'}
              </Badge>
            </div>
            <Progress value={progressPercent} className="h-2" />
            <p className="text-xs text-blue-700">
              {jobResults?.processed 
                ? `Processed: ${jobResults.processed} | Failed: ${jobResults.failed || 0}` 
                : 'Initializing...'}
            </p>
            <p className="text-xs text-blue-600">
              This page will auto-refresh. You can safely navigate away and come back later.
            </p>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  // Completed state
  if (latestJob.status === 'done' && jobResults) {
    return (
      <Alert className="bg-green-50 border-green-200">
        <CheckCircle className="h-4 w-4 text-green-600" />
        <AlertDescription className="text-green-800">
          <strong>✅ Backfill Complete!</strong>
          <br />
          Successfully processed {jobResults.processed} grants.
          {jobResults.failed > 0 && ` ${jobResults.failed} failed.`}
          <br />
          <span className="text-xs text-green-700">
            Completed at {jobResults.completedAt 
              ? new Date(jobResults.completedAt).toLocaleString() 
              : 'just now'}
          </span>
        </AlertDescription>
      </Alert>
    );
  }

  // Failed state
  if (latestJob.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>❌ Backfill Failed</strong>
          <br />
          {latestJob.error || 'An unknown error occurred.'}
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}