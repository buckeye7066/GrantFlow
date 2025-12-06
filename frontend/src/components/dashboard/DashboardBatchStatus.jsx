import React, { memo, useMemo } from 'react';
import { Loader2 } from 'lucide-react';

// Processing time constants
const SECONDS_PER_GRANT = 10;
const SECONDS_PER_MINUTE = 60;

const DashboardBatchStatus = memo(function DashboardBatchStatus({ batchProgress = {}, isBatchRunning = false }) {
  // Safe numeric extraction (before any conditional returns)
  const processed = typeof batchProgress?.processed === 'number' ? batchProgress.processed : 0;
  const failed = typeof batchProgress?.failed === 'number' ? batchProgress.failed : 0;
  const remaining = typeof batchProgress?.remaining === 'number' ? batchProgress.remaining : 0;

  // Memoized calculations (before conditional return)
  const { progressPercent, estimatedMinutes } = useMemo(() => {
    const total = processed + remaining;
    const percent = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
    const minutes = Math.ceil((remaining * SECONDS_PER_GRANT) / SECONDS_PER_MINUTE);
    return { progressPercent: percent, estimatedMinutes: minutes };
  }, [processed, remaining]);

  if (!isBatchRunning) return null;

  return (
    <div 
      className="mt-4 p-4 bg-white rounded-lg border border-emerald-200"
      role="region"
      aria-label="Batch processing status"
      aria-busy="true"
    >
      <h3 className="font-bold text-lg text-slate-900 mb-3 flex items-center gap-2">
        <Loader2 className="w-5 h-5 animate-spin text-emerald-600" aria-hidden="true" />
        Batch Processing Active
      </h3>
      <div className="grid grid-cols-3 gap-4 text-center" role="group" aria-label="Processing statistics">
        <div>
          <p className="text-2xl font-bold text-emerald-600">{processed}</p>
          <p className="text-xs text-slate-600">Processed</p>
        </div>
        <div>
          <p className={`text-2xl font-bold ${failed > 0 ? 'text-red-600' : 'text-slate-400'}`}>{failed}</p>
          <p className="text-xs text-slate-600">Failed</p>
        </div>
        <div>
          <p className="text-2xl font-bold text-blue-600">{remaining}</p>
          <p className="text-xs text-slate-600">Remaining</p>
        </div>
      </div>
      <div className="mt-3" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Batch progress">
        <div className="w-full bg-slate-200 rounded-full h-2">
          <div
            className="bg-gradient-to-r from-emerald-500 to-green-500 h-2 rounded-full transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
      <p className="text-xs text-slate-500 mt-2 text-center" role="status" aria-live="polite">
        Processing 1 grant every {SECONDS_PER_GRANT} seconds • Est. {estimatedMinutes} minute{estimatedMinutes !== 1 ? 's' : ''} remaining
      </p>
    </div>
  );
});

export default DashboardBatchStatus;