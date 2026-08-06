import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Calendar as CalendarIcon, ArrowRight } from "lucide-react";
import { daysUntilLocal } from "@/components/shared/dateUtils";

export default function UrgentDeadlinesCard({ urgentDeadlines, isSimplified = false }) {
  const getDeadlineInfo = (grant) => {
    if (grant.deadline?.toLowerCase() === 'rolling') {
      return {
        text: 'Rolling',
        color: "bg-blue-500/10 text-blue-800 border-blue-500/20 dark:bg-blue-500/15 dark:text-blue-200 dark:border-blue-500/30"
      };
    }

    // Local-calendar day math so "Due today" matches the user's wall clock
    // (see dateUtils.daysUntilLocal — fixes the UTC off-by-one).
    const daysLeft = daysUntilLocal(grant.deadline);
    if (daysLeft === null) return null;

    if (daysLeft < 0) {
      return {
        text: daysLeft === -1 ? 'Due yesterday' : `${Math.abs(daysLeft)} days overdue`,
        color: "bg-red-500/10 text-red-800 border-red-500/20 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30"
      };
    }

    if (daysLeft === 0) {
      return {
        text: 'Due today',
        color: "bg-red-500/10 text-red-800 border-red-500/20 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30"
      };
    }
    
    if (daysLeft === 1) {
      return {
        text: '1 day left',
        color: "bg-red-500/10 text-red-800 border-red-500/20 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30"
      };
    }
    
    return {
      text: `${daysLeft} days left`,
      color: daysLeft <= 7
        ? "bg-red-500/10 text-red-800 border-red-500/20 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30"
        : "bg-amber-500/10 text-amber-900 border-amber-500/20 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30"
    };
  };

  return (
    <Card className="shadow-lg bg-card text-card-foreground">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-xl">
            <AlertCircle className="w-5 h-5 text-amber-500" />
            Urgent Deadlines
          </CardTitle>
          <Link to={createPageUrl("Calendar")}>
            <Button variant="ghost" size="sm" aria-label="View all deadlines">
              View All <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        {urgentDeadlines.length === 0 ? (
          <div className="text-center py-8 text-foreground">
            <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-foreground" />
            <p>No urgent deadlines</p>
          </div>
        ) : (
          <div className="space-y-4">
            {urgentDeadlines.map((grant) => {
              const deadlineInfo = getDeadlineInfo(grant);
              if (!deadlineInfo) return null;

              return (
                <Link key={grant.id} to={isSimplified
                  ? `${createPageUrl('Pipeline')}?grant_id=${encodeURIComponent(grant.id)}`
                  : createPageUrl("GrantDetail", { id: grant.id })}>
                  <div className="flex items-start justify-between p-4 bg-muted/30 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer">
                    <div className="flex-1">
                      <h4 className="font-semibold text-card-foreground">{grant.title}</h4>
                      <p className="text-sm text-foreground mt-1">{grant.funder}</p>
                      <div className="flex gap-2 mt-2">
                        <Badge variant="outline" className={deadlineInfo.color}>
                          {deadlineInfo.text}
                        </Badge>
                        <Badge variant="outline">{grant.status}</Badge>
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
