import React from "react";
import { Link, useLocation } from "react-router-dom";
import { LIFECYCLE_PHASES } from "@/nav/navConfig";
import { cn } from "@/lib/utils";

/**
 * Compact grant lifecycle indicator: Set Up Org → Find Grants → Review → Prepare → Submit → Track.
 * Highlights current phase based on pathname.
 */
export default function GrantLifecyclePhaseIndicator() {
  const location = useLocation();
  const segments = location.pathname.replace(/^\//, "").split("/").filter(Boolean);
  const path = segments[segments.length - 1] || "Dashboard";

  const routePart = (p) => p.path.replace(/^\//, "");
  const currentIndex = LIFECYCLE_PHASES.findIndex((p) => path === routePart(p));
  const activeIndex = currentIndex >= 0 ? currentIndex : 0;

  return (
    <nav aria-label="Grant lifecycle" className="flex flex-wrap items-center gap-1 text-xs">
      {LIFECYCLE_PHASES.map((phase, i) => {
        const isActive = i === activeIndex;
        const isPast = i < activeIndex;
        return (
          <React.Fragment key={phase.id}>
            {i > 0 && (
              <span className="text-muted-foreground/50" aria-hidden>
                →
              </span>
            )}
            <Link
              to={phase.path}
              className={cn(
                "rounded px-1.5 py-0.5 font-medium transition-colors",
                isActive && "bg-primary/15 text-primary",
                isPast && "text-muted-foreground hover:text-foreground",
                !isActive && !isPast && "text-muted-foreground hover:text-foreground"
              )}
            >
              {phase.label}
            </Link>
          </React.Fragment>
        );
      })}
    </nav>
  );
}
