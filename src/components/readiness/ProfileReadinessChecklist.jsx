import React from 'react'
import { CheckCircle2, Circle, AlertCircle } from 'lucide-react'

/**
 * Per-category checklist driven by computeDetailedReadiness().
 *
 * Each category renders its weight (max points), earned points, presence
 * dot, and any missing items + recommended onboarding questions.
 * Anya uses `recommended_questions` to drive follow-up prompts.
 */
export default function ProfileReadinessChecklist({ data }) {
  const categories = Array.isArray(data?.categories) ? data.categories : []

  if (!categories.length) {
    return <div className="rounded border bg-slate-50 p-3 text-sm text-slate-500">No category data yet.</div>
  }

  return (
    <ol className="space-y-2 text-sm">
      {categories.map((c) => {
        const complete = c.earned >= c.weight
        const partial = c.earned > 0 && c.earned < c.weight
        const Icon = complete ? CheckCircle2 : partial ? AlertCircle : Circle
        const iconColor = complete ? 'text-emerald-600' : partial ? 'text-amber-600' : 'text-slate-400'
        return (
          <li
            key={c.key}
            className="rounded border bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40"
          >
            <div className="flex items-start gap-2">
              <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconColor}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{c.label}</span>
                  <span className="font-mono text-xs text-slate-500">
                    {c.earned}/{c.weight}
                  </span>
                </div>
                {c.missing_items?.length ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-600 dark:text-slate-400">
                    {c.missing_items.map((m, idx) => (
                      <li key={idx}>{m}</li>
                    ))}
                  </ul>
                ) : null}
                {c.recommended_questions?.length ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs italic text-slate-500">
                    {c.recommended_questions.map((q, idx) => (
                      <li key={idx}>Anya could ask: "{q}"</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
