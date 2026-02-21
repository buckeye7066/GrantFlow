import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { ListOrdered, Building2, Search, Kanban } from "lucide-react";

/**
 * Guided "Start here" sequence when user has no profiles / no history.
 */
export default function StartHereCard() {
  const steps = [
    { label: "Add your organization", to: createPageUrl("Organizations"), icon: Building2 },
    { label: "Find grants that match you", to: createPageUrl("DiscoverGrants"), icon: Search },
    { label: "Add to pipeline and track applications", to: createPageUrl("Pipeline"), icon: Kanban },
  ];

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ListOrdered className="w-4 h-4 text-primary" />
          Start here
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-sm text-muted-foreground mb-3">
          New to GrantFlow? Follow these three steps: add your organization, search for grants that match you, then track your applications.
        </p>
        <ol className="space-y-2">
          {steps.map((step, i) => (
            <li key={step.to} className="flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                {i + 1}
              </span>
              <Button asChild variant="outline" size="sm" className="flex-1 justify-start gap-2">
                <Link to={step.to}>
                  <step.icon className="w-4 h-4" />
                  {step.label}
                </Link>
              </Button>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
