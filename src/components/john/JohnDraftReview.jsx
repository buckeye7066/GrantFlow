import React, { useCallback, useEffect, useState } from "react"
import { Archive, FileText, Loader2, RefreshCw } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

import JohnDraftDetails from "@/components/john/JohnDraftDetails"

const STATUS_BADGE = {
  created: { label: "Created", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  needs_review: { label: "Needs review", className: "bg-blue-100 text-blue-700 border-blue-200" },
  needs_sender_alias_review: {
    label: "Needs alias review",
    className: "bg-amber-100 text-amber-800 border-amber-200",
  },
  blocked: { label: "Blocked", className: "bg-rose-100 text-rose-700 border-rose-200" },
  failed: { label: "Failed", className: "bg-rose-100 text-rose-700 border-rose-200" },
  archived: { label: "Archived", className: "bg-slate-100 text-slate-600 border-slate-200" },
  reviewed: { label: "Reviewed", className: "bg-violet-100 text-violet-700 border-violet-200" },
  sent_manually: { label: "Sent manually", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
}

function StatusBadge({ status }) {
  const info = STATUS_BADGE[status] || { label: status, className: "bg-slate-100 text-slate-700 border-slate-200" }
  return (
    <Badge variant="outline" className={info.className}>
      {info.label}
    </Badge>
  )
}

export default function JohnDraftReview({ refreshTick = 0 }) {
  const { toast } = useToast()
  const [drafts, setDrafts] = useState([])
  const [loading, setLoading] = useState(false)
  const [openDraftId, setOpenDraftId] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch("/api/john/drafts?limit=100")
      setDrafts(Array.isArray(res?.drafts) ? res.drafts : [])
    } catch (err) {
      toast({ title: "Failed to load drafts", description: err.message, variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh, refreshTick])

  const archive = async (id) => {
    if (!id) return
    try {
      await apiFetch(`/api/john/drafts/${id}/archive`, {
        method: "POST",
        body: JSON.stringify({ reason: "manual_archive" }),
      })
      toast({ title: "Draft archived" })
      refresh()
    } catch (err) {
      toast({ title: "Archive failed", description: err.message, variant: "destructive" })
    }
  }

  return (
    <Card className="border border-slate-200 bg-white/70 backdrop-blur">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-blue-600" /> John Drafts
        </CardTitle>
        <Button onClick={() => refresh()} variant="outline" size="sm" disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2">Organization</th>
                <th className="px-2 py-2">Recipient</th>
                <th className="px-2 py-2">Subject</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Alias</th>
                <th className="px-2 py-2">Safety</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {drafts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-6 text-center text-slate-500 text-sm">
                    No drafts yet.
                  </td>
                </tr>
              ) : (
                drafts.map((d) => (
                  <tr key={d.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-2 py-2 font-medium text-slate-800">
                      {d.organization_name || "—"}
                    </td>
                    <td className="px-2 py-2 text-slate-700">{d.recipient_email || "—"}</td>
                    <td className="px-2 py-2 text-slate-700 max-w-md truncate" title={d.subject}>
                      {d.subject || "—"}
                    </td>
                    <td className="px-2 py-2">
                      <StatusBadge status={d.draft_status} />
                    </td>
                    <td className="px-2 py-2">
                      {d.fallback_used ? (
                        <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">
                          Fallback
                        </Badge>
                      ) : d.from_alias ? (
                        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                          Alias set
                        </Badge>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <Badge
                        variant="outline"
                        className={
                          d.safety_status === "passed"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-rose-50 text-rose-700 border-rose-200"
                        }
                      >
                        {d.safety_status || "—"}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-right space-x-1">
                      <Button size="sm" variant="outline" onClick={() => setOpenDraftId(d.id)}>
                        View
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => archive(d.id)}
                        disabled={d.draft_status === "archived"}
                      >
                        <Archive className="w-3.5 h-3.5 mr-1" /> Archive
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>

      {openDraftId ? (
        <JohnDraftDetails
          draftId={openDraftId}
          onClose={() => setOpenDraftId(null)}
          onChanged={() => refresh()}
        />
      ) : null}
    </Card>
  )
}
