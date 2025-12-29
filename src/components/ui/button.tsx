import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react"
import { cn } from "./utils"

type ButtonVariant = "default" | "outline" | "secondary" | "ghost" | "destructive"
type ButtonSize = "default" | "sm" | "lg" | "icon"

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border border-input bg-background hover:bg-muted",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-muted",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: "h-10 px-4 py-2",
  sm: "h-9 rounded-md px-3",
  lg: "h-11 rounded-md px-8",
  icon: "h-9 w-9",
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
  children: ReactNode
}

function mergeChild(child: ReactElement, props: ButtonProps, className: string): ReactElement {
  const childProps = child.props as Record<string, unknown> & { className?: string }
  const mergedProps: Record<string, unknown> = {
    ...childProps,
    ...props,
    className: cn(childProps.className, className),
  }
  delete mergedProps.asChild
  delete mergedProps.variant
  delete mergedProps.size
  return cloneElement(child, mergedProps)
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", asChild = false, children, ...props },
  ref,
) {
  const baseClasses = cn(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:pointer-events-none disabled:opacity-50",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  )

  if (asChild) {
    const onlyChild = Children.only(children)
    if (isValidElement(onlyChild)) {
      return mergeChild(onlyChild, props as ButtonProps, baseClasses)
    }
  }

  return (
    <button ref={ref} className={baseClasses} {...props}>
      {children}
    </button>
  )
})


