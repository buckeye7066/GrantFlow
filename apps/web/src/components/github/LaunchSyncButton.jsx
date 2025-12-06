import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Rocket, Loader2, CheckCircle, AlertCircle, RefreshCw, Plus } from "lucide-react";
import { githubScheduledSync } from "@/api/functions";
import { getAllFunctionCodes } from "@/api/functions";

// Sync interval: 5 minutes
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * "Christen the Ship" Launch Button
 * Supports multiple concurrent syncs
 */
export default function LaunchSyncButton({ onComplete }) {
  const [status, setStatus] = useState('idle'); // idle, loading, active
  const [result, setResult] = useState(null);
  const [runningSyncs, setRunningSyncs] = useState(0); // Track concurrent syncs
  const [lastSync, setLastSync] = useState(null);
  const [nextSync, setNextSync] = useState(null);

  // Check if sync is already active (persisted in localStorage)
  useEffect(() => {
    const syncActive = localStorage.getItem('github_sync_active');
    const lastSyncTime = localStorage.getItem('github_last_sync');
    
    if (syncActive === 'true') {
      setStatus('active');
      if (lastSyncTime) {
        setLastSync(new Date(lastSyncTime));
      }
    }
  }, []);

  // Auto-sync interval when active
  useEffect(() => {
    if (status !== 'active') return;

    const runSync = async () => {
      try {
        console.log('[LaunchSyncButton] Running scheduled sync...');
        await performSync(true); // silent mode
      } catch (err) {
        console.error('[LaunchSyncButton] Scheduled sync error:', err);
      }
    };

    // Run immediately if no recent sync
    const lastSyncTime = localStorage.getItem('github_last_sync');
    if (!lastSyncTime || Date.now() - new Date(lastSyncTime).getTime() > SYNC_INTERVAL_MS) {
      runSync();
    }

    // Set up interval
    const interval = setInterval(runSync, SYNC_INTERVAL_MS);
    setNextSync(new Date(Date.now() + SYNC_INTERVAL_MS));

    return () => clearInterval(interval);
  }, [status]);

  const performSync = async (silent = false) => {
    setRunningSyncs(prev => prev + 1);
    if (!silent) setStatus('loading');

    try {
      const codesResponse = await getAllFunctionCodes();
      
      if (!codesResponse.data?.ok || !codesResponse.data?.data?.files) {
        throw new Error('Failed to fetch function codes');
      }

      const functionFiles = codesResponse.data.data.files;
      
      if (!functionFiles.length) {
        throw new Error('No function files found');
      }

      const syncResponse = await githubScheduledSync({
        files: functionFiles.map(f => ({
          path: f.path || f,
          content: f.content || ''
        })).filter(f => f.content)
      });

      const now = new Date();
      localStorage.setItem('github_last_sync', now.toISOString());
      localStorage.setItem('github_sync_active', 'true');
      setLastSync(now);
      setNextSync(new Date(Date.now() + SYNC_INTERVAL_MS));

      if (syncResponse.data?.ok || syncResponse.data?.data?.skipped) {
        if (!silent) {
          setStatus('active');
          setResult(syncResponse.data.data);
          onComplete?.(syncResponse.data.data);
        }
        return syncResponse.data.data;
      } else {
        throw new Error(syncResponse.data?.error || 'Sync failed');
      }

    } catch (err) {
      if (!silent) {
        setStatus('error');
        setResult({ error: err.message });
      }
      throw err;
    } finally {
      setRunningSyncs(prev => Math.max(0, prev - 1));
    }
  };

  const handleLaunch = () => performSync(false);

  const stopSync = () => {
    localStorage.removeItem('github_sync_active');
    localStorage.removeItem('github_last_sync');
    setStatus('idle');
    setResult(null);
    setLastSync(null);
    setNextSync(null);
  };

  const formatTime = (date) => {
    if (!date) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Active state - sync is running automatically
  if (status === 'active') {
    return (
      <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span className="text-sm font-medium text-green-700">Auto-Sync Active</span>
          {runningSyncs > 0 && (
            <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
              {runningSyncs} running
            </span>
          )}
        </div>
        <div className="text-xs text-green-600">
          {lastSync && <span>Last: {formatTime(lastSync)}</span>}
          {nextSync && <span className="ml-2">Next: {formatTime(nextSync)}</span>}
        </div>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={() => performSync(false)}
          className="text-green-700 hover:text-green-800 h-7 px-2"
          title="Run additional sync"
        >
          <Plus className="w-3 h-3 mr-1" />
          <RefreshCw className={`w-3 h-3 ${runningSyncs > 0 ? 'animate-spin' : ''}`} />
        </Button>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={stopSync}
          className="text-green-700 hover:text-red-600 h-7 px-2"
        >
          Stop
        </Button>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-red-600">
          <AlertCircle className="w-5 h-5" />
          <span className="text-sm">{result?.error || 'Sync failed'}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleLaunch}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Button 
      onClick={handleLaunch} 
      disabled={status === 'loading'}
      className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 gap-2"
    >
      {status === 'loading' ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          Launching...
        </>
      ) : (
        <>
          <Rocket className="w-4 h-4" />
          Launch Sync
        </>
      )}
    </Button>
  );
}