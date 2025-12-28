import type { HTMLAttributes } from "react";
import { cn } from "./utils";

type BadgeVariant = "default" | "secondary" | "warning";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const badgeVariants: Record<BadgeVariant, string> = {
  default: "bg-primary/10 text-primary ring-1 ring-inset ring-primary/20",
  secondary: "bg-muted text-foreground ring-1 ring-inset ring-border/60",
  warning: "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300",
};

export function Badge({ variant = "default", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide",
        badgeVariants[variant] ?? badgeVariants.default,
        className,
      )}
      {...props}
    />
  );
}


