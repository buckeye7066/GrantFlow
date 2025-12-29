import type { HTMLAttributes } from "react"
import { cn } from "./utils"

const VARIANT_CLASSES = {
  default: "border border-border bg-muted/40 text-foreground",
  destructive: "border border-destructive/40 bg-destructive/10 text-destructive",
}

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof VARIANT_CLASSES
}

export function Alert({ className, variant = "default", ...props }: AlertProps) {
  return (
    <div
      role="alert"
      className={cn(
        "relative w-full rounded-xl px-4 py-3 text-sm shadow-sm",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  )
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h4 className={cn("mb-1 text-sm font-semibold", className)} {...props} />
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}


