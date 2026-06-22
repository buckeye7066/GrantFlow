/**
 * profileOverviewHelpers.jsx
 *
 * Pure helpers extracted from `ProfileOverview.jsx` so the component file
 * stays components-only (Vite Fast Refresh requirement). These helpers are
 * shared with sibling render utilities and unit tests.
 */
import React from "react"
import { Badge } from "@/components/ui/badge"
import { hasMeaningfulProfileValue } from "@/utils/profileCompletion"
import {
  cleanStringArrayForDisplay,
  formatFieldValue,
  getFieldFormat,
  isSentinelDisplayValue,
  normalizeDisplayString,
} from "@/utils/fieldDisplay"

export function formatInlinePreviewValue(inner) {
  if (inner === null || inner === undefined) return null
  if (typeof inner === "boolean") return inner ? "Yes" : "No"
  if (typeof inner === "number") return String(inner)
  if (typeof inner === "string") return normalizeDisplayString(inner)
  if (Array.isArray(inner)) {
    const allPrimitive = inner.every(
      (item) => item === null || item === undefined || ["string", "number", "boolean"].includes(typeof item),
    )
    if (!allPrimitive) return null
    // De-dupe + split run-together tokens so list previews never repeat values.
    const values = cleanStringArrayForDisplay(inner)
    return values.length > 0 ? values.join(", ") : null
  }
  return null
}

export function flattenObjectEntries(obj, { maxDepth = 2, depth = 0, prefix = "", sectionKey = null } = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return []
  const entries = []
  for (const [key, inner] of Object.entries(obj)) {
    if (!hasMeaningfulProfileValue(inner)) continue
    const label = String(key).replace(/[_-]+/g, " ")
    const nextKey = prefix ? `${prefix}.${label}` : label
    const inline = formatInlinePreviewValue(inner)
    if (inline !== null) {
      entries.push([nextKey, inline])
      continue
    }
    if (typeof inner === "object" && !Array.isArray(inner) && depth < maxDepth) {
      entries.push(...flattenObjectEntries(inner, { maxDepth, depth: depth + 1, prefix: nextKey, sectionKey }))
    }
  }
  return entries
}

function renderBooleanTri(value) {
  const isUnknown = value === null || value === undefined || isSentinelDisplayValue(value)
  if (isUnknown) {
    return <Badge className="bg-amber-50 text-amber-700 border-amber-200">Unknown</Badge>
  }
  const normalized =
    typeof value === "string"
      ? ["true", "yes", "y", "1"].includes(value.trim().toLowerCase())
      : Boolean(value)
  return (
    <Badge className={normalized ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-600"}>
      {normalized ? "Yes" : "No"}
    </Badge>
  )
}

export function renderValue(fieldKey, value, sectionKey) {
  const formatted = formatFieldValue(sectionKey, fieldKey, value)
  const formatHint = getFieldFormat(sectionKey, fieldKey)
  if (formatHint === "boolean_tri") return renderBooleanTri(value)
  if (formatted === "—") return <span className="text-sm text-slate-500">—</span>
  if (formatHint === "url") {
    return (
      <a href={formatted} className="text-sm text-blue-700 underline break-all" onClick={(event) => event.stopPropagation()}>
        {formatted}
      </a>
    )
  }
  if (formatHint === "email") {
    return (
      <a href={`mailto:${formatted}`} className="text-sm text-blue-700 underline" onClick={(event) => event.stopPropagation()}>
        {formatted}
      </a>
    )
  }
  return (
    <span
      className={
        formatHint === "currency_usd" || formatHint === "currency_cents_usd"
          ? "text-sm font-medium text-slate-900"
          : "text-sm text-slate-900"
      }
    >
      {formatted}
    </span>
  )
}

export { renderBooleanTri }
