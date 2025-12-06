import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Shield, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { callFunction } from "@/components/shared/functionClient";

export default function ImmuneActivityIndicator() {
  const { data, isLoading, isError, failureCount } = useQuery({
    queryKey: ['immuneVitals'],
    queryFn: async () => {
      try {
        // Use root-level function name (not subfolder path)
        const result = await callFunction('immuneGetVitals', {});
        
        console.log('[ImmuneActivityIndicator] Raw result:', result);
        
        // HARDENED: Handle both {ok, data} envelope and direct data
        if (!result) return null;
        if (result.ok === false) {
          console.warn('[ImmuneActivityIndicator] Function returned ok=false:', result.error);
          return null;
        }
        
        // Extract data - callFunction returns {ok, data} from immuneWrapper
        // The immuneGetVitals function returns { ok, worker, data: { health, ... } }
        // callFunction unwraps to { ok, data: { health, ... } }
        let vitalsData = result.data;
        
        // Handle double-wrapped case: { data: { health, ... } }
        if (vitalsData && vitalsData.data && typeof vitalsData.data.health !== 'undefined') {
          vitalsData = vitalsData.data;
        }
        
        // Guard: Ensure we have the health field (critical for rendering)
        if (!vitalsData || typeof vitalsData.health === 'undefined') {
          console.warn('[ImmuneActivityIndicator] Invalid vitals data structure:', vitalsData);
          return null;
        }
        
        return vitalsData;
      } catch (error) {
        // Handle rate limit gracefully
        if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
          console.warn('[ImmuneActivityIndicator] Rate limited, will retry with backoff');
          return null;
        }
        console.error('[ImmuneActivityIndicator] Error:', error);
        return null; // Return null instead of throwing to prevent UI crash
      }
    },
    refetchInterval: (query) => {
      // Stop polling on persistent errors
      if (query.state.error || query.state.data === null) {
        // Exponential backoff on failures: 2min, 5min, 10min, stop
        const backoffTimes = [120000, 300000, 600000];
        const backoff = backoffTimes[Math.min(failureCount, backoffTimes.length - 1)];
        return failureCount >= backoffTimes.length ? false : backoff;
      }
      return 60000; // Normal: refresh every minute
    },
    staleTime: 30000,
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
        <Shield className="w-4 h-4 animate-pulse" />
        <span>Immune...</span>
      </div>
    );
  }
  
  // FIXED: Handle error/no data gracefully
  if (isError || !data) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-400">
        <Shield className="w-4 h-4" />
        <span>Immune: N/A</span>
      </div>
    );
  }

  const { health, total_events_2h, runtime } = data;

  const healthColors = {
    green: 'text-emerald-600 bg-emerald-50',
    yellow: 'text-amber-600 bg-amber-50',
    red: 'text-red-600 bg-red-50',
  };

  const HealthIcon = {
    green: CheckCircle,
    yellow: AlertTriangle,
    red: XCircle,
  }[health] || Shield;

  const colorClass = healthColors[health] || healthColors.green;

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${colorClass}`}>
      <HealthIcon className="w-4 h-4" />
      <div className="flex flex-col">
        <span className="font-medium">
          {health === 'green' && 'Immune: Healthy'}
          {health === 'yellow' && `Immune: ${total_events_2h} alerts`}
          {health === 'red' && `Immune: ${total_events_2h} errors`}
        </span>
        {runtime?.sleep_mode && (
          <span className="text-slate-400 text-[10px]">Sleep mode</span>
        )}
      </div>
    </div>
  );
}