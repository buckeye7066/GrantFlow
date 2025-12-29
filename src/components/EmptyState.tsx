import type { ReactNode } from "react"
import { cn } from "./ui/utils"
import { Button } from "./ui/button"

interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-muted/60 bg-muted/20 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">{title}</h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? action : null}
    </div>
  )
}

export function EmptyStateActionButton({
  children,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button variant="secondary" {...props}>
      {children}
    </Button>
  )
}


