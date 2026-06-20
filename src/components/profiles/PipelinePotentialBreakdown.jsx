/**
 * PipelinePotentialBreakdown
 *
 * Turns a profile's "Pipeline Potential" figure into a clickable drill-down.
 * Clicking the card opens a dialog listing every funding source that makes up
 * the number, each with a short description, its dollar amount or range, the
 * deadline to apply, and its current pipeline stage (so you can see whether
 * it's still being prepared, has been applied for, etc.).
 *
 * Data: GET /api/profiles/:id/pipeline-potential — the same active-status set
 * the headline figure is summed from, so the rows always reconcile to the
 * total shown on the card.
 *
 * This is private, per-profile pipeline data — the endpoint is scoped to people
 * who can already see the profile.
 */

import React, { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import client from "@/api/client"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import HelpTip from "@/components/help/HelpTip"
import { getStageHelp } from "@/components/pipeline/pipelineStageHelp"
import { Loader2, ExternalLink, CalendarClock, ChevronRight, Printer } from "lucide-react"
import { createPageUrl } from "@/utils"

// Stage label + tone, mirroring the pipeline board (KanbanBoard STATUSES) and
// covering the legacy status names the backend still tracks. Anything unmapped
// is humanized from its raw value so a new status never renders blank.
const STAGE_META = {
  discovered: { label: "Discovered", phase: "Preparing", tone: "bg-slate-100 text-slate-700" },
  discovery: { label: "Discovered", phase: "Preparing", tone: "bg-slate-100 text-slate-700" },
  interested: { label: "Interested", phase: "Preparing", tone: "bg-blue-100 text-blue-800" },
  gathering_documents: { label: "Gathering Documents", phase: "Preparing", tone: "bg-amber-100 text-amber-800" },
  app_prep: { label: "Application Prep", phase: "Preparing", tone: "bg-amber-100 text-amber-800" },
  application_prep: { label: "Application Prep", phase: "Preparing", tone: "bg-amber-100 text-amber-800" },
  drafting: { label: "Drafting", phase: "Preparing", tone: "bg-purple-100 text-purple-800" },
  revision: { label: "In Revision", phase: "Preparing", tone: "bg-purple-100 text-purple-800" },
  ready_to_submit: { label: "Ready to Submit", phase: "Preparing", tone: "bg-orange-100 text-orange-800" },
  auto_applied: { label: "Auto-Applied", phase: "Applied", tone: "bg-indigo-100 text-indigo-800" },
  portal: { label: "In Portal", phase: "Applied", tone: "bg-indigo-100 text-indigo-800" },
  submitted: { label: "Submitted", phase: "Applied", tone: "bg-indigo-100 text-indigo-800" },
  pending_review: { label: "Pending Review", phase: "Applied", tone: "bg-teal-100 text-teal-800" },
  under_review: { label: "Under Review", phase: "Applied", tone: "bg-teal-100 text-teal-800" },
  follow_up: { label: "Follow Up", phase: "Applied", tone: "bg-teal-100 text-teal-800" },
  report: { label: "Reporting", phase: "Applied", tone: "bg-teal-100 text-teal-800" },
  awarded: { label: "Awarded", phase: "Approved", tone: "bg-emerald-100 text-emerald-800" },
}

function humanize(status) {
  return String(status || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Unknown"
}

function stageMeta(status) {
  return STAGE_META[status] || { label: humanize(status), phase: "Preparing", tone: "bg-slate-100 text-slate-700" }
}

// Plain-English explanation of each status badge, shown on hover. Reuses the
// canonical PIPELINE_STAGE_HELP map (getStageHelp) so wording stays in sync with
// the Kanban board. A couple of STAGE_META keys aren't in that map yet, so we
// fill them in here.
const EXTRA_STAGE_HELP = {
  gathering_documents: "Collecting the forms, attachments, and supporting files the funder requires before the application can be written.",
  ready_to_submit: "The application is complete and ready — it just needs to be sent or submitted through the funder's portal.",
}

function stageHelpText(status) {
  const extra = EXTRA_STAGE_HELP[status]
  if (extra) return extra
  return getStageHelp(status).plainEnglish
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

function formatAmount(item) {
  const req = Number(item?.amount_requested)
  if (Number.isFinite(req) && req > 0) return usd.format(Math.round(req))
  const min = Number(item?.amount_min)
  const max = Number(item?.amount_max)
  const hasMin = Number.isFinite(min) && min > 0
  const hasMax = Number.isFinite(max) && max > 0
  if (hasMin && hasMax) return min === max ? usd.format(Math.round(min)) : `${usd.format(Math.round(min))} – ${usd.format(Math.round(max))}`
  if (hasMin) return `From ${usd.format(Math.round(min))}`
  if (hasMax) return `Up to ${usd.format(Math.round(max))}`
  return "Amount varies"
}

function formatDeadline(deadline) {
  if (!deadline) return "No deadline"
  if (String(deadline).toLowerCase() === "rolling") return "Rolling"
  const d = new Date(deadline)
  return Number.isNaN(d.getTime()) ? String(deadline) : d.toLocaleDateString()
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Build a clean, self-contained printable document for the breakdown and open
 * it in a new window. The browser's print dialog handles both physical printing
 * and "Save as PDF" — no server-side PDF dependency needed. `@media print`
 * trims chrome so the saved PDF is just the table.
 */
function openPrintableBreakdown({ profileName, formattedTotal, items }) {
  if (typeof window === "undefined") return
  const win = window.open("", "_blank", "noopener,noreferrer,width=900,height=1100")
  if (!win) return // popup blocked — caller surfaces nothing; the in-app dialog still works

  const generatedAt = new Date().toLocaleString()
  const rows = items
    .map((item) => {
      const meta = stageMeta(item.status)
      return `
        <tr>
          <td>
            <div class="title">${escapeHtml(item.title || "Untitled source")}</div>
            ${item.funder ? `<div class="funder">${escapeHtml(item.funder)}</div>` : ""}
            ${item.description ? `<div class="desc">${escapeHtml(item.description)}</div>` : ""}
          </td>
          <td class="num">${escapeHtml(formatAmount(item))}</td>
          <td>${escapeHtml(formatDeadline(item.deadline))}</td>
          <td>${escapeHtml(meta.label)}<div class="phase">${escapeHtml(meta.phase)}</div></td>
        </tr>`
    })
    .join("")

  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Pipeline Potential Breakdown${profileName ? ` — ${escapeHtml(profileName)}` : ""}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #475569; font-size: 12px; margin-bottom: 4px; }
  .total { font-size: 16px; font-weight: 700; margin: 12px 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; border-bottom: 2px solid #cbd5e1; padding: 8px 6px; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; color: #64748b; }
  td { border-bottom: 1px solid #e2e8f0; padding: 8px 6px; vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .title { font-weight: 600; }
  .funder { color: #64748b; font-size: 11px; }
  .desc { color: #475569; font-size: 11px; margin-top: 3px; }
  .phase { color: #94a3b8; font-size: 10px; text-transform: uppercase; }
  .foot { margin-top: 14px; font-size: 11px; color: #64748b; display: flex; justify-content: space-between; }
  .print-btn { margin: 16px 0; padding: 8px 14px; font-size: 13px; border: 1px solid #6366f1; background: #6366f1; color: #fff; border-radius: 6px; cursor: pointer; }
  @media print { .print-btn { display: none; } body { margin: 0; } }
</style>
</head>
<body>
  <h1>Pipeline Potential Breakdown</h1>
  ${profileName ? `<div class="sub">${escapeHtml(profileName)}</div>` : ""}
  <div class="sub">Generated ${escapeHtml(generatedAt)} · ${items.length} funding source${items.length === 1 ? "" : "s"}</div>
  <div class="total">Total potential: ${escapeHtml(formattedTotal)}</div>
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <table>
    <thead>
      <tr><th>Funding source</th><th class="num">Amount</th><th>Deadline</th><th>Stage</th></tr>
    </thead>
    <tbody>${rows || `<tr><td colspan="4">No active funding sources.</td></tr>`}</tbody>
  </table>
  <div class="foot">
    <span>Unrealized potential — already-awarded and closed sources excluded.</span>
    <span>Total: ${escapeHtml(formattedTotal)}</span>
  </div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
</body>
</html>`)
  win.document.close()
}

export default function PipelinePotentialBreakdown({
  profileId,
  formattedTotal,
  profileName = "",
  cardClassName = "",
  labelClassName = "",
}) {
  const [open, setOpen] = useState(false)

  const query = useQuery({
    queryKey: ["pipeline-potential", profileId],
    queryFn: () => client.get(`/api/profiles/${profileId}/pipeline-potential`),
    enabled: open && Boolean(profileId),
    staleTime: 30_000,
  })

  const items = Array.isArray(query.data?.items) ? query.data.items : []

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded-2xl border px-4 py-3 text-left transition hover:shadow-md hover:brightness-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-400 ${cardClassName}`}
        title="See which funding sources make up this number"
        aria-label="Open pipeline potential breakdown"
      >
        <p className={`text-xs font-medium uppercase tracking-wide flex items-center gap-1 ${labelClassName}`}>
          Pipeline Potential
          <ChevronRight className="w-3 h-3 opacity-70" />
        </p>
        <p className="text-2xl font-bold mt-1">{formattedTotal}</p>
        <p className="text-[11px] opacity-70 mt-0.5">Click to see the breakdown</p>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <DialogTitle>Pipeline Potential — {formattedTotal}</DialogTitle>
                <DialogDescription>
                  The funding sources that make up this profile's potential, with amount, deadline, and where each sits in the pipeline.
                  Already-awarded and closed sources are excluded — this is unrealized potential.
                </DialogDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={query.isLoading || query.isError || items.length === 0}
                onClick={() => openPrintableBreakdown({ profileName, formattedTotal, items })}
                title="Open a printable view — use your browser's print dialog to save as PDF"
              >
                <Printer className="w-3 h-3 mr-1" /> Print / Save PDF
              </Button>
            </div>
          </DialogHeader>

          {query.isLoading ? (
            <div className="py-10 flex items-center justify-center text-slate-500 gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading breakdown…
            </div>
          ) : query.isError ? (
            <div className="py-6 text-sm text-rose-700">Could not load the breakdown. Please try again.</div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-600">
              No active funding sources are contributing to this profile's pipeline potential yet.
            </div>
          ) : (
            <ul className="space-y-2 max-h-[60vh] overflow-auto pr-1">
              {items.map((item) => {
                const meta = stageMeta(item.status)
                return (
                  <li key={item.id} className="rounded-lg border border-slate-200 p-3 hover:border-slate-300">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 leading-snug">{item.title || "Untitled source"}</div>
                        {item.funder && <div className="text-xs text-slate-500">{item.funder}</div>}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-semibold text-slate-900 whitespace-nowrap">{formatAmount(item)}</div>
                        <div className="flex items-center justify-end gap-1 text-[11px] text-slate-500 mt-0.5">
                          <CalendarClock className="w-3 h-3" /> {formatDeadline(item.deadline)}
                        </div>
                      </div>
                    </div>

                    {item.description && (
                      <p className="text-xs text-slate-600 mt-1.5 line-clamp-2">{item.description}</p>
                    )}

                    <div className="flex items-center justify-between gap-2 mt-2">
                      <div className="flex items-center gap-2">
                        <HelpTip text={stageHelpText(item.status)}>
                          <span className="inline-flex cursor-help">
                            <Badge
                              variant="outline"
                              className={`text-[10px] border-transparent ${meta.tone}`}
                            >
                              {meta.label}
                            </Badge>
                          </span>
                        </HelpTip>
                        <span className="text-[10px] uppercase tracking-wide text-slate-400">{meta.phase}</span>
                      </div>
                      <a
                        href={createPageUrl("GrantDetail", { id: item.id })}
                        className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                      >
                        Open <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {!query.isLoading && !query.isError && items.length > 0 && (
            <div className="border-t border-slate-100 pt-3 text-xs text-slate-500 flex items-center justify-between">
              <span>{items.length} funding source{items.length === 1 ? "" : "s"} in the pipeline</span>
              <span className="font-semibold text-slate-700">Total: {formattedTotal}</span>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
