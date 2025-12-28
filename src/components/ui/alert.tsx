import * as React from 'react'
import { cn } from '../../lib/utils'
import { AlertTriangle, Info, CheckCircle2 } from 'lucide-react'

type AlertVariant = 'default' | 'destructive' | 'success'

const VARIANT_STYLES: Record<AlertVariant, { container: string; icon: React.ReactElement }> = {
  default: {
    container: 'border border-border bg-muted text-foreground',
    icon: <Info className="h-4 w-4" aria-hidden />,
  },
  destructive: {
    container: 'border border-destructive/40 bg-destructive/10 text-destructive',
    icon: <AlertTriangle className="h-4 w-4" aria-hidden />,
  },
  success: {
    container: 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    icon: <CheckCircle2 className="h-4 w-4" aria-hidden />,
  },
}

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, children, variant = 'default', ...props },
  ref,
) {
  const variantStyle = VARIANT_STYLES[variant]
  return (
    <div
      ref={ref}
      role="alert"
      className={cn('flex gap-3 rounded-md px-4 py-3 text-sm', variantStyle.container, className)}
      {...props}
    >
      <div className="mt-0.5 flex-shrink-0 text-inherit">{variantStyle.icon}</div>
      <div className="space-y-1 text-inherit">{children}</div>
    </div>
  )
})

export const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  function AlertTitle({ className, ...props }, ref) {
    return <h5 ref={ref} className={cn('text-sm font-semibold', className)} {...props} />
  },
)

export const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function AlertDescription({ className, ...props }, ref) {
    return <p ref={ref} className={cn('text-sm leading-relaxed', className)} {...props} />
  },
)


