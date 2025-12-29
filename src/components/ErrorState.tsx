import { Alert, AlertDescription, AlertTitle } from "./ui/alert"
import { Button } from "./ui/button"

interface ErrorStateProps {
  title?: string
  description?: string
  onRetry?: () => void
}

export function ErrorState({
  title = "Something went wrong",
  description = "An unexpected error occurred. Please try again.",
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="mx-auto max-w-xl">
      <Alert variant="destructive" className="flex flex-col gap-3">
        <div>
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
        </div>
        {onRetry ? (
          <Button variant="outline" onClick={onRetry} className="self-start">
            Retry
          </Button>
        ) : null}
      </Alert>
    </div>
  )
}


