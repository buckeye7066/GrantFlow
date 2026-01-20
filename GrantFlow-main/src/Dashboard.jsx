import React, { useMemo } from "react";
import { base44 } from "@/api/base44Client";
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
  Plus,
  Loader2,
  AlertCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

// Dashboard component cards
import StatCard from "@/components/dashboard/StatCard";
import UrgentDeadlinesCard from "@/components/dashboard/UrgentDeadlinesCard";
import UpcomingMilestonesCard from "@/components/dashboard/UpcomingMilestonesCard";
import RecentGrantsCard from "@/components/dashboard/RecentGrantsCard";
import QuickStatsCard from "@/components/dashboard/QuickStatsCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

export default function Dashboard() {
  // Data fetching with error handling
  const { data: organizations = [], isLoading: isLoadingOrgs, error: orgsError } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
  });

  const { data: grants = [], isLoading: isLoadingGrants, error: grantsError } = useQuery({
    queryKey: ['grants'],
    queryFn: () => base44.entities.Grant.list('-created_date'),
  });

  const { data: milestones = [], isLoading: isLoadingMilestones, error: milestonesError } = useQuery({
    queryKey: ['milestones'],
    queryFn: () => base44.entities.Milestone.list('due_date'),
  });

  const { data: expenses = [], isLoading: isLoadingExpenses, error: expensesError } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => base44.entities.Expense.list('-date'),
  });

  // Memoized computed data
  const activeGrants = useMemo(() => 
    grants.filter(g => ['interested', 'drafting', 'submitted', 'awarded'].includes(g.status)),
    [grants]
  );

  const upcomingMilestones = useMemo(() => 
    milestones
      .filter(m => {
        if (m.completed) return false;
        const date = parseDateSafe(m.due_date);
        return date && date >= new Date();
      })
      .slice(0, 5),
    [milestones]
  );

  const totalExpenses = useMemo(() => 
    (expenses || []).reduce((sum, e) => sum + (e.amount || 0), 0),
    [expenses]
  );

  const urgentDeadlines = useMemo(() => 
    grants.filter(g => {
      if (!['discovered', 'interested', 'drafting'].includes(g.status)) {
        return false;
      }
      
      if (g.deadline?.toLowerCase() === 'rolling') {
        return true;
      }
      
      const date = parseDateSafe(g.deadline);
      if (!date) return false;
      
      const daysLeft = differenceInDays(date, new Date());
      return daysLeft >= 0 && daysLeft <= 14;
    }),
    [grants]
  );

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

  // Loading state
  const isLoading = isLoadingOrgs || isLoadingGrants || isLoadingMilestones || isLoadingExpenses;
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Error state
  const errors = [orgsError, grantsError, milestonesError, expensesError].filter(Boolean);
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
    );
  }

  return (
    <section className="p-6 md:p-8 space-y-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">Dashboard</h1>
            <p className="text-slate-600 mt-2">Welcome to your grant management command center</p>
          </div>
          <div className="flex gap-3">
            <Link to={createPageUrl("DiscoverGrants")}>
              <Button className="bg-blue-600 hover:bg-blue-700 shadow-lg" aria-label="Discover new grant opportunities">
                <Plus className="w-4 h-4 mr-2" />
                Discover Grants
              </Button>
            </Link>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {stats.map((stat) => (
            <StatCard key={stat.title} {...stat} />
          ))}
        </div>

        {/* Main Content Grid */}
        <div className="grid lg:grid-cols-2 gap-6">
          <UrgentDeadlinesCard urgentDeadlines={urgentDeadlines} />
          <UpcomingMilestonesCard upcomingMilestones={upcomingMilestones} />
          <RecentGrantsCard grants={grants} />
          <QuickStatsCard grants={grants} />
        </div>

        {/* Empty State */}
        {organizations.length === 0 && <EmptyStateCard />}

        {/* Footer */}
        <footer className="mt-12 pt-6 border-t border-slate-200">
          <p className="text-center text-sm text-slate-500">
            GrantFlow • Created by <span className="font-semibold text-slate-700">John White</span>
          </p>
        </footer>
      </div>
    </section>
  );
}