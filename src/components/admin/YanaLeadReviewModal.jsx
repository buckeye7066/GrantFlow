/**
 * YanaLeadReviewModal — review modal for Yana's Lead Discovery & Outreach pipeline.
 *
 * Formerly named LarryLeadReviewModal. Backend route paths
 * (/api/larry/*) are still served for backward compatibility, but the
 * UI now calls the canonical /api/yana-leads/* alias.
 */
import React, { useEffect, useState } from "react"
import { Loader2, Mail, Send, ShieldAlert, X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

async function get(path) {
  return apiFetch(path)
}
async function post(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) })
}

function ReasonList({ reasons, kind }) {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return <span className="text-slate-500 text-xs">No {kind} signals.</span>
  }
  return (
    <ul className="text-xs space-y-1">
      {reasons.map((r, i) => (
        <li key={i}>
          <span className="font-mono text-[11px] text-slate-700">{r.code || "?"}</span>
          {r.detail ? <span className="text-slate-500"> — {r.detail}</span> : null}
        </li>
      ))}
    </ul>
  )
}

export default function YanaLeadReviewModal({ leadId, open, onClose, onAfterChange }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lead, setLead] = useState(null)
  const [attempts, setAttempts] = useState([])

  useEffect(() => {
    if (!leadId || !open) return
    let alive = true
    setLoading(true)
    get(`/api/yana-leads/leads/${encodeURIComponent(leadId)}`)
      .then((res) => {
        if (!alive) return
        if (res?.ok) {
          setLead(res.lead)
          setAttempts(Array.isArray(res.attempts) ? res.attempts : [])
        }
      })
      .catch((err) => {
        if (!alive) return
        toast({
          title: "Failed to load lead",
          description: err?.message || String(err),
          variant: "destructive",
        })
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [leadId, open, toast])

  const reload = async () => {
    if (!leadId) return
    setLoading(true)
    try {
      const res = await get(`/api/yana-leads/leads/${encodeURIComponent(leadId)}`)
      if (res?.ok) {
        setLead(res.lead)
        setAttempts(Array.isArray(res.attempts) ? res.attempts : [])
      }
    } finally {
      setLoading(false)
    }
  }

  const approveLead = async () => {
    if (!leadId) return
    setBusy(true)
    try {
      const res = await post(`/api/yana-leads/leads/${encodeURIComponent(leadId)}/approve`, {})
      if (res?.ok) {
        toast({ title: "Lead approved for outreach" })
        await reload()
        onAfterChange?.()
      }
    } catch (err) {
      toast({
        title: "Approve failed",
        description: err?.message || String(err),
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  const archiveLead = async () => {
    if (!leadId) return
    setBusy(true)
    try {
      const res = await post(`/api/yana-leads/leads/${encodeURIComponent(leadId)}/archive`, {
        reason: "admin_archived",
      })
      if (res?.ok) {
        toast({ title: "Lead archived" })
        onAfterChange?.()
        onClose?.()
      }
    } catch (err) {
      toast({
        title: "Archive failed",
        description: err?.message || String(err),
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  const dnc = async () => {
    if (!lead?.prospect_candidate_id) return
    setBusy(true)
    try {
      const res = await post(
        `/api/yana-leads/relationships/${encodeURIComponent(lead.prospect_candidate_id)}/dnc`,
        { reason: "admin_dnc" },
      )
      if (res?.ok) {
        toast({ title: "Marked Do Not Contact" })
        onAfterChange?.()
        onClose?.()
      }
    } catch (err) {
      toast({
        title: "DNC failed",
        description: err?.message || String(err),
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  const approveAttempt = async (id) => {
    setBusy(true)
    try {
      const res = await post(`/api/yana-leads/outreach/${encodeURIComponent(id)}/approve`, {})
      if (res?.ok) {
        toast({ title: "Outreach approved" })
        await reload()
        onAfterChange?.()
      }
    } catch (err) {
      toast({
        title: "Approve failed",
        description: err?.message || String(err),
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  const sendAttempt = async (id, dryRun = false) => {
    setBusy(true)
    try {
      const res = await post(`/api/yana-leads/outreach/${encodeURIComponent(id)}/send`, { dryRun })
      const blockedReason = res?.blocked?.reason
      if (res?.ok) {
        toast({ title: dryRun ? "Dry-run send completed" : "Outreach sent" })
      } else {
        toast({
          title: "Send blocked",
          description: blockedReason || "Send did not complete",
          variant: "destructive",
        })
      }
      await reload()
      onAfterChange?.()
    } catch (err) {
      toast({
        title: "Send failed",
        description: err?.message || String(err),
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  const cancelAttempt = async (id) => {
    setBusy(true)
    try {
      const res = await post(`/api/yana-leads/outreach/${encodeURIComponent(id)}/cancel`, {
        reason: "admin_cancel",
      })
      if (res?.ok) {
        toast({ title: "Outreach cancelled" })
        await reload()
        onAfterChange?.()
      }
    } catch (err) {
      toast({
        title: "Cancel failed",
        description: err?.message || String(err),
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  const packet = lead?.packet_json || {}
  const scoring = packet.scoring || {}
  const contact = packet.primary_contact || {}
  const address = packet.address || {}

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose?.() : null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-amber-600" />
            {packet.organization_name || "Lead"}
            {lead?.approved_for_outreach ? (
              <Badge className="bg-emerald-100 text-emerald-700">Approved</Badge>
            ) : (
              <Badge variant="outline">Pending</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading || !lead ? (
          <div className="py-10 text-center text-sm text-slate-500">
            <Loader2 className="w-4 h-4 inline mr-2 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            <Alert>
              <ShieldAlert className="w-4 h-4" />
              <AlertDescription className="text-xs">
                Yana never sends outreach without explicit per-attempt approval. Send is
                additionally gated by the suppression list, the relationship cooldown, and the
                daily send cap.
              </AlertDescription>
            </Alert>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-slate-500">Type</div>
                <div>{packet.applicant_type || packet.organization_type || "—"}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Location</div>
                <div>
                  {[address.city, address.state].filter(Boolean).join(", ") || "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Contact</div>
                <div>{contact.name || "—"}</div>
                <div className="text-xs text-slate-500">{contact.role || ""}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Email / phone</div>
                <div className="text-xs">{contact.email || "—"}</div>
                <div className="text-xs">{contact.phone || "—"}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Website</div>
                <div className="text-xs break-all">{packet.website_url || "—"}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">EIN</div>
                <div className="text-xs">{packet.ein || "—"}</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded border bg-slate-50 p-2">
                <div className="text-xs text-slate-500">Fit</div>
                <div className="text-lg font-semibold">{scoring.fit_score ?? "—"}</div>
                <ReasonList reasons={scoring.fit_reasons} kind="fit" />
              </div>
              <div className="rounded border bg-slate-50 p-2">
                <div className="text-xs text-slate-500">Urgency</div>
                <div className="text-lg font-semibold">{scoring.urgency_score ?? "—"}</div>
                <ReasonList reasons={scoring.urgency_reasons} kind="urgency" />
              </div>
              <div className="rounded border bg-slate-50 p-2">
                <div className="text-xs text-slate-500">Composite</div>
                <div className="text-lg font-semibold">{scoring.composite_score ?? "—"}</div>
                <div className="text-xs text-slate-500">
                  Recommended: {packet.recommendation?.channel || "email"}
                </div>
              </div>
            </div>

            {packet.recommendation?.pitch ? (
              <div className="rounded border bg-amber-50 p-2 text-xs">
                <div className="font-semibold mb-1">Suggested pitch</div>
                <p>{packet.recommendation.pitch}</p>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-700">Outreach attempts</div>
              {attempts.length === 0 ? (
                <div className="text-xs text-slate-500">
                  No drafts yet. Run "Draft outreach" to generate one.
                </div>
              ) : (
                <div className="space-y-2">
                  {attempts.map((a) => (
                    <div key={a.id} className="rounded border p-2 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-[10px] text-slate-500">{a.id}</div>
                        <Badge variant="outline">{a.send_status}</Badge>
                      </div>
                      <div>
                        <span className="text-slate-500">Subject:</span> {a.draft_subject || "—"}
                      </div>
                      {a.draft_text ? (
                        <pre className="whitespace-pre-wrap text-[11px] bg-slate-50 p-2 rounded max-h-40 overflow-auto">
                          {a.draft_text}
                        </pre>
                      ) : null}
                      <div className="flex flex-wrap gap-2 pt-1">
                        {!a.approved_at ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => approveAttempt(a.id)}
                            disabled={busy}
                          >
                            Approve
                          </Button>
                        ) : null}
                        {a.approved_at && a.send_status !== "sent" ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => sendAttempt(a.id, true)}
                              disabled={busy}
                            >
                              Dry-run send
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => sendAttempt(a.id, false)}
                              disabled={busy}
                            >
                              <Send className="w-3 h-3 mr-1" /> Send
                            </Button>
                          </>
                        ) : null}
                        {a.send_status !== "sent" && a.send_status !== "cancelled" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => cancelAttempt(a.id)}
                            disabled={busy}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={onClose}>
            <X className="w-4 h-4 mr-1" />
            Close
          </Button>
          <Button variant="outline" onClick={archiveLead} disabled={busy || !lead}>
            Archive lead
          </Button>
          <Button variant="destructive" onClick={dnc} disabled={busy || !lead}>
            Do not contact
          </Button>
          {lead && !lead.approved_for_outreach ? (
            <Button onClick={approveLead} disabled={busy}>
              Approve for outreach
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
