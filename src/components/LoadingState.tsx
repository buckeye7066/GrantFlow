import { Skeleton } from './ui/skeleton'
import { cn } from '../lib/utils'

export interface LoadingStateProps {
  label?: string
  className?: string
}

export function LoadingState({ label = 'Preparing your data…', className }: LoadingStateProps) {
  return (
    <div className={cn('space-y-6', className)} aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-32 w-full rounded-xl" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  )
}


