import React from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { HelpCircle } from 'lucide-react'

/**
 * Wraps children with a hover tooltip. Use for "what does this mean?" hints.
 * @param {string} text - Tooltip content (short, 1-2 sentences)
 * @param {React.ReactNode} children - Trigger element; if not provided, uses a small HelpCircle icon
 */
export default function HelpTip({ text, children }) {
  const trigger = children ?? (
    <span className="inline-flex cursor-help" aria-label="Help">
      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
    </span>
  )
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px]">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
