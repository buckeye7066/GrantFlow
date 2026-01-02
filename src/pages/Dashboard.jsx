import React, { useMemo } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import {
  Building2,
  Calendar as CalendarIcon,
  DollarSign,
  Loader2,
  AlertCircle,
  Target,
  Plus,
  Sparkles,
} from "lucide-react"
import { differenceInDays, format } from "date-fns"

import { base44 } from "@/api/base44Client"
import { getPipelineStats, getReminders } from "@/api/dashboard"
import { listProfiles, getProfile } from "@/api/profiles"
import { parseDateSafe } from "@/components/shared/dateUtils"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { createPageUrl } from "@/utils"

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
import { cn } from "@/lib/utils"

function LJWMonogram({ className = "" }) {
  return (
    <div
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md border border-white/30 bg-white/30 text-[10px] font-semibold uppercase tracking-wide text-white",
        className,
      )}
    >
      LJW
    </div>
  )
}

export default function Dashboard() {
  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
    staleTime: 60_000,
  })

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
    queryFn: () => base44.entities.Organization.list(),
    enabled: currentUser?.role === "admin",
  })

  const { data: grants = [], isLoading: isLoadingGrants, error: grantsError } = useQuery({
    queryKey: ["grants"],
    queryFn: () => base44.entities.Grant.list("-created_date"),
  })

  const { data: milestones = [], isLoading: isLoadingMilestones, error: milestonesError } = useQuery({
    queryKey: ["milestones"],
    queryFn: () => base44.entities.Milestone.list("due_date"),
  })

  const { data: expenses = [], isLoading: isLoadingExpenses, error: expensesError } = useQuery({
    queryKey: ["expenses"],
    queryFn: () => base44.entities.Expense.list("-date"),
  })

  const {
    data: pipelineStats,
    isLoading: isLoadingPipeline,
    error: pipelineError,
  } = useQuery({
    queryKey: ["pipeline-stats"],
    queryFn: getPipelineStats,
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
    if (currentUser?.role === "admin") {
      return profiles.length || organizations.length
    }
    return 3144
  }, [currentUser?.role, profiles.length, organizations.length])

  const stats = useMemo(
    () => [
      {
        title: "Funds Secured",
        value: "$22,000,000+",
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
        value: activeGrants.length,
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
    [displayOrganizationsCount, activeGrants.length, totalExpenses, urgentDeadlines.length],
  )

  const isLoading =
    isLoadingProfiles ||
    isLoadingOrgs ||
    isLoadingGrants ||
    isLoadingMilestones ||
    isLoadingExpenses ||
    isLoadingPipeline ||
    (isLoadingReminders && !remindersData) ||
    (currentUser?.role === "user" && isLoadingProfileDetail)

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

  const activeProfileId = useMemo(() => {
    if (profileDetail?.id) return profileDetail.id
    if (currentUser?.active_profile_id) return currentUser.active_profile_id
    if (currentUser?.profile_id) return currentUser.profile_id
    if (profiles.length > 0) return profiles[0].id
    return null
  }, [profileDetail, currentUser, profiles])

  const today = format(new Date(), "EEEE, MMM d")

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
                  <p className="text-sm text-slate-600 md:text-base">
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
            {activeProfileId ? <AnyaChat profileId={activeProfileId} /> : null}
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
    </section>
  )
}
