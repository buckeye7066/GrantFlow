import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { Clock, Pause, Play, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const SAVE_INTERVAL = 15 * 60 * 1000; // 15 minutes - auto-save every 15 min
const ACTIVITY_CHECK_INTERVAL = 1000; // 1 second

const TASK_CATEGORIES = [
  'Research',
  'Drafting',
  'Editing',
  'Budget Development',
  'Client Communication',
  'Meetings',
  'Grant Portal Work',
  'Document Review',
  'Compliance',
  'Other'
];

// Pure helpers hoisted above the component so the auto-save effect and the
// save-time mutation can call them without tripping the TDZ lint guard.
function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function roundTimeWithSettings(settings, minutes) {
  if (!settings) return minutes;
  const increment = settings.time_increment_minutes || 6;
  const minimum = settings.minimum_billable_minutes || 15;

  if (minutes < minimum) return minimum;
  return Math.ceil(minutes / increment) * increment;
}

function calculateAmountWithSettings(settings, minutes) {
  if (!settings) return 0;
  const hours = minutes / 60;
  const rate = settings.default_hourly_rate || 225;
  return hours * rate;
}

export default function AutoTimeTracker({ organizationId, organizationName }) {
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [taskCategory, setTaskCategory] = useState('Research');
  const [note, setNote] = useState('');
  
  const startTimeRef = useRef(null);
  const pauseTimeRef = useRef(null);
  const lastActivityRef = useRef(Date.now());
  const lastSaveRef = useRef(null);
  const intervalRef = useRef(null);
  const activityCheckRef = useRef(null);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Get user
  const [currentUser, setCurrentUser] = useState(null);
  useEffect(() => {
    client.auth.me().then(user => setCurrentUser(user)).catch((error) => {
      console.error('[AutoTimeTracker] Failed to fetch user:', error)
    });
  }, []);

  // Get billing settings
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    client.entities.BillingSettings.list().then(res => {
      if (res && res[0]) {
        setSettings(res[0]);
      }
    }).catch((error) => {
      console.error('[AutoTimeTracker] Failed to fetch billing settings:', error)
    });
  }, []);

  const saveTimeMutation = useMutation({
    mutationFn: async (timeData) => {
      const created = await client.entities.TimeEntry.create(timeData);
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeEntries'] });
      queryClient.invalidateQueries({ queryKey: ['timeLogs'] });
      toast({
        title: "Time Logged",
        description: `${formatTime(elapsedSeconds)} saved successfully.`,
      });
    },
    onError: (error) => {
      console.error('[AutoTimeTracker] Error saving time:', error);
      toast({
        variant: "destructive",
        title: "Failed to Save Time",
        description: error?.message ?? 'Unknown error',
      });
    }
  });

  // Local wrappers around the hoisted helpers that bind the current settings
  // snapshot. Wrapped in useCallback so effect dependency arrays stay stable.
  const roundTime = useCallback((minutes) => roundTimeWithSettings(settings, minutes), [settings]);
  const calculateAmount = useCallback((minutes) => calculateAmountWithSettings(settings, minutes), [settings]);

  const handleStart = useCallback(() => {
    if (!organizationName || !organizationId) return;

    setIsTracking(true);
    setIsPaused(false);
    startTimeRef.current = Date.now();
    lastActivityRef.current = Date.now();
    lastSaveRef.current = Date.now();
    setElapsedSeconds(0);

    toast({
      title: "Timer Started",
      description: `Tracking time for ${organizationName}`,
      duration: 4000,
    });
  }, [organizationId, organizationName, toast]);

  const handleAutoSave = useCallback(() => {
    if (elapsedSeconds < 60) return;

    const now = Date.now();
    const endTime = pauseTimeRef.current || now;
    const rawMinutes = elapsedSeconds / 60;
    const roundedMinutes = roundTime(rawMinutes);
    // Amount preview kept for downstream use; we only persist minutes here.
    calculateAmount(roundedMinutes);

    const timeData = {
      organization_id: organizationId,
      user_id: currentUser?.id || currentUser?.email,
      task_category: taskCategory,
      start_at: new Date(startTimeRef.current).toISOString(),
      end_at: new Date(endTime).toISOString(),
      raw_minutes: Math.round(rawMinutes),
      rounded_minutes: roundedMinutes,
      note: note || `Work on ${organizationName}`,
      activity_hints: [window.location.pathname],
      source: 'auto',
      invoiced: false,
    };

    saveTimeMutation.mutate(timeData);
    lastSaveRef.current = now;
  }, [
    elapsedSeconds,
    roundTime,
    calculateAmount,
    organizationId,
    organizationName,
    currentUser,
    taskCategory,
    note,
    saveTimeMutation,
  ]);

  // Auto-start timer for non-admin users — wait for ALL required data.
  // Declared AFTER handleStart so the effect closure has the initialized
  // callback (no temporal-dead-zone read).
  useEffect(() => {
    if (currentUser && !currentUser.is_admin && !isTracking && organizationId && organizationName && settings) {
      handleStart();
    }
  }, [currentUser, organizationId, organizationName, settings, isTracking, handleStart]);

  // Track user activity
  useEffect(() => {
    const handleActivity = () => {
      lastActivityRef.current = Date.now();
    };

    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('click', handleActivity);
    window.addEventListener('scroll', handleActivity);

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('scroll', handleActivity);
    };
  }, []);

  // Check for idle and auto-save
  useEffect(() => {
    if (!isTracking || isPaused) {
      if (activityCheckRef.current) {
        clearInterval(activityCheckRef.current);
        activityCheckRef.current = null;
      }
      return;
    }

    activityCheckRef.current = setInterval(() => {
      const now = Date.now();
      const timeSinceActivity = now - lastActivityRef.current;
      
      // Check for idle timeout
      if (timeSinceActivity >= IDLE_TIMEOUT) {
        setIsPaused(true);
        pauseTimeRef.current = now;
        toast({
          title: "Timer Paused",
          description: "No activity detected for 5 minutes. Timer has been paused.",
          duration: 5000,
        });
      }

      // Check for auto-save interval
      if (lastSaveRef.current) {
        const timeSinceLastSave = now - lastSaveRef.current;
        if (timeSinceLastSave >= SAVE_INTERVAL && elapsedSeconds > 60) {
          handleAutoSave();
        }
      }
    }, ACTIVITY_CHECK_INTERVAL);

    return () => {
      if (activityCheckRef.current) {
        clearInterval(activityCheckRef.current);
      }
    };
  }, [isTracking, isPaused, elapsedSeconds]);

  // Update elapsed time
  useEffect(() => {
    if (!isTracking || isPaused) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      setElapsedSeconds(prev => prev + 1);
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isTracking, isPaused]);

  const handlePause = () => {
    setIsPaused(true);
    pauseTimeRef.current = Date.now();
  };

  const handleResume = () => {
    setIsPaused(false);
    lastActivityRef.current = Date.now();
    // Clear the pause stamp: handleSave/auto-save both compute
    // `endTime = pauseTimeRef.current || now`, so leaving it set made a
    // pause -> resume -> work -> stop cycle write the OLD PAUSE TIME as the
    // entry's end_at, under-billing every resumed session.
    pauseTimeRef.current = null;
  };

  const handleStop = () => {
    setShowSaveDialog(true);
  };

  const handleSave = () => {
    if (elapsedSeconds < 60) {
      toast({
        variant: "destructive",
        title: "Too Short",
        description: "Time entries must be at least 1 minute.",
      });
      return;
    }

    const now = Date.now();
    const endTime = pauseTimeRef.current || now;
    const rawMinutes = elapsedSeconds / 60;
    const roundedMinutes = roundTime(rawMinutes);

    const timeData = {
      organization_id: organizationId,
      user_id: currentUser?.id || currentUser?.email,
      task_category: taskCategory,
      start_at: new Date(startTimeRef.current).toISOString(),
      end_at: new Date(endTime).toISOString(),
      raw_minutes: Math.round(rawMinutes),
      rounded_minutes: roundedMinutes,
      note: note || `Work on ${organizationName}`,
      activity_hints: [window.location.pathname],
      source: 'auto',
      invoiced: false,
    };

    saveTimeMutation.mutate(timeData);

    // Reset
    setIsTracking(false);
    setIsPaused(false);
    setElapsedSeconds(0);
    setNote('');
    setShowSaveDialog(false);
    startTimeRef.current = null;
    pauseTimeRef.current = null;
    lastSaveRef.current = null;
  };

  const handleDiscard = () => {
    setIsTracking(false);
    setIsPaused(false);
    setElapsedSeconds(0);
    setNote('');
    setShowSaveDialog(false);
    startTimeRef.current = null;
    pauseTimeRef.current = null;
    lastSaveRef.current = null;
    
    toast({
      title: "Time Discarded",
      description: "Timer has been reset without saving.",
      duration: 5000,
    });
  };

  if (!currentUser || !settings || !organizationId) {
    return null;
  }

  const rawMinutes = elapsedSeconds / 60;
  const roundedMinutes = roundTime(rawMinutes);
  const billableAmount = calculateAmount(roundedMinutes);

  return (
    <>
      <Card className="fixed bottom-6 right-6 z-50 shadow-2xl border-2 border-blue-200 bg-white/95 backdrop-blur">
        <div className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Clock className={`w-5 h-5 ${isTracking && !isPaused ? 'text-blue-600 animate-pulse' : 'text-slate-400'}`} />
              <div>
                <div className="text-xs text-slate-500 font-medium">Time Tracking</div>
                <div className="text-lg font-mono font-bold text-slate-900">
                  {formatTime(elapsedSeconds)}
                </div>
              </div>
            </div>

            {!isTracking ? (
              <Button onClick={handleStart} size="sm" className="ml-2">
                <Play className="w-4 h-4 mr-1" />
                Start
              </Button>
            ) : (
              <div className="flex gap-2 ml-2">
                {isPaused ? (
                  <Button onClick={handleResume} size="sm" variant="outline">
                    <Play className="w-4 h-4" />
                  </Button>
                ) : (
                  <Button onClick={handlePause} size="sm" variant="outline">
                    <Pause className="w-4 h-4" />
                  </Button>
                )}
                <Button onClick={handleStop} size="sm" className="bg-emerald-600 hover:bg-emerald-700">
                  <Save className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>
          
          {isTracking && (
            <div className="mt-2 pt-2 border-t border-slate-200 text-xs text-slate-600">
              <div className="flex justify-between">
                <span>Billable: {roundedMinutes.toFixed(1)} min</span>
                <span className="font-semibold text-emerald-600">${billableAmount.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Time Entry</DialogTitle>
            <DialogDescription>
              Record {formatTime(elapsedSeconds)} of work on {organizationName}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={taskCategory} onValueChange={setTaskCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Note (optional)</Label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What did you work on?"
              />
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-600">Raw Time:</span>
                  <span className="font-medium">{rawMinutes.toFixed(1)} minutes</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Rounded Time:</span>
                  <span className="font-medium">{roundedMinutes} minutes</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-blue-300">
                  <span className="font-semibold text-slate-700">Billable Amount:</span>
                  <span className="font-bold text-emerald-600">${billableAmount.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleDiscard}>
              Discard
            </Button>
            <Button onClick={handleSave} disabled={saveTimeMutation.isPending}>
              {saveTimeMutation.isPending ? 'Saving...' : 'Save Time Entry'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}