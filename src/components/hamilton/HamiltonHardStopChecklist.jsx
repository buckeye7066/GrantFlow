/**
 * HamiltonHardStopChecklist
 *
 * The actionable twin of the Hamilton hard-stop toasts. The toasts tell you a
 * stop happened; this checklist — rendered right on the "Process with Hamilton"
 * window — turns every open stop into a row you can click to go straight to
 * where it's fixed, with step-by-step instructions, plus a "Mark done" control
 * that clears the stop and removes it from the list.
 *
 * Data: GET /api/hamilton/automation/admin/hard-stops (admin-only — the
 * canonical operator). Scoped client-side to the profile being processed.
 * Resolution: POST /api/hamilton/automation/admin/hard-stops/:id/resolve.
 *
 * Where-to-go + what-to-do per blocker_type live in
 * config/hamiltonHardStopTargets.js so this component stays presentational.
 */

import React, { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import client from "@/api/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, RefreshCw } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { showErrorToast, showSuccessToast } from "@/components/shared/toastHelpers"
import { resolveHardStopTarget } from "@/config/hamiltonHardStopTargets"

function severityClass(s) {
  switch (s) {
    case "error":   return "bg-rose-50 border-rose-200"
    case "warning": return "bg-amber-50 border-amber-200"
    default:        return "bg-slate-50 border-slate-200"
  }
}

export default function HamiltonHardStopChecklist({ profileId }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [blockers, setBlockers] = useState([])
  const [resolvingId, setResolvingId] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await client.get("/api/hamilton/automation/admin/hard-stops")
      const all = Array.isArray(res?.blockers) ? res.blockers : []
      // The admin endpoint returns every open stop system-wide; show only the
      // ones for the profile this processing window is about.
      const scoped = profileId
        ? all.filter((b) => String(b.profile_id) === String(profileId))
        : all
      setBlockers(scoped)
      setLoadFailed(false)
    } catch {
      // 403 for non-admins (or a transient error) — hide the section entirely
      // rather than render a broken box.
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [profileId])

  useEffect(() => { load() }, [load])

  async function resolve(blocker) {
    setResolvingId(blocker.id)
    // Optimistically remove so "take it off the list" feels instant; the server
    // is still the source of truth and we restore the row if the call fails.
    setBlockers((prev) => prev.filter((b) => b.id !== blocker.id))
    try {
      await client.post(`/api/hamilton/automation/admin/hard-stops/${blocker.id}/resolve`, {})
      showSuccessToast(
        toast,
        "Hard stop cleared",
        `"${blocker.blocker_title || blocker.blocker_type}" removed from the list.`,
      )
    } catch (err) {
      setBlockers((prev) => [blocker, ...prev])
      showErrorToast(toast, "Could not clear hard stop", err?.message || "See logs.")
    } finally {
      setResolvingId(null)
    }
  }

  // Hidden for non-admins / when the endpoint is unreachable.
  if (loadFailed) return null

  return (
    <div className="rounded-lg border border-amber-200 bg-white mb-4 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 bg-amber-50 border-b border-amber-200">
        <h2 className="text-sm font-semibold text-amber-900 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          Hamilton hard stops to clear
          <Badge variant="outline" className="ml-1">{blockers.length}</Badge>
        </h2>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading} title="Refresh hard stops">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>

      {blockers.length === 0 ? (
        <div className="px-4 py-3 text-sm text-emerald-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          {loading ? "Checking for hard stops…" : "No open hard stops for this profile. Hamilton is clear to run."}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {blockers.map((b) => {
            const target = resolveHardStopTarget(b)
            const isResolving = resolvingId === b.id
            return (
              <li key={b.id} className={`px-4 py-3 ${severityClass(b.severity)} border-l-4`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">
                      {b.blocker_title || b.blocker_type}
                    </div>
                    {b.blocker_message && (
                      <div className="text-xs text-slate-600 mt-0.5">{b.blocker_message}</div>
                    )}
                    <span className="mt-1 inline-block text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-slate-300 text-slate-600 bg-white">
                      {String(b.blocker_type).replace(/_/g, " ")}
                    </span>
                    {b.deadline_at && (
                      <span className="ml-2 text-[11px] text-amber-800">
                        Deadline: {new Date(b.deadline_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                    onClick={() => resolve(b)}
                    disabled={isResolving}
                    title="Mark this hard stop resolved and remove it from the list"
                  >
                    {isResolving ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                    Mark done
                  </Button>
                </div>

                {/* What to do once you get there */}
                <ol className="mt-2 ml-1 space-y-0.5 text-xs text-slate-600 list-decimal list-inside">
                  {target.instructions.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ol>

                {/* Click to go straight to where it's fixed */}
                <Link
                  to={target.href}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:text-indigo-900 hover:underline"
                >
                  {target.actionLabel}
                  <span className="text-slate-400">· {target.fixedWhere}</span>
                  <ChevronRight className="w-3 h-3" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
