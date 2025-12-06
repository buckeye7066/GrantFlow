import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, Play, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * QueueStatusPanel - Shows background processing queue status
 */
export default function QueueStatusPanel({ autoRefresh = true, refreshInterval = 10000 }) {
  const [stats, setStats] = useState(null);
  const [lockStatus, setLockStatus] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const { toast } = useToast();

  const fetchStats = async () => {
    setIsLoading(true);
    try {
      const response = await base44.functions.invoke('backgroundWorker', { body: { action: 'stats' } });
      const data = response?.data;
      if (data?.success) {
        setStats(data.stats);
      }
    } catch (error) {
      console.error('[QueueStatusPanel] Failed to fetch stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const triggerWorker = async () => {
    setIsTriggering(true);
    try {
      const response = await base44.functions.invoke('autoMonitor', { body: {} });
      const data = response?.data;
      
      if (data?.success) {
        toast({
          title: 'Worker Triggered',
          description: data.worker?.message || 'Background worker executed.'
        });
        setStats(data.stats);
        setLockStatus(data.lock);
      }
    } catch (error) {
      console.error('[QueueStatusPanel] Failed to trigger worker:', error);
      toast({
        variant: 'destructive',
        title: 'Trigger Failed',
        description: error?.message || 'Failed to trigger background worker.'
      });
    } finally {
      setIsTriggering(false);
    }
  };

  const cleanupOldJobs = async () => {
    try {
      const response = await base44.functions.invoke('backgroundWorker', { 
        body: {
          action: 'cleanup', 
          hours: 24 
        }
      });
      const data = response?.data;
      
      if (data?.success) {
        toast({
          title: 'Cleanup Complete',
          description: `Removed ${data.deleted || 0} old jobs.`
        });
        fetchStats();
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Cleanup Failed',
        description: error?.message || 'Failed to cleanup old jobs.'
      });
    }
  };

  useEffect(() => {
    fetchStats();
    
    if (autoRefresh) {
      const interval = setInterval(fetchStats, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, refreshInterval]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Processing Queue</CardTitle>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchStats}
              disabled={isLoading}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {stats ? (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-3 text-center">
              <div className="p-3 bg-amber-50 rounded-lg">
                <p className="text-2xl font-bold text-amber-600">{stats.pending}</p>
                <p className="text-xs text-amber-700">Pending</p>
              </div>
              <div className="p-3 bg-blue-50 rounded-lg">
                <p className="text-2xl font-bold text-blue-600">{stats.running}</p>
                <p className="text-xs text-blue-700">Running</p>
              </div>
              <div className="p-3 bg-green-50 rounded-lg">
                <p className="text-2xl font-bold text-green-600">{stats.completed}</p>
                <p className="text-xs text-green-700">Completed</p>
              </div>
              <div className="p-3 bg-red-50 rounded-lg">
                <p className="text-2xl font-bold text-red-600">{stats.failed}</p>
                <p className="text-xs text-red-700">Failed</p>
              </div>
            </div>

            {lockStatus && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-500">Lock:</span>
                <Badge variant={lockStatus.locked ? 'secondary' : 'outline'}>
                  {lockStatus.locked ? `Held by ${lockStatus.locked_by?.slice(0,8)}` : 'Free'}
                </Badge>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={triggerWorker}
                disabled={isTriggering}
                size="sm"
                className="flex-1"
              >
                {isTriggering ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Run Worker Now
                  </>
                )}
              </Button>
              <Button
                onClick={cleanupOldJobs}
                variant="outline"
                size="sm"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Cleanup
              </Button>
            </div>

            <p className="text-xs text-slate-500 text-center">
              Background worker runs automatically every 20 seconds
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}