import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

export interface ErrorStateProps {
  title?: string
  description?: string
  onRetry?: () => void
  actionLabel?: string
  className?: string
}

export function ErrorState({
  title = 'We hit a snag loading your data.',
  description = 'Please refresh the page or try again in a few minutes. If the issue persists, reach out to support.',
  onRetry,
  actionLabel = 'Retry',
  className,
}: ErrorStateProps) {
  return (
    <div className={cn('max-w-xl', className)}>
      <Alert variant="destructive">
        <div className="flex flex-col space-y-3">
          <div>
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>{description}</AlertDescription>
          </div>
          {onRetry && (
            <div>
              <Button variant="destructive" onClick={onRetry}>
                {actionLabel}
              </Button>
            </div>
          )}
        </div>
      </Alert>
    </div>
  )
}


