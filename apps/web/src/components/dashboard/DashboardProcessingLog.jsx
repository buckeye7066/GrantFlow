import React, { memo, useMemo, useCallback } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

// Action type constants
const ACTION = {
  COMPLETED: 'completed',
  NEEDS_REVIEW: 'needs_review',
  QUEUED: 'queued',
};

const DashboardProcessingLog = memo(function DashboardProcessingLog({ processingLog = [], onClear }) {
  const safeLogs = useMemo(() => (Array.isArray(processingLog) ? processingLog : []), [processingLog]);

  const handleClear = useCallback(() => {
    if (typeof onClear === 'function') {
      onClear();
    }
  }, [onClear]);

  if (safeLogs.length === 0) return null;

  const firstLog = safeLogs[0];
  const borderClass = firstLog?.error
    ? 'border-red-300 bg-red-50'
    : firstLog?.action === ACTION.NEEDS_REVIEW
      ? 'border-amber-300 bg-amber-50'
      : 'border-green-300 bg-green-50';

  return (
    <Card className={`border-2 ${borderClass}`} role="log" aria-label="Processing log">
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-900">Last Automation Run</h3>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={handleClear}
            aria-label="Clear processing log"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>

        {safeLogs.map((log, idx) => {
          const logKey = log?.grantId || log?.grant || `log-${idx}`;
          return (
          <div key={logKey} className="space-y-3">
            {log?.error ? (
              <Alert variant="destructive" className="bg-red-100 border-red-300">
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                <AlertDescription>
                  <div className="space-y-2">
                    <p className="font-semibold text-lg">
                      ❌ Fatal Error: {log.where || 'scheduledAutomation'}
                    </p>
                    <p className="text-sm">
                      <strong>Message:</strong> {log.message || 'Unknown error'}
                    </p>
                    {log.stack && (
                      <details className="text-xs mt-2">
                        <summary className="cursor-pointer font-semibold">Stack Trace</summary>
                        <pre className="mt-2 p-2 bg-red-200 rounded overflow-x-auto whitespace-pre-wrap">
                          {log.stack}
                        </pre>
                      </details>
                    )}
                    <p className="text-xs text-red-800 mt-2">
                      💡 Check browser console for full diagnostic logs
                    </p>
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-base">{log?.grant || 'Unknown Grant'}</p>
                  <div className="flex items-center gap-3">
                    {log?.action === ACTION.COMPLETED && (
                      <span className="text-green-600 font-semibold">
                        ✨ {log.totalMinutes ?? 0} min billed
                      </span>
                    )}
                    <span className="text-slate-600 text-sm">
                      {log?.remaining ?? 0} remaining
                    </span>
                  </div>
                </div>

                {Array.isArray(log?.stages) && log.stages.length > 0 && (
                  <div className="space-y-2" role="list" aria-label="Processing stages">
                    {log.stages.map((stage, sIdx) => {
                      const stageKey = `${stage?.from}-${stage?.to}-${sIdx}`;
                      return (
                      <div key={stageKey} className={`p-3 rounded-lg border ${
                        stage?.success
                          ? 'bg-green-50 border-green-300'
                          : 'bg-red-50 border-red-300'
                      }`} role="listitem">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium">
                            {stage?.success ? '✓' : '❌'} {stage?.from || '?'} → {stage?.to || '?'}
                          </p>
                          {stage?.success && (
                            <span className="text-xs text-green-700">
                              {stage.minutes ?? 0} min
                            </span>
                          )}
                        </div>
                        {stage?.error && (
                          <p className="text-xs text-red-600 mt-1">
                            Error: {stage.error}
                          </p>
                        )}
                      </div>
                    )})}
                  </div>
                )}

                {log?.action === ACTION.NEEDS_REVIEW && (
                  <Alert className="bg-amber-100 border-amber-300">
                    <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
                    <AlertDescription className="text-amber-900">
                      <strong>Manual review required</strong> - Grant failed at "{log.failedStage || 'unknown stage'}" after 3 retry attempts.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </div>
        )})}
      </CardContent>
    </Card>
  );
});

export default DashboardProcessingLog;