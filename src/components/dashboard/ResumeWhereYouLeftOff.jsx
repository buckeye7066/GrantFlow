import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { Play, Search, Calendar, Kanban } from "lucide-react";

/**
 * Single dominant "continue your work" CTA. Reduces decision count by suggesting one next step.
 */
export default function ResumeWhereYouLeftOff({
  urgentDeadlines = [],
  activeGrants = [],
  hasGrants = false,
  isSimplified = false,
}) {
  const firstUrgent = urgentDeadlines[0];
  const draftingOrInterested = activeGrants.filter((g) =>
    ["drafting", "interested", "application_prep"].includes(g?.status)
  );
  const firstInProgress = draftingOrInterested[0];

  let label = isSimplified ? "Ask Anya about funding" : "Find your first grant";
  let to = createPageUrl(isSimplified ? "Help" : "DiscoverGrants");
  let Icon = isSimplified ? Play : Search;
  let description = isSimplified
    ? "Anya can explain what your profile needs before the first source enters your pipeline."
    : "Search for grants that match your organization.";

  if (firstUrgent && firstUrgent.deadline !== "Rolling") {
    label = "View upcoming deadline";
    to = createPageUrl(isSimplified ? "Calendar" : "GrantDeadline");
    Icon = Calendar;
    description = `${firstUrgent.title || "Grant"} — deadline soon.`;
  } else if (firstInProgress) {
    label = "Continue application";
    to = createPageUrl("Pipeline");
    Icon = Kanban;
    description = `Pick up where you left off: ${firstInProgress.title || "Grant"}.`;
  } else if (hasGrants) {
    label = "View your applications";
    to = createPageUrl("Pipeline");
    Icon = Kanban;
    description = "Track and move your applications forward.";
  }

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Play className="w-4 h-4 text-primary" />
          Resume where you left off
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-sm text-muted-foreground mb-3">{description}</p>
        <Button asChild className="w-full sm:w-auto" size="sm">
          <Link to={to} className="gap-2">
            <Icon className="w-4 h-4" />
            {label}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
