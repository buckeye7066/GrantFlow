import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, FileText, Plus } from "lucide-react";

export default function RecentGrantsCard({ grants = [] }) {
  const safeGrants = useMemo(() => {
    return Array.isArray(grants) ? grants : [];
  }, [grants]);

  const recentGrants = useMemo(() => {
    return safeGrants.slice(0, 5);
  }, [safeGrants]);

  return (
    <Card className="shadow-lg border-0" role="region" aria-label="Recent grants">
      <CardHeader className="border-b border-slate-100 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <TrendingUp className="w-5 h-5 text-emerald-500" aria-hidden="true" />
          Recent Grants
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        {recentGrants.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            <FileText className="w-12 h-12 mx-auto mb-3 text-slate-300" aria-hidden="true" />
            <p className="mb-2">No grants yet</p>
            <p className="text-xs text-slate-400 mb-4">Start discovering funding opportunities</p>
            <Link to={createPageUrl("DiscoverGrants")}>
              <Button variant="outline" size="sm" className="gap-2" aria-label="Discover new grants">
                <Plus className="w-4 h-4" />
                Discover Grants
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-3" role="list">
            {recentGrants.map((grant) => {
              const key = grant?.id || `grant-${grant?.title || Math.random()}`;
              const title = grant?.title || 'Untitled Grant';
              const funder = grant?.funder || 'Unknown Funder';
              const status = grant?.status || 'unknown';

              return (
                <Link key={key} to={createPageUrl("Pipeline")}>
                  <div 
                    className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                    role="listitem"
                    aria-label={`${title} from ${funder}, status: ${status}`}
                  >
                    <FileText className="w-5 h-5 text-slate-400 shrink-0" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-900 truncate">{title}</p>
                      <p className="text-sm text-slate-600 truncate">{funder}</p>
                    </div>
                    <Badge variant="outline">{status}</Badge>
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