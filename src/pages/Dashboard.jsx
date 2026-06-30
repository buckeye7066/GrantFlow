import React, { useMemo, useState, useEffect } from "react"
import { Link } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Building2,
  Calendar as CalendarIcon,
  DollarSign,
  Loader2,
  AlertCircle,
  Target,
  Plus,
  Sparkles,
  LogOut,
} from "lucide-react"
import { differenceInDays, format } from "date-fns"

import client, { apiFetch } from '@/api/client'
import { getPipelineStats, getReminders } from "@/api/dashboard"
import { listProfiles, getProfile } from "@/api/profiles"
import { parseDateSafe } from "@/components/shared/dateUtils"
import { isActiveStage } from "../../shared/pipelineStages.js"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { createPageUrl } from "@/utils"
import { useAuthStore } from "@/stores/authStore"
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx"
import { getLastVisitedPath } from "@/lib/lastVisitedPreferences"

import StatCard from "@/components/dashboard/StatCard"
import UrgentDeadlinesCard from "@/components/dashboard/UrgentDeadlinesCard"
import UpcomingMilestonesCard from "@/components/dashboard/UpcomingMilestonesCard"
import RecentGrantsCard from "@/components/dashboard/RecentGrantsCard"
import QuickStatsCard from "@/components/dashboard/QuickStatsCard"
import EmptyStateCard from "@/components/dashboard/EmptyStateCard"
import PipelineStatusCard from "@/components/dashboard/PipelineStatusCard"
import PersonalizationPanel from "@/components/dashboard/PersonalizationPanel"
import ReminderCenterCard from "@/components/dashboard/ReminderCenterCard"
import PipelineActionsCard from "@/components/dashboard/PipelineActionsCard"
import ResumeWhereYouLeftOff from "@/components/dashboard/ResumeWhereYouLeftOff"
import ContinueCard from "@/components/dashboard/ContinueCard"
import StartHereCard from "@/components/dashboard/StartHereCard"
import AnyaChat from "@/components/anya/AnyaChat"
import OnboardingVideo from "@/components/onboarding/OnboardingVideo"
import { cn } from "@/lib/utils"
import { useSavedGrantsStore } from "@/stores/savedGrantsStore"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Star, User, CheckCircle2, ArrowRight } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { calculateProfileCompletion } from "@/utils/profileCompletion"

