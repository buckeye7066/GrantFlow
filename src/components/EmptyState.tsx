import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import { cn } from '../lib/utils'

export interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <Card className={cn('border-dashed bg-muted/30 text-center', className)}>
      <CardHeader className="items-center space-y-3">
        {icon && <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">{icon}</div>}
        <CardTitle className="text-xl font-semibold">{title}</CardTitle>
        {description && <CardDescription className="max-w-md text-balance">{description}</CardDescription>}
      </CardHeader>
      {action && <CardContent className="flex justify-center">{action}</CardContent>}
    </Card>
  )
}


