import React from 'react';
import { CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';

/**
 * Status banner for backfill operations
 */
export default function BackfillStatusBanner({ status }) {
  if (status === 'idle') return null;

  if (status === 'running') {
    return (
      <div className="flex items-center gap-2 p-4 bg-blue-50 text-blue-800 rounded-md">
        <Loader2 className="w-5 h-5 animate-spin" />
        <p>Backfill in progress...</p>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="flex items-center gap-2 p-4 bg-green-50 text-green-800 rounded-md">
        <CheckCircle className="w-5 h-5" />
        <p>Backfill completed successfully!</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-2 p-4 bg-red-50 text-red-800 rounded-md">
        <AlertTriangle className="w-5 h-5" />
        <p>The backfill process encountered an error. Check the logs for details.</p>
      </div>
    );
  }

  return null;
}