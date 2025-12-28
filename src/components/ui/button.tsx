import { cloneElement, isValidElement } from "react";
import type { ButtonHTMLAttributes, ReactElement } from "react";
import { cn } from "./utils";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "link" | "destructive";
type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/90",
  outline: "border border-input bg-transparent hover:bg-muted",
  ghost: "bg-transparent text-foreground hover:bg-muted",
  link: "bg-transparent text-primary underline-offset-4 hover:underline",
  destructive: "bg-rose-600 text-white hover:bg-rose-500",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 rounded-md px-3 text-xs",
  md: "h-10 rounded-lg px-4",
  lg: "h-11 rounded-lg px-5 text-base",
  icon: "h-10 w-10 rounded-lg",
};

export function Button({
  variant = "default",
  size = "md",
  asChild = false,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  const classes = cn(
    "inline-flex items-center justify-center gap-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60",
    sizeClasses[size] ?? sizeClasses.md,
    variantClasses[variant] ?? variantClasses.default,
    className,
  );

  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>;
    return cloneElement(child, {
      className: cn(child.props.className, classes),
      ...rest,
    });
  }

  return (
    <button type={type ?? "button"} className={classes} {...rest}>
      {children}
    </button>
  );
}


