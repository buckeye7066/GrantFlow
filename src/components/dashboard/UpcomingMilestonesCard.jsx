import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar as CalendarIcon, ArrowRight } from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { parseLocalDate } from "@/components/shared/dateUtils";

export default function UpcomingMilestonesCard({ upcomingMilestones }) {
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    return Boolean(parseLocalDate(dateString));
  };

  return (
    <Card className="shadow-lg bg-card text-card-foreground">
      <CardHeader className="border-b border-border pb-4">
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
            <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-foreground" />
            <p>No upcoming milestones</p>
          </div>
        ) : (
          <div className="space-y-3">
            {upcomingMilestones.map((milestone) => (
              <div key={milestone.id} className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
                <div className="w-2 h-2 rounded-full bg-primary" />
                <div className="flex-1">
                  <p className="font-medium text-card-foreground">{milestone.title}</p>
                  <p className="text-sm text-foreground">
                    {isValidDate(milestone.due_date)
                      ? format(parseLocalDate(milestone.due_date), 'MMM d, yyyy')
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
