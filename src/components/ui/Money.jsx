/**
 * Money — renders figures/labels in Space Mono (Funding Current identity).
 *
 * Use for dollar amounts and short mono labels (hosts, meta, deadlines). Opt-in
 * monospace via the `.money` utility (defined in src/index.css). Reusable on the
 * dashboard and pipeline later.
 *
 * Props:
 *   value   — number (formatted as USD currency) or any node (rendered as-is).
 *   currency, locale — Intl.NumberFormat options when `value` is a number.
 */

import * as React from "react"

import { cn } from "@/lib/utils"

function formatAmount(value, locale, currency) {
  if (typeof value !== "number" || Number.isNaN(value)) return value
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value)
  } catch {
    return `$${value.toLocaleString()}`
  }
}

export function Money({
  value,
  currency = "USD",
  locale = undefined,
  className,
  children,
  ...props
}) {
  const content = children !== undefined ? children : formatAmount(value, locale, currency)
  return (
    <span className={cn("money", className)} {...props}>
      {content}
    </span>
  )
}

export default Money
