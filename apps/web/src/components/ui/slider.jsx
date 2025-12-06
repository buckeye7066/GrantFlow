import * as React from "react"
import { cn } from "@/lib/utils"

const Slider = React.forwardRef(({ className, min = 0, max = 100, step = 1, value = [50], onValueChange, ...props }, ref) => {
  const [internalValue, setInternalValue] = React.useState(value);
  
  const currentValue = value !== undefined ? value : internalValue;
  const handleValueChange = value !== undefined ? onValueChange : setInternalValue;

  const handleChange = (e) => {
    const newValue = [Number(e.target.value)];
    if (handleValueChange) {
      handleValueChange(newValue);
    }
  };

  const percentage = ((currentValue[0] - min) / (max - min)) * 100;

  return (
    <div ref={ref} className={cn("relative flex w-full touch-none select-none items-center", className)} {...props}>
      <div className="relative h-2 w-full grow overflow-hidden rounded-full bg-slate-200">
        <div 
          className="absolute h-full bg-blue-600 transition-all" 
          style={{ width: `${percentage}%` }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={currentValue[0]}
        onChange={handleChange}
        className="absolute w-full h-2 opacity-0 cursor-pointer"
      />
      <div 
        className="absolute block h-5 w-5 rounded-full border-2 border-blue-600 bg-white ring-offset-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 pointer-events-none"
        style={{ left: `calc(${percentage}% - 10px)` }}
      />
    </div>
  );
})
Slider.displayName = "Slider"

export { Slider }