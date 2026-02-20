import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ROUTE_LABELS } from "@/nav/navConfig";
import { ArrowRight } from "lucide-react";

/**
 * "Continue where you left off" — links to last visited page (from localStorage).
 */
export default function ContinueCard({ lastVisitedPath }) {
  if (!lastVisitedPath || lastVisitedPath === "/" || lastVisitedPath === "/Dashboard") return null;

  const pathname = lastVisitedPath.split("?")[0];
  const segment = pathname.replace(/^\//, "") || "Dashboard";
  const routeName = segment.split("/")[0];
  const label = ROUTE_LABELS[routeName] ?? routeName;

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ArrowRight className="w-4 h-4 text-primary" />
          Continue where you left off
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-sm text-muted-foreground mb-3">Return to {label}.</p>
        <Button asChild className="w-full sm:w-auto" size="sm">
          <Link to={lastVisitedPath} className="gap-2">
            Open {label}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
