/**
 * MissingInfoChecklist.jsx
 *
 * Renders a list of missing-info items as a CLICKABLE checklist. Each item
 * that maps to a profile field becomes a deep-link into the exact ProfileDetail
 * section editor where the user can fill it; resolved items render as a
 * struck-through "done" row. Items with no profile target (portal login,
 * funder address, application fee, …) render as a static informational row.
 *
 * Shared by HamiltonTaskDrawer (the task's application_missing_info) and the
 * Profile Action Plan, so the "what's missing → fix it here" UX is identical
 * wherever blockers surface.
 */

import React from "react"
import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Circle, ArrowRight, Info } from "lucide-react"
import { resolveMissingInfoTarget, buildProfileSectionLink } from "@/config/missingInfoTargets"

function itemLabel(item, target) {
  return item.label || target?.label || String(item.key || "").replace(/_/g, " ") || "Required item"
}

export default function MissingInfoChecklist({
  profileId,
  items = [],
  emptyText = "Nothing missing — this profile is ready.",
  className = "",
}) {
  const list = Array.isArray(items) ? items : []

  if (list.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-700">
        <CheckCircle2 className="w-4 h-4" />
        {emptyText}
      </div>
    )
  }

  return (
    <ul className={`space-y-2 ${className}`}>
      {list.map((item, idx) => {
        const key = item.key ?? `item-${idx}`
        const resolved = Boolean(item.resolved)
        const target = resolveMissingInfoTarget(item.key)
        const href = resolved ? null : buildProfileSectionLink(profileId, item.key)
        const label = itemLabel(item, target)

        // Resolved → done row.
        if (resolved) {
          return (
            <li
              key={key}
              className="flex items-center gap-2 rounded-md border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-700"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span className="line-through">{label}</span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-emerald-600">Done</span>
            </li>
          )
        }

        // Has a profile target → clickable deep-link.
        if (href) {
          return (
            <li key={key}>
              <Link
                to={href}
                className="group flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition-colors hover:border-blue-300 hover:bg-blue-50"
              >
                <Circle className="w-4 h-4 shrink-0 text-amber-500" />
                <span className="font-medium text-slate-800">{label}</span>
                {item.kind && (
                  <Badge variant="outline" className="text-[10px]">{item.kind}</Badge>
                )}
                {item.description && (
                  <span className="hidden sm:inline text-xs text-slate-500 truncate">— {item.description}</span>
                )}
                <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-blue-600 group-hover:text-blue-700">
                  Fix in profile
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          )
        }

        // No profile target (portal/funder/auth item) → static informational row.
        return (
          <li
            key={key}
            className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"
          >
            <Info className="w-4 h-4 shrink-0 text-slate-400" />
            <span className="font-medium text-slate-700">{label}</span>
            {item.kind && <Badge variant="outline" className="text-[10px]">{item.kind}</Badge>}
            {item.description && (
              <span className="hidden sm:inline text-xs text-slate-500 truncate">— {item.description}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
