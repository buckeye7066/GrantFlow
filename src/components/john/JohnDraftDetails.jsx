import React, { useCallback, useEffect, useState } from "react"
import { Loader2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

export default function JohnDraftDetails({ draftId, onClose, onChanged }) {
  const { toast } = useToast()
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const safeOnClose = onClose ?? (() => {})

  const load = useCallback(async () => {
    if (!draftId) return
    setLoading(true)
    try {
      const res = await apiFetch(`/api/john/drafts/${draftId}`)
      setDraft(res?.draft || null)
      setSubject(res?.draft?.subject || "")
      setBody(res?.draft?.body_text || "")
    } catch (err) {
      toast({
        title: "Failed to load draft",
        description: err.message,
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [draftId, toast])

  useEffect(() => {
    load()
  }, [load])

  const revise = async () => {
    setSaving(true)
    try {
      const res = await apiFetch(`/api/john/drafts/${draftId}/revise`, {
        method: "POST",
        body: JSON.stringify({ subject, body_text: body }),
      })
      if (res?.ok) {
        toast({ title: "Draft revised" })
        onChanged?.()
      } else {
        toast({
          title: "Revision blocked",
          description: (res?.blocked_reasons || []).join(", "),
          variant: "destructive",
        })
      }
    } catch (err) {
      toast({ title: "Revise failed", description: err.message, variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  if (!draftId) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div>
            <div className="text-base font-semibold text-slate-900">
              John Draft &middot; {draft?.organization_name || "—"}
            </div>
            <div className="text-xs text-slate-500">
              {draft?.recipient_email || "—"} · status:{" "}
              <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">
                {draft?.draft_status || "—"}
              </Badge>
              {draft?.needs_sender_alias_review ? (
                <Badge
                  variant="outline"
                  className="ml-2 bg-amber-50 text-amber-800 border-amber-200"
                >
                  Needs alias review
                </Badge>
              ) : null}
            </div>
          </div>
          <Button onClick={safeOnClose} variant="ghost" size="icon">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="px-5 py-4 overflow-auto space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-slate-500">From mailbox:</span>{" "}
                  <span className="text-slate-800">{draft?.from_mailbox || "—"}</span>
                </div>
                <div>
                  <span className="text-slate-500">From alias (set):</span>{" "}
                  <span className="text-slate-800">{draft?.from_alias || "—"}</span>
                </div>
                <div>
                  <span className="text-slate-500">Reply-To:</span>{" "}
                  <span className="text-slate-800">{draft?.reply_to || "—"}</span>
                </div>
                <div>
                  <span className="text-slate-500">Provider draft id:</span>{" "}
                  <span className="text-slate-800 break-all">{draft?.provider_draft_id || "—"}</span>
                </div>
              </div>

              <div className="space-y-1">
                <Label>Subject</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Body</Label>
                <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
              </div>

              {draft?.alias_report_json ? (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
                  <div className="font-medium mb-1 text-slate-700">Alias report</div>
                  <pre className="whitespace-pre-wrap text-slate-700">
                    {JSON.stringify(draft.alias_report_json, null, 2)}
                  </pre>
                </div>
              ) : null}

              {draft?.safety_report_json ? (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
                  <div className="font-medium mb-1 text-slate-700">Safety report</div>
                  <pre className="whitespace-pre-wrap text-slate-700">
                    {JSON.stringify(draft.safety_report_json, null, 2)}
                  </pre>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50">
          <Button onClick={safeOnClose} variant="outline" disabled={saving}>
            Close
          </Button>
          <Button onClick={revise} disabled={saving || loading}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Save Revision
          </Button>
        </div>
      </div>
    </div>
  )
}
