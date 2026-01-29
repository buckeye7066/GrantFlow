import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Calendar as CalendarIcon, ArrowRight } from "lucide-react";
import { format, differenceInDays } from "date-fns";

export default function UrgentDeadlinesCard({ urgentDeadlines }) {
  const getDeadlineInfo = (grant) => {
    if (grant.deadline?.toLowerCase() === 'rolling') {
      return {
        text: 'Rolling',
        color: "bg-blue-50 text-blue-700 border-blue-200"
      };
    }

    const deadline = new Date(grant.deadline);
    if (isNaN(deadline.getTime())) return null;

    const daysLeft = differenceInDays(deadline, new Date());
    
    if (daysLeft === 0) {
      return {
        text: 'Due today',
        color: "bg-red-50 text-red-700 border-red-200"
      };
    }
    
    if (daysLeft === 1) {
      return {
        text: '1 day left',
        color: "bg-red-50 text-red-700 border-red-200"
      };
    }
    
    return {
      text: `${daysLeft} days left`,
      color: daysLeft <= 7 ? "bg-red-50 text-red-700 border-red-200" : "bg-amber-50 text-amber-700 border-amber-200"
    };
  };

  return (
    <Card className="shadow-lg border-0">
      <CardHeader className="border-b border-slate-100 pb-4">
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
            <CalendarIcon className="w-12 h-12 mx-auto mb-3 text-slate-700" />
            <p>No urgent deadlines</p>
          </div>
        ) : (
          <div className="space-y-4">
            {urgentDeadlines.map((grant) => {
              const deadlineInfo = getDeadlineInfo(grant);
              if (!deadlineInfo) return null;

              return (
                <Link key={grant.id} to={createPageUrl("GrantDetail", { id: grant.id })}>
                  <div className="flex items-start justify-between p-4 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer">
                    <div className="flex-1">
                      <h4 className="font-semibold text-slate-900">{grant.title}</h4>
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