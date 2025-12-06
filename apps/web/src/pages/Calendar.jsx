import React, { useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, Calendar as CalendarIcon, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import UpcomingGrantDeadlineCard from "@/components/calendar/UpcomingGrantDeadlineCard";
import UpcomingMilestoneCard from "@/components/calendar/UpcomingMilestoneCard";
import { useAuthContext } from "@/components/hooks/useAuthRLS";

// Safe date helpers
const normalize = (v) =>
  typeof v === "string" ? v.toLowerCase().trim() : "";

const safeDate = (v) => {
  if (!v) return null;
  if (normalize(v) === "rolling") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

export default function Calendar() {
  const { user, isAdmin } = useAuthContext();

  // Grants (RLS-aware)
  const { data: grants = [] } = useQuery({
    queryKey: ["grants", user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Grant.list()
        : base44.entities.Grant.filter({ created_by: user?.email }),
    enabled: !!user?.email,
    staleTime: 5 * 60 * 1000,
  });

  // Milestones (RLS-aware) — remove unsupported sort args; we sort client-side below
  const { data: milestones = [] } = useQuery({
    queryKey: ["milestones", user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Milestone.list()
        : base44.entities.Milestone.filter({ created_by: user?.email }),
    enabled: !!user?.email,
    staleTime: 5 * 60 * 1000,
  });

  // Map grantId → grant
  const grantMap = useMemo(() => {
    const map = {};
    for (const g of grants) {
      if (g?.id) map[g.id] = g;
    }
    return map;
  }, [grants]);

  // Upcoming grant deadlines (future only, exclude rolling/invalid)
  const upcomingDeadlines = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return grants
      .filter((g) => {
        if (!["discovered", "interested", "drafting"].includes(g.status)) return false;
        const d = safeDate(g.deadline);
        if (!d) return false;
        const deadlineDay = new Date(d);
        deadlineDay.setHours(0, 0, 0, 0);
        return deadlineDay >= today;
      })
      .sort((a, b) => {
        const da = safeDate(a.deadline);
        const db = safeDate(b.deadline);
        if (!da || !db) return 0;
        return da.getTime() - db.getTime();
      });
  }, [grants]);

  // Upcoming milestones (future only)
  const upcomingMilestones = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return milestones
      .filter((m) => {
        if (m.completed) return false;
        const d = safeDate(m.due_date);
        if (!d) return false;
        const dueDay = new Date(d);
        dueDay.setHours(0, 0, 0, 0);
        return dueDay >= today;
      })
      .sort((a, b) => {
        const da = safeDate(a.due_date);
        const db = safeDate(b.due_date);
        if (!da || !db) return 0;
        return da.getTime() - db.getTime();
      });
  }, [milestones]);

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Calendar</h1>
          <p className="text-slate-600">Track all your grant deadlines and milestones</p>
        </header>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Upcoming Grant Deadlines */}
          <section aria-labelledby="deadlines-heading">
            <Card className="shadow-lg border-0">
              <CardHeader className="border-b border-slate-100">
                <CardTitle id="deadlines-heading" className="flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                  Upcoming Grant Deadlines
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                {upcomingDeadlines.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p className="font-medium mb-2">No Upcoming Deadlines</p>
                    <p className="text-sm mb-4">
                      Mark a grant as 'Interested' or 'Drafting' to track its deadline here.
                    </p>
                    <Link to={createPageUrl("DiscoverGrants")}>
                      <Button variant="outline" size="sm">
                        <Plus className="w-4 h-4 mr-2" />
                        Discover Grants
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <ul role="list" className="space-y-4">
                    {upcomingDeadlines.map((grant) => (
                      <UpcomingGrantDeadlineCard key={grant.id} grant={grant} />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>

          {/* Upcoming Milestones */}
          <section aria-labelledby="milestones-heading">
            <Card className="shadow-lg border-0">
              <CardHeader className="border-b border-slate-100">
                <CardTitle id="milestones-heading" className="flex items-center gap-2">
                  <CalendarIcon className="w-5 h-5 text-blue-500" />
                  Upcoming Milestones
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                {upcomingMilestones.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p className="font-medium mb-2">No Upcoming Milestones</p>
                    <p className="text-sm mb-4">
                      Milestones will appear here once added to your grant detail pages.
                    </p>
                    <Link to={createPageUrl("Pipeline")}>
                      <Button variant="outline" size="sm">View Pipeline</Button>
                    </Link>
                  </div>
                ) : (
                  <ul role="list" className="space-y-3">
                    {upcomingMilestones.map((milestone) => (
                      <UpcomingMilestoneCard
                        key={milestone.id}
                        milestone={milestone}
                        grant={grantMap[milestone.grant_id]}
                      />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}