/** Resolves last-visited page from preferences (source of truth) or localStorage (fallback). */
function DashboardContinueOrStart({ profilesLength, urgentDeadlines, activeGrants, hasGrants }) {
  const [lastVisitedPath, setLastVisitedPath] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fromServer = await getLastVisitedPath();
      if (cancelled) return;
      if (fromServer) {
        setLastVisitedPath(fromServer);
        return;
      }
      try {
        setLastVisitedPath(window.localStorage.getItem("grantflow:last-visited-page"));
      } catch {
        setLastVisitedPath(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const hasLastPage =
    lastVisitedPath && lastVisitedPath !== "/" && lastVisitedPath !== "/Dashboard";
  if (hasLastPage) return <ContinueCard lastVisitedPath={lastVisitedPath} />;
  if (profilesLength === 0) return <StartHereCard />;
  return (
    <ResumeWhereYouLeftOff
      urgentDeadlines={urgentDeadlines}
      activeGrants={activeGrants}
      hasGrants={hasGrants}
    />
  );
}

function EngagementRow({ profileDetail, activeGrants, urgentDeadlines }) {
  const { savedIds, sync, synced } = useSavedGrantsStore()

  React.useEffect(() => {
    if (!synced) sync()
  }, [synced, sync])

  const profileCompletion = useMemo(() => calculateProfileCompletion(profileDetail), [profileDetail])
  const filledCount = profileCompletion.completedSections
  const totalCount = profileCompletion.totalSections
  const completionPct = profileCompletion.completionPct

  // Determine next action
  let nextAction = null
  if (completionPct < 40) {
    nextAction = { label: 'Complete your profile for better matches', url: createPageUrl('MyProfiles'), icon: User }
  } else if (savedIds.length === 0 && activeGrants.length === 0) {
    nextAction = { label: 'Discover grants matched to your profile', url: createPageUrl('DiscoverGrants'), icon: Target }
  } else if (urgentDeadlines.length > 0) {
    nextAction = { label: `${urgentDeadlines.length} deadline${urgentDeadlines.length > 1 ? 's' : ''} approaching — review now`, url: createPageUrl('Pipeline'), icon: CalendarIcon }
  } else if (savedIds.length > 0 && activeGrants.length === 0) {
    nextAction = { label: 'Move saved grants into your pipeline', url: createPageUrl('SavedGrants'), icon: Star }
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {/* Profile Completion */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
            <User className="w-4 h-4" /> Profile
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-lg">{completionPct}%</span>
            {completionPct === 100 && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
          </div>
          <Progress value={completionPct} className="h-2" />
          <p className="text-xs text-slate-600">
            {completionPct < 100 ? `${filledCount} of ${totalCount} sections filled` : 'Profile complete'}
          </p>
        </CardContent>
      </Card>

      {/* Saved Grants */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
            <Star className="w-4 h-4" /> Saved Grants
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-semibold">{savedIds.length}</p>
          <p className="text-xs text-slate-600 mt-1">
            {savedIds.length === 0 ? 'Star grants in Discovery to save them' : 'Bookmarked for later'}
          </p>
          {savedIds.length > 0 && (
            <Link to={createPageUrl('SavedGrants')} className="text-xs text-blue-600 hover:underline mt-2 inline-flex items-center gap-1">
              View saved <ArrowRight className="w-3 h-3" />
            </Link>
          )}
        </CardContent>
      </Card>

      {/* Next Action */}
      <Card className={nextAction ? 'border-blue-200 bg-blue-50/50' : ''}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
            <Sparkles className="w-4 h-4" /> Next Step
          </CardTitle>
        </CardHeader>
        <CardContent>
          {nextAction ? (
            <Link to={nextAction.url} className="group flex items-center gap-2">
              <nextAction.icon className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="text-sm text-blue-800 group-hover:underline">{nextAction.label}</span>
              <ArrowRight className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            </Link>
          ) : (
            <p className="text-sm text-emerald-700">You're on track! Keep monitoring your pipeline.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// LJWMonogram component - defined outside Dashboard to maintain stable reference
function LJWMonogram({ className = "" }) {
  return (
    <div
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card text-[10px] font-semibold uppercase tracking-wide text-card-foreground",
        className,
      )}
    >
      LJW
    </div>
  )
}

export default function Dashboard() {
  const sessionExpired = useAuthStore((state) => state.sessionExpired)
  const logout = useAuthStore((state) => state.logout)
  // "Dashboard Columns" personalization (1/2/3) now actually drives the stat grid.
  // Default (2) keeps the original responsive layout so existing users see no change.
  const { state: dashboardPrefs } = useDashboardPreferences()
  const statGridCols = dashboardPrefs?.layoutColumns === 1
    ? 'md:grid-cols-1'
    : dashboardPrefs?.layoutColumns === 3
      ? 'md:grid-cols-3 xl:grid-cols-3'
      : 'md:grid-cols-2 xl:grid-cols-4'
  const [showOnboarding, setShowOnboarding] = useState(false)
  const queryClient = useQueryClient()
  
  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => client.auth.me(),
    staleTime: 60_000,
  })

  // Fetch user preferences to check if onboarding video has been seen
  const { data: userPreferences } = useQuery({
    queryKey: ["userPreferences"],
    queryFn: () => apiFetch('/api/preferences'),
    enabled: Boolean(currentUser),
    staleTime: 300_000, // 5 minutes
  })
  
  // Mutation to update preferences
  const updatePreferencesMutation = useMutation({
    mutationFn: (customPreferences) => 
      apiFetch('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify({ custom_preferences: customPreferences }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userPreferences'] })
    },
    onError: (error) => {
      console.error('Failed to update preferences:', error)
    },
  })
  
  // Check if user has seen the onboarding video
  useEffect(() => {
    if (userPreferences && !userPreferences.custom_preferences?.onboarding_video_seen) {
      setShowOnboarding(true)
    }
  }, [userPreferences])

  const handleOnboardingComplete = () => {
    setShowOnboarding(false)
    updatePreferencesMutation.mutate({
      ...(userPreferences?.custom_preferences || {}),
      onboarding_video_seen: true,
    })
  }

  const handleOnboardingSkip = () => {
    setShowOnboarding(false)
    updatePreferencesMutation.mutate({
      ...(userPreferences?.custom_preferences || {}),
      onboarding_video_seen: true,
    })
  }

  const { data: profiles = [], isLoading: isLoadingProfiles } = useQuery({
    queryKey: ["dashboard-profiles"],
    queryFn: () => listProfiles(),
    enabled: Boolean(currentUser),
    staleTime: 30_000,
  })

  const { data: profileDetail, isLoading: isLoadingProfileDetail } = useQuery({
    queryKey: ["dashboard-profile", currentUser?.profile_id],
    queryFn: () => getProfile(currentUser.profile_id),
    enabled: Boolean(currentUser?.role === "user" && currentUser.profile_id),
    staleTime: 30_000,
  })

  const { data: organizations = [], isLoading: isLoadingOrgs, error: orgsError } = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const res = await client.entities.Organization.list()
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    },
    enabled: currentUser?.role === "admin",
    staleTime: 120_000,
  })

  const { data: grants = [], isLoading: isLoadingGrants, error: grantsError } = useQuery({
    queryKey: ["grants"],
    queryFn: async () => {
      const res = await client.entities.Grant.list("-created_date")
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    },
    enabled: Boolean(currentUser),
    staleTime: 60_000,
  })

  const { data: milestones = [], isLoading: isLoadingMilestones, error: milestonesError } = useQuery({
    queryKey: ["milestones"],
    queryFn: async () => {
      const res = await client.entities.Milestone.list("due_date")
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    },
    enabled: Boolean(currentUser),
    staleTime: 60_000,
  })

  const { data: expenses = [], isLoading: isLoadingExpenses, error: expensesError } = useQuery({
    queryKey: ["expenses"],
    queryFn: async () => {
      const res = await client.entities.Expense.list("-date")
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    },
    enabled: Boolean(currentUser),
    staleTime: 60_000,
  })

  const {
    data: pipelineStats,
    isLoading: isLoadingPipeline,
    error: pipelineError,
  } = useQuery({
    queryKey: ["pipeline-stats"],
    queryFn: getPipelineStats,
    enabled: Boolean(currentUser),
    staleTime: 60_000,
    retry: 0,
  })

  const {
    data: remindersData,
    isLoading: isLoadingReminders,
    error: remindersError,
  } = useQuery({
    queryKey: ["reminders"],
    queryFn: getReminders,
    enabled: Boolean(currentUser), // CRITICAL: Only fetch when authenticated
    staleTime: 60_000,
    retry: 0,
  })

  const profileOrganizationId = profileDetail?.organization_id ?? null

  const relevantGrants = useMemo(() => {
    if (currentUser?.role === "admin" || !profileOrganizationId) return grants
    return grants.filter((grant) => grant.organization_id === profileOrganizationId)
  }, [grants, currentUser?.role, profileOrganizationId])

  const relevantExpenses = useMemo(() => {
    if (currentUser?.role === "admin" || !profileOrganizationId) return expenses
    return expenses.filter((expense) => expense.organization_id === profileOrganizationId)
  }, [expenses, currentUser?.role, profileOrganizationId])

  const relevantMilestones = useMemo(() => {
    if (currentUser?.role === "admin" || !profileOrganizationId) return milestones
    return milestones.filter((milestone) => milestone.organization_id === profileOrganizationId)
  }, [milestones, currentUser?.role, profileOrganizationId])

  const activeGrants = useMemo(
    // ONE definition of "active" (shared/pipelineStages.js isActiveStage) so the
    // sidebar count agrees with Reports and the pipeline funnel.
    () => relevantGrants.filter((g) => isActiveStage(g.status)),
    [relevantGrants],
  )

  const upcomingMilestones = useMemo(
    () =>
      relevantMilestones
        .filter((m) => {
          if (m.completed) return false
          const date = parseDateSafe(m.due_date)
          return date && date >= new Date()
        })
        .slice(0, 5),
    [relevantMilestones],
  )

  const totalExpenses = useMemo(
    () => (relevantExpenses || []).reduce((sum, e) => sum + (e.amount || 0), 0),
    [relevantExpenses],
  )

  const { data: dashboardStats } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: () => apiFetch('/api/stats/dashboard'),
    enabled: Boolean(currentUser),
    staleTime: 60_000,
    retry: 2,
    retryDelay: 3000,
  })

  const totalFundsSecured = useMemo(
    () => {
      // Real funds secured. Prefer the backend's authoritative, per-user-scoped
      // figure when available so the card maps 1:1 to /api/stats; otherwise
      // compute from the grants loaded in the UI. Never show marketing numbers.
      if (dashboardStats && Number.isFinite(Number(dashboardStats.fundsSecured))) {
        return Number(dashboardStats.fundsSecured)
      }
      return relevantGrants
        .filter((g) => g.status === 'awarded' && g.amount)
        .reduce((sum, g) => sum + (Number(g.amount) || 0), 0)
    },
    [relevantGrants, dashboardStats],
  )

  const urgentDeadlines = useMemo(
    () =>
      relevantGrants.filter((g) => {
        if (!["discovered", "interested", "drafting"].includes(g.status)) {
          return false
        }

        if (g.deadline?.toLowerCase() === "rolling") {
          return true
        }

        const date = parseDateSafe(g.deadline)
        if (!date) return false

        const daysLeft = differenceInDays(date, new Date())
        return daysLeft >= 0 && daysLeft <= 14
      }),
    [relevantGrants],
  )

  const displayOrganizationsCount = useMemo(() => {
    // Real organization count. Prefer the backend's scoped figure; otherwise
    // derive from loaded data. No marketing numbers.
    if (dashboardStats && Number.isFinite(Number(dashboardStats.organizations))) {
      return Number(dashboardStats.organizations)
    }
    if (currentUser?.role === "admin") {
      return profiles.length || organizations.length
    }
    return profileOrganizationId ? 1 : 0
  }, [currentUser?.role, profiles.length, organizations.length, profileOrganizationId, dashboardStats])

  const displayActiveGrantsCount = useMemo(() => {
    // Real grant count from the grants loaded in the UI. No marketing numbers.
    return activeGrants.length
  }, [activeGrants.length])

  const stats = useMemo(
    () => [
      {
        title: "Funds Secured",
        value: isLoadingGrants ? "Loading..." : `$${totalFundsSecured.toLocaleString()}`,
        icon: LJWMonogram,
        color: "from-amber-500 to-amber-600",
      },
      {
        title: "Organizations",
        value: displayOrganizationsCount,
        icon: Building2,
        color: "from-blue-500 to-blue-600",
        link: createPageUrl("Organizations"),
      },
      {
        // Subset of the pipeline: grants in active statuses (interested/drafting/
        // submitted/awarded). Labeled precisely so it reads as a subset of the
        // Pipeline page's full grant count rather than appearing to disagree with it.
        title: "Active Pipeline Grants",
        value: displayActiveGrantsCount,
        icon: Target,
        color: "from-emerald-500 to-emerald-600",
        link: createPageUrl("Pipeline"),
      },
      {
        title: "Total Expenses",
        value: `$${totalExpenses.toLocaleString()}`,
        icon: DollarSign,
        color: "from-purple-500 to-purple-600",
        link: createPageUrl("Budgets"),
      },
      {
        title: "Upcoming Deadlines",
        value: urgentDeadlines.length,
        icon: CalendarIcon,
        color: "from-amber-500 to-amber-600",
        link: createPageUrl("Calendar"),
      },
    ],
    [
      displayOrganizationsCount,
      displayActiveGrantsCount,
      totalExpenses,
      urgentDeadlines.length,
      totalFundsSecured,
      isLoadingGrants,
    ],
  )

  const activeProfileId = useMemo(() => {
    if (currentUser?.role === 'admin') return null
    if (profileDetail?.id) return profileDetail.id
    if (currentUser?.active_profile_id) return currentUser.active_profile_id
    if (currentUser?.profile_id) return currentUser.profile_id
    if (profiles.length > 0) return profiles[0].id
    return null
  }, [profileDetail, currentUser, profiles])

  const today = format(new Date(), "EEEE, MMM d")

  const isLoading =
    isLoadingProfiles ||
    isLoadingOrgs ||
    isLoadingGrants ||
    isLoadingMilestones ||
    isLoadingExpenses ||
    isLoadingPipeline ||
    (isLoadingReminders && !remindersData) ||
    (currentUser?.role === "user" && isLoadingProfileDetail)

  // Check for session expiration first
  if (sessionExpired) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Alert className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Your session has ended. Please sign in again to continue.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  const errors = [orgsError, grantsError, milestonesError, expensesError].filter(Boolean)
  if (errors.length > 0) {
    return (
      <div className="p-6 md:p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-col gap-3">
            <span>Failed to load dashboard data. Check your connection, then try refreshing.</span>
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => window.location.reload()}
            >
              Refresh page
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <section className="relative px-4 pb-12 pt-6 md:px-6 lg:px-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-6">
            <div className="relative overflow-hidden rounded-3xl border border-border/70 bg-card/90 p-6 shadow-lg md:p-8">
              <div className="absolute -right-12 -top-12 h-52 w-52 rounded-full bg-gradient-to-br from-primary/20 via-primary/15 to-transparent blur-3xl" />
              <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-xl space-y-4">
                  <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-primary">
                    {today}
                  </span>
                  <h1 className="text-2xl font-bold text-card-foreground md:text-3xl">
                    Operational pulse across all grants and obligations
                  </h1>
                  <p className="text-sm text-foreground md:text-base">
                    Staying ahead of submissions, compliance, and reporting just became easier.
                    Leverage AI nudges and smart filters to keep every opportunity on track.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <Button asChild className="gap-2 shadow-md shadow-blue-200/40" size="lg">
                      <Link to={createPageUrl("DiscoverGrants")}>
                        <Plus className="h-4 w-4" />
                        Find Grants
                      </Link>
                    </Button>
                    <Button variant="ghost" size="sm" className="gap-2" asChild>
                      <Link to={createPageUrl("Automation")}>
                        <Sparkles className="h-4 w-4" />
                        Automations
                      </Link>
                    </Button>
                    <Button variant="ghost" size="sm" className="gap-2" onClick={() => logout()}>
                      <LogOut className="h-4 w-4" />
                      Logout
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <PipelineStatusCard
              stats={pipelineError ? undefined : pipelineStats}
              isLoading={isLoadingPipeline}
              hasError={Boolean(pipelineError)}
            />
            <PipelineActionsCard activeProfileId={activeProfileId} />
          </div>

          <div className="space-y-6">
            <DashboardContinueOrStart
              profilesLength={profiles.length}
              urgentDeadlines={urgentDeadlines}
              activeGrants={activeGrants}
              hasGrants={relevantGrants?.length > 0}
            />
            <PersonalizationPanel />
            {activeProfileId && !globalThis?.__GF_SMOKE__ ? <AnyaChat profileId={activeProfileId} /> : null}
          </div>
        </div>

        <div className={`grid gap-4 ${statGridCols}`}>
          {stats.map((stat) => (
            <StatCard key={stat.title} {...stat} />
          ))}
        </div>

        {/* Engagement Row */}
        <EngagementRow
          profileDetail={profileDetail}
          activeGrants={activeGrants}
          urgentDeadlines={urgentDeadlines}
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="grid gap-6">
            <UrgentDeadlinesCard urgentDeadlines={urgentDeadlines} />
            <UpcomingMilestonesCard upcomingMilestones={upcomingMilestones} />
          </div>
          {/* Only render ReminderCenterCard if we have currentUser */}
          {currentUser && (
            <ReminderCenterCard
              urgentDeadlines={remindersData?.urgentDeadlines ?? urgentDeadlines}
              upcomingMilestones={remindersData?.upcomingMilestones ?? upcomingMilestones}
              isLoading={isLoadingReminders && !remindersData}
              hasError={Boolean(remindersError)}
            />
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <RecentGrantsCard grants={grants} />
          <QuickStatsCard grants={grants} />
        </div>

        {currentUser?.role === "admin" && profiles.length === 0 && <EmptyStateCard />}
      </div>

      <OnboardingVideo
        open={showOnboarding}
        onComplete={handleOnboardingComplete}
        onSkip={handleOnboardingSkip}
      />
    </section>
  )
}
