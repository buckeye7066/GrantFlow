import type { HTMLAttributes } from "react";
import { cn } from "./utils";

export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="alert"
      className={cn("w-full rounded-2xl border border-border bg-muted/30 p-4 text-sm text-foreground", className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm font-semibold leading-6", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-1 text-sm text-muted-foreground", className)} {...props} />;
}


