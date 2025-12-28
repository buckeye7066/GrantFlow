import type { HTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./ui/utils";

export interface LoadingStateProps extends HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export function LoadingState({ label = "Loading…", className, ...props }: LoadingStateProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-muted/20 p-10 text-center",
        className,
      )}
      {...props}
    >
      <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}


