/**
 * StatusDot — Funding Current status indicator.
 *
 * The accent colors ARE the product status language:
 *   emerald = ready, amber = awarded, coral = needs-you (and a neutral sage).
 *
 * Reusable across the Portals page, dashboard, and pipeline later. Opt-in: it
 * only renders a small colored dot, it does not pull in any global styling.
 */

import * as React from "react"

import { cn } from "@/lib/utils"

const TONE_CLASS = {
  ready: "bg-current-emerald",
  emerald: "bg-current-emerald",
  awarded: "bg-current-amber",
  amber: "bg-current-amber",
  needs: "bg-current-coral",
  coral: "bg-current-coral",
  neutral: "bg-current-sage",
  sage: "bg-current-sage",
}

const SIZE_CLASS = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
  lg: "h-3 w-3",
}

export function StatusDot({ tone = "neutral", size = "md", className, ...props }) {
  const toneClass = TONE_CLASS[tone] || TONE_CLASS.neutral
  const sizeClass = SIZE_CLASS[size] || SIZE_CLASS.md
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 rounded-full", sizeClass, toneClass, className)}
      {...props}
    />
  )
}

export default StatusDot
