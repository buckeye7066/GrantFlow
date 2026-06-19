import React from "react"
import { useQuery } from "@tanstack/react-query"
import { Check, X } from "lucide-react"
import { getTierCatalog } from "@/api/billing"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

const money = (usd) => (usd === null || usd === undefined ? "Custom" : usd === 0 ? "Free" : `$${Number(usd).toLocaleString()}`)

function Yes() { return <Check className="mx-auto h-4 w-4 text-emerald-600" aria-label="Included" /> }
function No() { return <X className="mx-auto h-4 w-4 text-slate-300" aria-label="Not included" /> }

/**
 * "What your plan includes" — a plain-English comparison of every tier built
 * from the canonical catalog (no raw flag names). Optionally highlights the
 * profile's current tier.
 */
export default function TierMatrix({ currentTierId = null }) {
  const { data, isLoading, isError } = useQuery({ queryKey: ["tier-catalog"], queryFn: getTierCatalog, staleTime: 5 * 60_000 })

  if (isLoading) return <Card><CardContent className="p-6 text-sm text-slate-500">Loading plans…</CardContent></Card>
  if (isError || !data) return <Card><CardContent className="p-6 text-sm text-slate-500">Plan details unavailable.</CardContent></Card>

  const tiers = data.tiers || []
  const labels = data.capability_labels || {}
  const rows = [
    { key: "monthly", label: "Monthly price", render: (t) => money(t.monthly_usd) },
    { key: "hourly", label: "Hourly support rate", render: (t) => money(t.hourly_usd) },
    { key: "support_hours", label: "Included support / month", render: (t) => (t.support_hours ? `${t.support_hours} hr${t.support_hours === 1 ? "" : "s"}` : "—") },
    { key: "seats", label: "Team logins (seats)", render: (t) => (t.seat_range ? (t.seat_range.max ? `${t.seat_range.min}–${t.seat_range.max}` : `${t.seat_range.min}+`) : "—") },
    { key: "enable_document_ai", label: labels.enable_document_ai?.label || "Document AI", render: (t) => (t.capabilities?.enable_document_ai ? <Yes /> : <No />) },
    { key: "enable_item_funding", label: labels.enable_item_funding?.label || "Item funding search", render: (t) => (t.capabilities?.enable_item_funding ? <Yes /> : <No />) },
    { key: "enable_pipeline_automation", label: labels.enable_pipeline_automation?.label || "Pipeline automation", render: (t) => (t.capabilities?.enable_pipeline_automation ? <Yes /> : <No />) },
  ]

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">What your plan includes</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="border-b border-slate-200 p-2 text-left font-medium text-slate-500">Feature</th>
              {tiers.map((t) => (
                <th key={t.id} className={`border-b border-slate-200 p-2 text-center font-semibold ${t.id === currentTierId ? "text-emerald-700" : "text-slate-800"}`}>
                  {t.name}
                  {t.id === currentTierId ? <div className="mt-1"><Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">Your plan</Badge></div> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="odd:bg-slate-50/50">
                <td className="border-b border-slate-100 p-2 text-slate-600">{r.label}</td>
                {tiers.map((t) => (
                  <td key={t.id} className={`border-b border-slate-100 p-2 text-center ${t.id === currentTierId ? "bg-emerald-50/40" : ""}`}>{r.render(t)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Capability explanations + discounts in plain English */}
        <div className="mt-4 space-y-1 text-xs text-slate-500">
          {Object.values(labels).map((l) => (
            <p key={l.label}><strong className="text-slate-700">{l.label}:</strong> {l.plain}</p>
          ))}
          {Array.isArray(data.discounts) && data.discounts.length ? (
            <p className="pt-1">
              <strong className="text-slate-700">Discounts:</strong>{" "}
              {data.discounts.map((d) => `${d.label} (${d.percent}% off)`).join(" · ")} — applied by an administrator on top of any plan.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
