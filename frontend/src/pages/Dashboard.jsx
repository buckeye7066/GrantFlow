import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { callFunction, callFunctionWithRetry } from "@/components/shared/functionClient";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { parseDateSafe } from "@/components/shared/dateUtils";
import { differenceInDays } from "date-fns";
import {
  Building2,
  Target,
  DollarSign,
  Calendar as CalendarIcon,
  Loader2,
  LayoutDashboard,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useAuthContext } from "@/components/hooks/useAuthRLS";

import StatCard from "@/components/dashboard/StatCard";
import UrgentDeadlinesCard from "@/components/dashboard/UrgentDeadlinesCard";
import UpcomingMilestonesCard from "@/components/dashboard/UpcomingMilestonesCard";
import RecentGrantsCard from "@/components/dashboard/RecentGrantsCard";
import QuickStatsCard from "@/components/dashboard/QuickStatsCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

import FAFSAStatusCard from "@/components/dashboard/FAFSAStatusCard";
import IRSConnectionCard from "@/components/dashboard/IRSConnectionCard";
import DeadlineRemindersCard from "@/components/dashboard/DeadlineRemindersCard";
import SpecialWelcomeBanner from "@/components/shared/SpecialWelcomeBanner";
import OnboardingGuide from "@/components/onboarding/OnboardingGuide";
import DashboardAutomationPanel from "@/components/dashboard/DashboardAutomationPanel";
import DashboardBatchStatus from "@/components/dashboard/DashboardBatchStatus";
import DashboardProcessingLog from "@/components/dashboard/DashboardProcessingLog";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS - Safe normalization and date handling
// ─────────────────────────────────────────────────────────────────────────────

const normalize = (v) => (v ?? "").toString().toLowerCase().trim();

const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const isExpired = (deadline) => {
  if (!deadline) return false;
  const d = parseDateSafe(deadline);
  if (!d || isNaN(d.getTime())) return false;
  return d < today();
};

const ELIGIBLE_STATUSES = ['discovered', 'interested', 'drafting', 'application_prep', 'revision'];

// Helper to get field from either root or nested data (SDK returns data in nested 'data' object)
const getField = (g, field) => {
  if (!g) return undefined;
  if (g[field] !== undefined) return g[field];
  if (g.data && g.data[field] !== undefined) return g.data[field];
  return undefined;
};

const isEligibleGrant = (g) => {
  if (!g) return false;
  const status = getField(g, 'status');
  const aiStatus = getField(g, 'ai_status');
  return status && ELIGIBLE_STATUSES.includes(status) && aiStatus !== 'error';
};

