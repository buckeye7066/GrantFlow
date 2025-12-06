import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Clock, Play, Pause, StopCircle, Zap } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

/**
 * IdleTimeTracker - Automatic time tracking with idle detection
 * Tracks all user work time and logs billable entries
 */
export default function IdleTimeTracker({ organizationId }) {
  const [isTracking, setIsTracking] = useState(false);
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [currentActivity, setCurrentActivity] = useState('Working on grants');
  const [lastActivityTime, setLastActivityTime] = useState(Date.now());
  const [isPaused, setIsPaused] = useState(false);
  
  const startTimeRef = useRef(null);
  const intervalRef = useRef(null);
  const idleCheckRef = useRef(null);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Get automation settings for idle timeout
  const { data: settings } = useQuery({
    queryKey: ['automationSettings', organizationId],
    queryFn: async () => {
      if (!organizationId) return null;
      const allSettings = await base44.entities.AutomationSettings.filter({ 
        organization_id: organizationId 
      });
      return allSettings[0] || null;
    },
    enabled: !!organizationId
  });

  const idleTimeoutMs = (settings?.idle_timeout_minutes || 5) * 60 * 1000;

  // Save time entry mutation
  const saveTimeMutation = useMutation({
    mutationFn: async ({ minutes, note }) => {
      const user = await base44.auth.me();
      const now = new Date();
      
      return await base44.entities.TimeEntry.create({
        organization_id: organizationId,
        user_id: user.id,
        task_category: 'General Work',
        start_at: new Date(now.getTime() - minutes * 60 * 1000).toISOString(),
        end_at: now.toISOString(),
        raw_minutes: minutes,
        rounded_minutes: Math.ceil(minutes / 6) * 6, // Round to 6-minute increments
        note: note || currentActivity,
        source: 'manual', // User-initiated tracking
        invoiced: false
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['recentTimeEntries'] });
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      
      toast({
        title: '⏱️ Time Logged',
        description: `${data.rounded_minutes} minutes recorded for billing`,
      });
    }
  });

  // Track user activity
  useEffect(() => {
    if (!isTracking || isPaused) return;

    const handleActivity = () => {
      setLastActivityTime(Date.now());
    };

    // Listen for user activity
    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('keypress', handleActivity);
    window.addEventListener('click', handleActivity);
    window.addEventListener('scroll', handleActivity);

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keypress', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('scroll', handleActivity);
    };
  }, [isTracking, isPaused]);

  // Update elapsed time
  useEffect(() => {
    if (!isTracking || isPaused) return;

    intervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 60000);
      setElapsedMinutes(elapsed);
    }, 1000); // Update every second for smooth display

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isTracking, isPaused]);

  // Check for idle time
  useEffect(() => {
    if (!isTracking || isPaused) return;

    idleCheckRef.current = setInterval(() => {
      const idleTime = Date.now() - lastActivityTime;
      
      if (idleTime > idleTimeoutMs) {
        console.log('[IdleTimeTracker] Idle timeout reached, pausing...');
        setIsPaused(true);
        
        toast({
          title: '⏸️ Tracking Paused',
          description: `No activity detected for ${settings?.idle_timeout_minutes || 5} minutes`,
        });
      }
    }, 10000); // Check every 10 seconds

    return () => {
      if (idleCheckRef.current) clearInterval(idleCheckRef.current);
    };
  }, [isTracking, isPaused, lastActivityTime, idleTimeoutMs, settings, toast]);

  const handleStart = () => {
    startTimeRef.current = Date.now();
    setElapsedMinutes(0);
    setIsTracking(true);
    setIsPaused(false);
    setLastActivityTime(Date.now());
    
    toast({
      title: '▶️ Tracking Started',
      description: 'Time tracking is now active',
    });
  };

  const handlePause = () => {
    setIsPaused(true);
  };

  const handleResume = () => {
    setIsPaused(false);
    setLastActivityTime(Date.now());
    
    toast({
      title: '▶️ Tracking Resumed',
      description: 'Time tracking is active again',
    });
  };

  const handleStop = () => {
    if (elapsedMinutes === 0) {
      toast({
        variant: 'destructive',
        title: 'No Time to Save',
        description: 'Track at least 1 minute before stopping',
      });
      return;
    }

    saveTimeMutation.mutate({
      minutes: elapsedMinutes,
      note: currentActivity
    });

    setIsTracking(false);
    setIsPaused(false);
    setElapsedMinutes(0);
    startTimeRef.current = null;
  };

  if (!organizationId || !settings?.time_tracking_enabled) {
    return null;
  }

  return (
    <Card className={`border-2 ${
      isTracking 
        ? isPaused 
          ? 'border-amber-300 bg-amber-50' 
          : 'border-blue-300 bg-blue-50'
        : 'border-slate-200'
    }`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${
              isTracking 
                ? isPaused 
                  ? 'bg-amber-100' 
                  : 'bg-blue-100 animate-pulse'
                : 'bg-slate-100'
            }`}>
              {isTracking ? (
                isPaused ? (
                  <Pause className="w-5 h-5 text-amber-600" />
                ) : (
                  <Zap className="w-5 h-5 text-blue-600" />
                )
              ) : (
                <Clock className="w-5 h-5 text-slate-600" />
              )}
            </div>
            
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-semibold text-slate-900">Time Tracker</h4>
                {isTracking && (
                  <Badge variant={isPaused ? 'outline' : 'default'}>
                    {isPaused ? 'Paused' : 'Active'}
                  </Badge>
                )}
              </div>
              
              {isTracking && (
                <div className="text-sm text-slate-600 mt-1">
                  <span className="font-mono font-bold text-lg text-slate-900">
                    {Math.floor(elapsedMinutes / 60)}:{String(elapsedMinutes % 60).padStart(2, '0')}
                  </span>
                  <span className="ml-2">
                    ({Math.ceil(elapsedMinutes / 6) * 6} min billable)
                  </span>
                </div>
              )}
              
              {!isTracking && (
                <p className="text-xs text-slate-500 mt-1">
                  Auto-pauses after {settings?.idle_timeout_minutes || 5} min idle
                </p>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            {!isTracking ? (
              <Button
                onClick={handleStart}
                size="sm"
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Play className="w-4 h-4 mr-1" />
                Start
              </Button>
            ) : (
              <>
                {!isPaused ? (
                  <Button
                    onClick={handlePause}
                    size="sm"
                    variant="outline"
                  >
                    <Pause className="w-4 h-4 mr-1" />
                    Pause
                  </Button>
                ) : (
                  <Button
                    onClick={handleResume}
                    size="sm"
                    variant="outline"
                  >
                    <Play className="w-4 h-4 mr-1" />
                    Resume
                  </Button>
                )}
                <Button
                  onClick={handleStop}
                  size="sm"
                  variant="destructive"
                  disabled={saveTimeMutation.isPending}
                >
                  <StopCircle className="w-4 h-4 mr-1" />
                  Stop & Save
                </Button>
              </>
            )}
          </div>
        </div>

        {isTracking && (
          <div className="mt-3 pt-3 border-t border-slate-200">
            <input
              type="text"
              value={currentActivity}
              onChange={(e) => setCurrentActivity(e.target.value)}
              placeholder="What are you working on?"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}