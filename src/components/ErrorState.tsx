import type { HTMLAttributes } from "react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";

export interface ErrorStateProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description = "We couldn’t load this section. Please try again in a moment.",
  onRetry,
  retryLabel = "Retry",
  className,
  ...props
}: ErrorStateProps) {
  return (
    <Alert className={cn("flex flex-col gap-3 text-left", className)} {...props}>
      <div>
        <AlertTitle>{title}</AlertTitle>
        {description && <AlertDescription>{description}</AlertDescription>}
      </div>
      {onRetry && (
        <div>
          <Button onClick={onRetry} size="sm">
            {retryLabel}
          </Button>
        </div>
      )}
    </Alert>
  );
}


