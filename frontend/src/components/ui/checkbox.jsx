import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

const Checkbox = React.forwardRef(({ className, checked, onCheckedChange, ...props }, ref) => {
  const handleClick = () => {
    if (props.disabled) return;
    onCheckedChange?.(!checked);
  };

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      ref={ref}
      onClick={handleClick}
      className={cn(
        "peer h-4 w-4 shrink-0 rounded-sm border border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
        checked && "bg-blue-600 border-blue-600 text-white",
        !checked && "bg-white",
        className
      )}
      {...props}
    >
      {checked && (
        <Check className="h-4 w-4" />
      )}
    </button>
  );
});

Checkbox.displayName = "Checkbox"

export { Checkbox }