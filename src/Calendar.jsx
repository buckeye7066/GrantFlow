import React from "react";
import client from '@/api/client';
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Calendar as CalendarIcon } from "lucide-react";
import { format, differenceInDays, isFuture } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function Calendar() {
  const { data: grants = [] } = useQuery({
    queryKey: ['grants'],
    queryFn: () => client.entities.Grant.list(),
  });

  const { data: milestones = [] } = useQuery({
    queryKey: ['milestones'],
    queryFn: () => client.entities.Milestone.list('due_date'),
  });

  // Helper to validate date
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  const upcomingDeadlines = grants
    .filter(g => {
      if (!['discovered', 'interested', 'drafting'].includes(g.status)) return false;
      if (!g.deadline) return false;
      if (g.deadline.toLowerCase() === 'rolling') return false;
      if (!isValidDate(g.deadline)) return false;
      return new Date(g.deadline) >= new Date();
    })
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

  const upcomingMilestones = milestones
    .filter(m => {
      if (m.completed) return false;
      if (!m.due_date) return false;
      if (!isValidDate(m.due_date)) return false;
      return isFuture(new Date(m.due_date));
    })
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Calendar</h1>
        <p className="text-slate-600 mb-8">Track all your grant deadlines and milestones</p>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Upcoming Grant Deadlines */}
          <Card className="shadow-lg border-0">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-amber-500" />
                Upcoming Grant Deadlines
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              {upcomingDeadlines.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No upcoming deadlines</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {upcomingDeadlines.map((grant) => {
                    const daysLeft = differenceInDays(new Date(grant.deadline), new Date());
                    return (
                      <Link key={grant.id} to={createPageUrl("GrantDetail", { id: grant.id })}>
                        <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer">
                          <div className="flex-1">
                            <h4 className="font-semibold text-slate-900">{grant.title}</h4>
                            <p className="text-sm text-slate-600 mt-1">{grant.funder}</p>
                            <div className="flex items-center gap-2 mt-2 text-sm text-slate-500">
                              <CalendarIcon className="w-4 h-4" />
                              <span>{format(new Date(grant.deadline), 'MMMM d, yyyy')}</span>
                            </div>
                          </div>
                          <Badge variant="outline" className={daysLeft <= 14 ? "bg-red-100 text-red-700" : ""}>
                            {daysLeft} days left
                          </Badge>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Upcoming Milestones */}
          <Card className="shadow-lg border-0">
            <CardHeader className="border-b border-slate-100">
              <CardTitle className="flex items-center gap-2">
                <CalendarIcon className="w-5 h-5 text-blue-500" />
                Upcoming Milestones
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              {upcomingMilestones.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No upcoming milestones</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {upcomingMilestones.map((milestone) => {
                    const grant = grants.find(g => g.id === milestone.grant_id);
                    return (
                      <Link key={milestone.id} to={createPageUrl("GrantDetail", { id: milestone.grant_id })}>
                        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer">
                          <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1" />
                          <div className="flex-1">
                            <p className="font-medium text-slate-900">{milestone.title}</p>
                            <p className="text-sm text-slate-600">
                              {format(new Date(milestone.due_date), 'MMM d, yyyy')}
                            </p>
                            {grant && <p className="text-xs text-slate-500 mt-1">{grant.title}</p>}
                          </div>
                          <Badge variant="outline">{milestone.milestone_type}</Badge>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}