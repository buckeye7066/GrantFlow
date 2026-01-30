import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";

export default function QuickStatsCard({ grants }) {
  const stats = React.useMemo(() => ({
    discovered: grants.filter(g => g.status === 'discovered').length,
    inProgress: grants.filter(g => ['interested', 'drafting'].includes(g.status)).length,
    submitted: grants.filter(g => g.status === 'submitted').length,
    awarded: grants.filter(g => g.status === 'awarded').length,
  }), [grants]);

  return (
    <Card className="shadow-lg bg-card text-card-foreground">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <BarChart3 className="w-5 h-5 text-purple-500" />
          Quick Stats
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Discovered Grants</span>
            <span className="font-bold text-card-foreground">{stats.discovered}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">In Progress</span>
            <span className="font-bold text-card-foreground">{stats.inProgress}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Submitted</span>
            <span className="font-bold text-card-foreground">{stats.submitted}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Awarded</span>
            <span className="font-bold text-emerald-600 dark:text-emerald-300">{stats.awarded}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}