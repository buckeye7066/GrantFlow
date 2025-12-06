import React, { memo, useMemo, useCallback } from 'react';
import { Loader2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

// Status constants
const STATUS = {
  DISCOVERED: 'discovered',
  INTERESTED: 'interested',
  DRAFTING: 'drafting',
  APPLICATION_PREP: 'application_prep',
  REVISION: 'revision',
};

// Helper to get field from either root or nested data (SDK returns data in nested 'data' object)
const getField = (g, field) => {
  if (!g) return undefined;
  if (g[field] !== undefined) return g[field];
  if (g.data && g.data[field] !== undefined) return g.data[field];
  return undefined;
};

// Status display config
const STATUS_CONFIG = [
  { key: STATUS.DISCOVERED, label: 'Discovered', borderClass: 'border-blue-200', textClass: 'text-blue-600' },
  { key: STATUS.INTERESTED, label: 'Interested', borderClass: 'border-purple-200', textClass: 'text-purple-600' },
  { key: STATUS.DRAFTING, label: 'Drafting', borderClass: 'border-amber-200', textClass: 'text-amber-600' },
  { key: STATUS.APPLICATION_PREP, label: 'App Prep', borderClass: 'border-orange-200', textClass: 'text-orange-600' },
  { key: STATUS.REVISION, label: 'Revision', borderClass: 'border-green-200', textClass: 'text-green-600' },
];

const DashboardAutomationPanel = memo(function DashboardAutomationPanel({
  grants = [],
  grantsToProcess = [],
  isRunning = false,
  isBatchRunning = false,
  monitoringActive = false,
  onRunAutomation,
  onBatchProcess,
  onStopBatch,
  onToggleMonitoring,
}) {
  // Safe arrays
  const safeGrants = useMemo(() => (Array.isArray(grants) ? grants : []), [grants]);
  const safeGrantsToProcess = useMemo(() => (Array.isArray(grantsToProcess) ? grantsToProcess : []), [grantsToProcess]);

  // Memoized status counts - check both root and nested data for status
  const statusCounts = useMemo(() => {
    const counts = {};
    STATUS_CONFIG.forEach(({ key }) => {
      counts[key] = safeGrants.filter(g => {
        const status = getField(g, 'status');
        return status === key;
      }).length;
    });
    return counts;
  }, [safeGrants]);

  // Validated handlers
  const handleRunAutomation = useCallback(() => {
    if (typeof onRunAutomation === 'function') {
      onRunAutomation();
    } else {
      console.warn('[DashboardAutomationPanel] onRunAutomation is not a function');
    }
  }, [onRunAutomation]);

  const handleBatchProcess = useCallback((e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    console.log('[DashboardAutomationPanel] Process All clicked!', { onBatchProcess: typeof onBatchProcess });
    if (typeof onBatchProcess === 'function') {
      onBatchProcess();
    } else {
      console.error('[DashboardAutomationPanel] onBatchProcess is not a function');
    }
  }, [onBatchProcess]);

  const handleStopBatch = useCallback(() => {
    if (typeof onStopBatch === 'function') {
      onStopBatch();
    }
  }, [onStopBatch]);

  const handleToggleMonitoring = useCallback(() => {
    if (typeof onToggleMonitoring === 'function') {
      onToggleMonitoring();
    }
  }, [onToggleMonitoring]);

  if (safeGrants.length === 0) return null;

  return (
    <Card 
      className="border-2 border-blue-500 shadow-lg bg-gradient-to-br from-blue-50 to-purple-50"
      role="region"
      aria-label="Grant automation controls"
    >
      <CardContent className="p-8">
        <div className="text-center space-y-4">
          <Zap className="w-12 h-12 mx-auto text-blue-600" aria-hidden="true" />
          <h2 className="text-2xl font-bold text-slate-900">
            Self-Healing Automation v4.0
          </h2>
          <p className="text-slate-700">
            Atomic locking • Zero ambiguity • Full diagnostics
          </p>

          <div className="grid md:grid-cols-5 gap-3 max-w-4xl mx-auto" role="group" aria-label="Grant status counts">
            {STATUS_CONFIG.map(({ key, label, borderClass, textClass }) => (
              <div key={key} className={`p-3 bg-white rounded-lg border ${borderClass}`}>
                <p className="text-xs text-slate-600 mb-1">{label}</p>
                <p className={`text-2xl font-bold ${textClass}`}>{statusCounts[key] ?? 0}</p>
              </div>
            ))}
          </div>

          <div className="flex justify-center gap-3 flex-wrap">
            <Button
              onClick={handleRunAutomation}
              disabled={isRunning || safeGrantsToProcess.length === 0 || isBatchRunning}
              size="lg"
              className={`text-lg px-8 py-6 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 ${isRunning ? 'opacity-75' : ''}`}
              aria-busy={isRunning}
              aria-label={isRunning ? 'Processing pipeline' : `Process next grant, ${safeGrantsToProcess.length} remaining`}
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-6 h-6 mr-2 animate-spin" aria-hidden="true" />
                  Processing Pipeline...
                </>
              ) : safeGrantsToProcess.length === 0 ? (
                <>
                  <Zap className="w-6 h-6 mr-2" aria-hidden="true" />
                  No Eligible Grants ({safeGrants.length} total)
                </>
              ) : (
                <>
                  <Zap className="w-6 h-6 mr-2" aria-hidden="true" />
                  Process Next Grant ({safeGrantsToProcess.length} remaining)
                </>
              )}
            </Button>

            {!isBatchRunning ? (
              <Button
                type="button"
                onClick={handleBatchProcess}
                disabled={isRunning || safeGrantsToProcess.length === 0}
                size="lg"
                className="text-lg px-6 py-6 bg-green-600 hover:bg-green-700 cursor-pointer"
                aria-label={`Process all ${safeGrantsToProcess.length} grants`}
              >
                <Zap className="w-6 h-6 mr-2" aria-hidden="true" />
                Process All ({safeGrantsToProcess.length})
              </Button>
            ) : (
              <Button
                onClick={handleStopBatch}
                size="lg"
                variant="destructive"
                className="text-lg px-6 py-6"
                aria-label="Stop batch processing"
              >
                🛑 Stop Batch
              </Button>
            )}

            <Button
              onClick={handleToggleMonitoring}
              disabled={isBatchRunning || isRunning}
              size="lg"
              variant={monitoringActive ? "destructive" : "outline"}
              className={`text-lg px-6 py-6 ${monitoringActive ? 'opacity-90' : ''}`}
              aria-pressed={monitoringActive}
              aria-label={monitoringActive ? 'Disable auto-monitoring' : 'Enable auto-monitoring'}
            >
              {monitoringActive ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" aria-hidden="true" />
                  Monitoring Active
                </>
              ) : (
                '🔍 Enable Auto-Monitor'
              )}
            </Button>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-slate-600">
              • Check console logs for full diagnostics on every run
            </p>
            {monitoringActive && (
              <p className="text-sm text-purple-600 font-semibold" role="status" aria-live="polite">
                🔍 Monitoring active: Checks every 5 minutes
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});

export default DashboardAutomationPanel;