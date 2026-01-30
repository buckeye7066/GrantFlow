import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, FileText, Plus } from "lucide-react";

export default function RecentGrantsCard({ grants }) {
  return (
    <Card className="shadow-lg border-0 dark:bg-slate-950">
      <CardHeader className="border-b border-slate-100 dark:border-slate-800 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <TrendingUp className="w-5 h-5 text-emerald-500" />
          Recent Grants
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        {grants.length === 0 ? (
          <div className="text-center py-8 text-foreground">
            <FileText className="w-12 h-12 mx-auto mb-3 text-slate-700 dark:text-slate-300" />
            <p>No grants yet</p>
            <Link to={createPageUrl("DiscoverGrants")}>
              <Button variant="outline" size="sm" className="mt-3" aria-label="Discover new grants">
                <Plus className="w-4 h-4 mr-2" />
                Discover Grants
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {grants.slice(0, 5).map((grant) => (
              <Link key={grant.id} to={createPageUrl("Pipeline")}>
                <div className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-900 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
                  <FileText className="w-5 h-5 text-slate-700 dark:text-slate-300" />
                  <div className="flex-1">
                    <p className="font-medium text-slate-900 dark:text-slate-50">{grant.title}</p>
                    <p className="text-sm text-foreground">{grant.funder}</p>
                  </div>
                  <Badge variant="outline">{grant.status}</Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}