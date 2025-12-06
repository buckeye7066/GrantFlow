import React, { useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar as CalendarIcon, ArrowRight, Plus } from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

const isValidDate = (dateString) => {
  if (!dateString) return false;
  try {
    const date = new Date(dateString);
    return !Number.isNaN(date.getTime());
  } catch {
    return false;
  }
};

const safeFormatDate = (dateString) => {
  if (!isValidDate(dateString)) return 'No due date';
  try {
    return format(new Date(dateString), 'MMM d, yyyy');
  } catch {
    return 'Invalid date';
  }
};

export default function UpcomingMilestonesCard({ upcomingMilestones = [], onAddMilestone }) {
  const safeMilestones = useMemo(() => {
    return Array.isArray(upcomingMilestones) ? upcomingMilestones : [];
  }, [upcomingMilestones]);

  return (
    <Card className="shadow-lg border-0" role="region" aria-label="Upcoming milestones">
      <CardHeader className="border-b border-slate-100 pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-xl">
            <CalendarIcon className="w-5 h-5 text-blue-500" aria-hidden="true" />
            Upcoming Milestones
          </CardTitle>
          <Link to={createPageUrl("Calendar")}>
            <Button variant="ghost" size="sm" aria-label="View all milestones">
              View All <ArrowRight className="w-4 h-4 ml-1" aria-hidden="true" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        {safeMilestones.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-slate-300" aria-hidden="true" />
            <p className="mb-2">No upcoming milestones</p>
            <p className="text-xs text-slate-400 mb-4">Track important dates and deadlines</p>
            {typeof onAddMilestone === 'function' && (
              <Button variant="outline" size="sm" onClick={onAddMilestone} className="gap-2">
                <Plus className="w-4 h-4" />
                Add Milestone
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3" role="list">
            {safeMilestones.map((milestone) => {
              const key = milestone?.id || `milestone-${milestone?.title || Math.random()}`;
              const title = milestone?.title || 'Untitled Milestone';
              const milestoneType = milestone?.milestone_type || 'other';

              return (
                <div 
                  key={key} 
                  className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg"
                  role="listitem"
                  aria-label={`${title}, due ${safeFormatDate(milestone?.due_date)}`}
                >
                  <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-900 truncate">{title}</p>
                    <p className="text-sm text-slate-600">
                      {safeFormatDate(milestone?.due_date)}
                    </p>
                  </div>
                  <Badge variant="outline">{milestoneType}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}