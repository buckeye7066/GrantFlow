import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, FileText, Plus } from "lucide-react";

export default function RecentGrantsCard({ grants }) {
  return (
    <Card className="shadow-lg bg-card text-card-foreground">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <TrendingUp className="w-5 h-5 text-emerald-500" />
          Recent Grants
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        {grants.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <FileText className="w-12 h-12 mx-auto mb-3 text-muted-foreground" />
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
                <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer">
                  <FileText className="w-5 h-5 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="font-medium text-card-foreground">{grant.title}</p>
                    <p className="text-sm text-muted-foreground">{grant.funder}</p>
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