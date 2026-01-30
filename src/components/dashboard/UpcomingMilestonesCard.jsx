import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar as CalendarIcon, ArrowRight } from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function UpcomingMilestonesCard({ upcomingMilestones }) {
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  return (
    <Card className="shadow-lg border-0 dark:bg-slate-950">
      <CardHeader className="border-b border-slate-100 dark:border-slate-800 pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-xl">
            <CalendarIcon className="w-5 h-5 text-blue-500" />
            Upcoming Milestones
          </CardTitle>
          <Link to={createPageUrl("Calendar")}>
            <Button variant="ghost" size="sm" aria-label="View all milestones">
              View All <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        {upcomingMilestones.length === 0 ? (
          <div className="text-center py-8 text-foreground">
            <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-slate-700 dark:text-slate-300" />
            <p>No upcoming milestones</p>
          </div>
        ) : (
          <div className="space-y-3">
            {upcomingMilestones.map((milestone) => (
              <div key={milestone.id} className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <div className="flex-1">
                  <p className="font-medium text-slate-900 dark:text-slate-50">{milestone.title}</p>
                  <p className="text-sm text-foreground">
                    {isValidDate(milestone.due_date) 
                      ? format(new Date(milestone.due_date), 'MMM d, yyyy') 
                      : 'No due date'}
                  </p>
                </div>
                <Badge variant="outline">{milestone.milestone_type}</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}