// Removed unused sleep function

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { toast } = useToast();

  // AUTO-ADVANCE ON MOUNT - Runs once when Dashboard loads
  const hasAutoAdvanced = useRef(false);
  
  useEffect(() => {
    if (hasAutoAdvanced.current) return;
    hasAutoAdvanced.current = true;
    
    const runAutoAdvance = async () => {
      try {
        console.log('[Dashboard] AUTO-ADVANCE: Calling adminBulkAdvance...');
        const result = await callFunction('adminBulkAdvance', { max_grants: 700, batch_size: 50, delay_ms: 50 });
        console.log('[Dashboard] AUTO-ADVANCE result:', result);
        
        if (result.ok && result.data) {
          const { advanced, skipped, ai_active, at_final_stage, errors, message } = result.data;
          console.log(`[Dashboard] AUTO-ADVANCE: ${message}`);
        }
      } catch (err) {
        console.error('[Dashboard] AUTO-ADVANCE error:', err);
      }
    };
    
    runAutoAdvance();
  }, []);

  // Removed org filter to prevent cross-contamination issues
  const [isRunning, setIsRunning] = useState(false);
  const [processingLog, setProcessingLog] = useState([]);
  const [monitoringActive, setMonitoringActive] = useState(false);

  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ processed: 0, failed: 0, remaining: 0 });
  const [shouldStopBatch, setShouldStopBatch] = useState(false);
  const shouldStopBatchRef = useRef(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Ref for monitoring interval - prevents multiple intervals
  const monitoringRef = useRef(null);

  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // Check if user is new (show onboarding)
  useEffect(() => {
    if (user?.email) {
      const hasSeenOnboarding = localStorage.getItem(`onboarding_seen_${user.email}`);
      if (!hasSeenOnboarding) {
        setShowOnboarding(true);
      }
    }
  }, [user?.email]);


  
  const handleCloseOnboarding = useCallback(() => {
    if (user?.email) {
      localStorage.setItem(`onboarding_seen_${user.email}`, 'true');
    }
    setShowOnboarding(false);
  }, [user?.email]);

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Organization.list()
      : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const { data: grants = [], isLoading: isLoadingGrants, refetch: refetchGrants } = useQuery({
    queryKey: ['grants', user?.email, isAdmin],
    queryFn: async () => {
      return isAdmin
        ? base44.entities.Grant.list()
        : base44.entities.Grant.filter({ created_by: user?.email });
    },
    enabled: !!user?.email,
    staleTime: 0,
  });



  const { data: milestones = [] } = useQuery({
    queryKey: ['milestones', user?.email, isAdmin],
    queryFn: async () => {
      return isAdmin
        ? base44.entities.Milestone.list()
        : base44.entities.Milestone.filter({ created_by: user?.email });
    },
    enabled: !!user?.email,
    staleTime: 0,
  });

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses', user?.email, isAdmin],
    queryFn: async () => {
      return isAdmin
        ? base44.entities.Expense.list()
        : base44.entities.Expense.filter({ created_by: user?.email });
    },
    enabled: !!user?.email,
    staleTime: 0,
  });

  // Memoized eligible grants
  const grantsToProcess = useMemo(() => grants.filter(isEligibleGrant), [grants]);

  // ─────────────────────────────────────────────────────────────────────────────
  // MONITORING LOGIC - Single interval, proper cleanup
  // ─────────────────────────────────────────────────────────────────────────────

  const runMonitorCycle = useCallback(async () => {
    try {
      console.log('[Dashboard] runMonitorCycle starting...');
      const result = await callFunction('runBatchAutomation', {});
      console.log('[Dashboard] runMonitorCycle result:', result);
      await refetchGrants();

      if (!result.ok) {
        toast({
          title: '⚠️ Monitoring Alert',
          description: `Error: ${result.error}`,
          duration: 8000,
        });
        return;
      }

      const data = result.data || {};

      if (data.done || (data.processed === 0 && data.remaining === 0)) {
        setMonitoringActive(false);
        toast({
          title: '🎉 All Complete!',
          description: 'All eligible grants have been processed.',
          duration: 8000,
        });
        return;
      }

      if (data.success === false) {
        toast({
          title: '⚠️ Monitoring Alert',
          description: `Error: ${data.error}. ${data.remaining || 0} remaining.`,
          duration: 8000,
        });
      }

      if (data.processed === 1 && data.success) {
        toast({
          title: '🔍 Monitoring Update',
          description: `Grant "${data.grant_title}" advanced. ${data.remaining} grants remaining.`,
          duration: 3000,
        });
      }
    } catch (error) {
      console.error('❌ Monitoring error:', error);
      toast({
        variant: 'destructive',
        title: 'Monitoring Error',
        description: error?.message || 'Unknown error',
        duration: 5000,
      });
    }
  }, [refetchGrants, toast]);

  useEffect(() => {
    // Clear any existing interval
    if (monitoringRef.current) {
      clearInterval(monitoringRef.current);
      monitoringRef.current = null;
    }

    if (!monitoringActive) {
      return;
    }

    if (grantsToProcess.length === 0) {
      setMonitoringActive(false);
      return;
    }

    // Start new interval - wrap in arrow fn to avoid unhandled Promise
    monitoringRef.current = setInterval(() => {
      void runMonitorCycle();
    }, 300000); // 5 min

    return () => {
      if (monitoringRef.current) {
        clearInterval(monitoringRef.current);
        monitoringRef.current = null;
      }
    };
  }, [monitoringActive, grantsToProcess.length, runMonitorCycle]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldStopBatchRef.current = true;
      if (monitoringRef.current) {
        clearInterval(monitoringRef.current);
        monitoringRef.current = null;
      }
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // BATCH PROCESSING - Cancellable, safe cleanup
  // ─────────────────────────────────────────────────────────────────────────────

  const handleBatchProcessAll = useCallback(async () => {
    console.log("[Dashboard] handleBatchProcessAll EXECUTED - using adminBulkAdvance");
    
    if (!Array.isArray(grantsToProcess) || grantsToProcess.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No Grants to Process',
        description: 'There are no queued grants to process.',
        duration: 5000,
      });
      return;
    }

    setIsBatchRunning(true);
    const totalToProcess = grantsToProcess.length;
    setBatchProgress({ processed: 0, failed: 0, remaining: totalToProcess });

    try {
      // Use adminBulkAdvance for bulk processing - it handles all grants in one call
      console.log(`[handleBatchProcessAll] Calling adminBulkAdvance for ${totalToProcess} grants`);
      
      const result = await callFunctionWithRetry('adminBulkAdvance', { 
        max_grants: 700, 
        batch_size: 50, 
        delay_ms: 50 
      });
      
      console.log(`[handleBatchProcessAll] adminBulkAdvance result:`, JSON.stringify(result).slice(0, 500));
      
      await refetchGrants();
      
      if (!result.ok) {
        toast({
          variant: 'destructive',
          title: 'Bulk Advance Failed',
          description: result.error || 'Unknown error',
          duration: 10000,
        });
        return;
      }
      
      const data = result.data || {};
      const { advanced = 0, skipped = 0, ai_active = 0, at_final_stage = 0, errors = 0 } = data;
      
      setBatchProgress({ 
        processed: advanced, 
        failed: errors, 
        remaining: 0 
      });
      
      setProcessingLog([{
        grant: `Bulk: ${advanced} grants`,
        action: 'bulk_advanced',
        from: 'various',
        to: 'next stage',
        remaining: 0
      }]);

      toast({
        title: '✅ Bulk Advance Complete',
        description: `Advanced ${advanced} grants. ${skipped} skipped, ${ai_active} AI active, ${at_final_stage} at final stage, ${errors} errors.`,
        duration: 8000,
      });

    } catch (err) {
      console.error('[handleBatchProcessAll] Error:', err);
      toast({
        variant: 'destructive',
        title: 'Batch Failed',
        description: err?.message || 'Unable to start batch processing.',
        duration: 10000,
      });
    } finally {
      setIsBatchRunning(false);
      setShouldStopBatch(false);
      shouldStopBatchRef.current = false;
    }
  }, [grantsToProcess, toast, refetchGrants]);

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE-RUN AUTOMATION
  // ─────────────────────────────────────────────────────────────────────────────

  const handleRunAutomation = useCallback(async () => {
    // Prevent multiple clicks
    if (isRunning) {
      console.log('[Dashboard] Already running, ignoring click');
      return;
    }
    
    // Disable monitoring during single run
    setMonitoringActive(false);

    setIsRunning(true);
    setProcessingLog([]);
    
    // Safety timeout - auto-reset after 2 minutes max
    const safetyTimeout = setTimeout(() => {
      console.warn('[Dashboard] Safety timeout triggered - resetting isRunning');
      setIsRunning(false);
    }, 120000);

    try {
      toast({
        title: '🤖 Self-Healing Pipeline Started',
        description: `Processing from ${grants.length} total grants (${grantsToProcess.length} eligible)...`,
        duration: 5000,
      });

      const result = await callFunctionWithRetry('runBatchAutomation', {});

      await refetchGrants();

      clearTimeout(safetyTimeout);
      
      if (!result.ok) {
        toast({
          variant: 'destructive',
          title: '❌ Automation Error',
          description: result.error || 'Unknown error',
          duration: 15000,
        });

        setProcessingLog([{
          error: true,
          message: result.error || 'Unknown error',
          stack: '',
          fullError: result
        }]);

        return;
      }

      const data = result.data || {};

      if (data.done || data.processed === 0) {
        const localCount = grants.length;
        const eligibleCount = grantsToProcess.length;

        if (eligibleCount === 0 && localCount > 0) {
          toast({
            title: '✅ All Eligible Grants Processed',
            description: `${localCount} grants exist but none are in eligible statuses.`,
            duration: 8000,
          });
        } else {
          toast({
            title: '✅ All Complete',
            description: 'No grants require processing.',
            duration: 4000,
          });
        }
        return;
      }

      // Success case
      setProcessingLog([{
        grant: data.grant_title,
        grantId: data.grant_id,
        action: 'completed',
        from: data.from_status,
        to: data.to_status,
        remaining: data.remaining
      }]);

      toast({
        title: '🎉 Stage Complete!',
        description: `"${data.grant_title}": Advanced from ${data.from_status} to ${data.to_status}. ${data.remaining} remaining.`,
        duration: 8000,
      });

    } catch (error) {
      clearTimeout(safetyTimeout);
      console.error('❌ AUTOMATION ERROR:', error);

      const errorMessage = error?.message || 'Unknown error';

      toast({
        variant: 'destructive',
        title: '❌ Automation Failed',
        description: errorMessage,
        duration: 15000,
      });

      setProcessingLog([{
        error: true,
        message: errorMessage,
        stack: '',
      }]);
    } finally {
      setIsRunning(false);
    }
  }, [grants.length, grantsToProcess.length, refetchGrants, toast, isRunning]);

  // ─────────────────────────────────────────────────────────────────────────────
  // MONITORING TOGGLE
  // ─────────────────────────────────────────────────────────────────────────────

  const handleToggleMonitoring = useCallback(() => {
    if (monitoringActive) {
      setMonitoringActive(false);
      toast({
        title: 'Monitoring Disabled',
        description: 'Autonomous monitoring stopped.',
      });
    } else {
      if (grantsToProcess.length === 0) {
        toast({
          title: 'Cannot Enable Monitoring',
          description: `${grants.length} grants exist but none are in eligible statuses.`,
          variant: 'destructive',
          duration: 6000,
        });
        return;
      }
      if (isBatchRunning || isRunning) {
        toast({
          title: 'Cannot Enable Monitoring',
          description: 'Please wait for current processing to complete.',
          variant: 'destructive',
          duration: 6000,
        });
        return;
      }
      setMonitoringActive(true);
      toast({
        title: 'Monitoring Enabled',
        description: 'System will check pipeline health every 5 minutes.',
        duration: 5000,
      });
    }
  }, [monitoringActive, grantsToProcess.length, grants.length, isBatchRunning, isRunning, toast]);

  const handleStopBatch = useCallback(() => {
    setShouldStopBatch(true);
    shouldStopBatchRef.current = true;
  }, []);

  const handleClearLog = useCallback(() => {
    setProcessingLog([]);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // MEMOIZED STATS
  // ─────────────────────────────────────────────────────────────────────────────

  const activeGrants = useMemo(() =>
    grants.filter(g => {
      const status = getField(g, 'status');
      return ['interested', 'drafting', 'submitted', 'awarded'].includes(status);
    }),
    [grants]
  );

  const upcomingMilestones = useMemo(() =>
    milestones.filter(m => {
      if (m.completed) return false;
      const date = parseDateSafe(m.due_date);
      return date && date >= new Date();
    }).slice(0, 5),
    [milestones]
  );

  const totalExpenses = useMemo(() =>
    expenses.reduce((sum, e) => sum + (e.amount || 0), 0),
    [expenses]
  );

  // Safe urgent deadlines calculation
  const urgentDeadlines = useMemo(() => {
    const todayDate = today();
    return grants.filter(g => {
      const status = getField(g, 'status');
      const deadline = getField(g, 'deadline');
      
      if (!['discovered', 'interested', 'drafting'].includes(status)) return false;
      
      // Handle rolling deadline safely
      if (normalize(deadline) === 'rolling') return true;
      
      const date = parseDateSafe(deadline);
      if (!date || isNaN(date.getTime())) return false;
      
      const daysLeft = differenceInDays(date, todayDate);
      return daysLeft >= 0 && daysLeft <= 14;
    });
  }, [grants]);

  // Memoized stats array
  const stats = useMemo(() => [
    {
      title: "Organizations",
      value: organizations.length,
      icon: Building2,
      color: "from-blue-500 to-blue-600",
      link: createPageUrl("Organizations")
    },
    {
      title: "Active Grants",
      value: activeGrants.length,
      icon: Target,
      color: "from-emerald-500 to-emerald-600",
      link: createPageUrl("Pipeline")
    },
    {
      title: "Total Expenses",
      value: `$${totalExpenses.toLocaleString()}`,
      icon: DollarSign,
      color: "from-purple-500 to-purple-600",
      link: createPageUrl("Budgets")
    },
    {
      title: "Upcoming Deadlines",
      value: urgentDeadlines.length,
      icon: CalendarIcon,
      color: "from-amber-500 to-amber-600",
      link: createPageUrl("Calendar")
    }
  ], [organizations.length, activeGrants.length, totalExpenses, urgentDeadlines.length]);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  if (isLoadingUser || isLoadingOrgs || isLoadingGrants) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading Dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 bg-slate-50 min-h-screen overflow-auto" style={{ minHeight: '100vh', overflowX: 'auto', overflowY: 'auto' }}>
      <div className="max-w-7xl mx-auto space-y-6">
        <SpecialWelcomeBanner user={user} />
        
        <header className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-8">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 flex items-center gap-3">
              <LayoutDashboard className="w-10 h-10 text-blue-600" />
              Dashboard
            </h1>
            <p className="text-slate-600 mt-2 text-lg">Pipeline Automation v4.1</p>
          </div>
          <div className="flex gap-3">
            <Link to={createPageUrl('DiscoverGrants')}>
              <Button className="bg-blue-600 hover:bg-blue-700 shadow-lg">
                <Search className="w-5 h-5 mr-2" />
                Discover
              </Button>
            </Link>
            <Link to={createPageUrl('Pipeline')}>
              <Button variant="outline" className="shadow-lg">
                <Target className="w-5 h-5 mr-2" />
                Pipeline
              </Button>
            </Link>
          </div>
        </header>

        {/* Automation Panel */}
        <DashboardAutomationPanel
          grants={grants}
          grantsToProcess={grantsToProcess}
          isRunning={isRunning}
          isBatchRunning={isBatchRunning}
          monitoringActive={monitoringActive}
          onRunAutomation={handleRunAutomation}
          onBatchProcess={handleBatchProcessAll}
          onStopBatch={handleStopBatch}
          onToggleMonitoring={handleToggleMonitoring}
        />

        {/* Batch Status */}
        <DashboardBatchStatus
          batchProgress={batchProgress}
          isBatchRunning={isBatchRunning}
        />

        {/* Processing Log */}
        <DashboardProcessingLog
          processingLog={processingLog}
          onClear={handleClearLog}
        />



        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {stats.map((stat) => (
            <StatCard key={stat.title} {...stat} />
          ))}
        </div>

        {/* Dashboard Cards Grid */}
        <div className="grid lg:grid-cols-2 gap-6">
          <DeadlineRemindersCard grants={grants} milestones={milestones} />
          <FAFSAStatusCard organizations={organizations} />
          <IRSConnectionCard organizations={organizations} />
          <UrgentDeadlinesCard urgentDeadlines={urgentDeadlines} />
          <UpcomingMilestonesCard upcomingMilestones={upcomingMilestones} />
          <RecentGrantsCard grants={grants} />
          <QuickStatsCard grants={grants} />
        </div>

        {organizations.length === 0 && <EmptyStateCard />}
      </div>
      
      {/* Onboarding Guide */}
      <OnboardingGuide open={showOnboarding} onClose={handleCloseOnboarding} />
      
      {/* Manual trigger for onboarding */}
      <Button
        variant="ghost"
        size="sm"
        className="fixed bottom-4 right-4 text-xs text-slate-500"
        onClick={() => setShowOnboarding(true)}
      >
        Show Guide
      </Button>
    </div>
  );
}