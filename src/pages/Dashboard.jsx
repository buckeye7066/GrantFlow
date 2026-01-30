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

import { base44 } from "@/api/base44Client"
import { apiFetch } from "@/api/client"
import { getPipelineStats, getReminders } from "@/api/dashboard"
import { listProfiles, getProfile } from "@/api/profiles"
import { parseDateSafe } from "@/components/shared/dateUtils"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { createPageUrl } from "@/utils"
import { useAuthStore } from "@/stores/authStore"

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
import AnyaChat from "@/components/anya/AnyaChat"
import OnboardingVideo from "@/components/onboarding/OnboardingVideo"
import { cn } from "@/lib/utils"

// LJWMonogram component - defined outside Dashboard to maintain stable reference
function LJWMonogram({ className = "" }) {
  return (
    <div
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md border border-white bg-white text-[10px] font-semibold uppercase tracking-wide text-slate-900",
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
  const [showOnboarding, setShowOnboarding] = useState(false)
  const queryClient = useQueryClient()
  
  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
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
      const res = await base44.entities.Organization.list()
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    },
    enabled: currentUser?.role === "admin",
  })

  const { data: grants = [], isLoading: isLoadingGrants, error: grantsError } = useQuery({
    queryKey: ["grants"],
    queryFn: async () => {
      const res = await base44.entities.Grant.list("-created_date")
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    },
    enabled: Boolean(currentUser),
  })

  const { data: milestones = [], isLoading: isLoadingMilestones, error: milestonesError } = useQuery({
    queryKey: ["milestones"],
    queryFn: async () => {
      const res = await base44.entities.Milestone.list("due_date")
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    },
    enabled: Boolean(currentUser),
  })

  const { data: expenses = [], isLoading: isLoadingExpenses, error: expensesError } = useQuery({
    queryKey: ["expenses"],
    queryFn: async () => {
      const res = await base44.entities.Expense.list("-date")
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    },
    enabled: Boolean(currentUser),
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
    () =>
      relevantGrants.filter((g) => ["interested", "drafting", "submitted", "awarded"].includes(g.status)),
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
  })

  const totalFundsSecured = useMemo(
    () => {
      // Use marketing stats for non-admin, real stats for admin
      if (dashboardStats && !dashboardStats.isRealData) {
        return dashboardStats.fundsSecured
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
    // Use marketing stats for non-admin users
    if (currentUser?.role !== "admin" && dashboardStats && !dashboardStats.isRealData) {
      return dashboardStats.organizations
    }
    if (currentUser?.role === "admin") {
      return profiles.length || organizations.length
    }
    // For non-admin users, show their organization count (1 if they belong to one)
    return profileOrganizationId ? 1 : 0
  }, [currentUser?.role, profiles.length, organizations.length, profileOrganizationId, dashboardStats])

  const displayActiveGrantsCount = useMemo(() => {
    // Use marketing stats for non-admin users when provided by backend.
    if (currentUser?.role !== "admin" && dashboardStats && !dashboardStats.isRealData) {
      const value = Number(dashboardStats.activeGrants)
      if (Number.isFinite(value) && value >= 0) return value
    }
    return activeGrants.length
  }, [currentUser?.role, dashboardStats, activeGrants.length])

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
        title: "Active Grants",
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
          <AlertDescription>
            Failed to load dashboard data. Please try refreshing the page.
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
            <div className="relative overflow-hidden rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-lg shadow-blue-100/40 md:p-8">
              <div className="absolute -right-12 -top-12 h-52 w-52 rounded-full bg-gradient-to-br from-blue-100 via-blue-200/70 to-transparent blur-3xl" />
              <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-xl space-y-4">
                  <span className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700">
                    {today}
                  </span>
                  <h1 className="text-2xl font-bold text-slate-900 md:text-3xl">
                    Operational pulse across all grants and obligations
                  </h1>
                  <p className="text-sm text-foreground md:text-base">
                    Staying ahead of submissions, compliance, and reporting just became easier.
                    Leverage AI nudges and smart filters to keep every opportunity on track.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <Button asChild className="gap-2 shadow-md shadow-blue-200/40">
                      <Link to={createPageUrl("DiscoverGrants")}>
                        <Plus className="h-4 w-4" />
                        Discover Grants
                      </Link>
                    </Button>
                    <Button variant="outline" className="gap-2" asChild>
                      <Link to={createPageUrl("Automation")}>
                        <Sparkles className="h-4 w-4" />
                        View Automations
                      </Link>
                    </Button>
                    <Button 
                      variant="ghost" 
                      className="gap-2" 
                      onClick={() => logout()}
                    >
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
            <PipelineActionsCard />
          </div>

          <div className="space-y-6">
            <PersonalizationPanel />
            {activeProfileId && !globalThis?.__GF_SMOKE__ ? <AnyaChat profileId={activeProfileId} /> : null}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => (
            <StatCard key={stat.title} {...stat} />
          ))}
        </div>

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
