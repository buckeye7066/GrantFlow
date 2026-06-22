/**
 * AdminYanaConsole — admin UI for Yana's Lead Discovery & Outreach pipeline.
 *
 * Formerly named AdminLarryConsole. Yana is GrantFlow's canonical
 * lead-discovery agent (see backend/services/agentControl/agentControlTypes.js).
 * The backend service files in backend/services/larry/ implement this
 * pipeline; their filenames are preserved for stability while the
 * user-facing identity is unified under "Yana".
 */
import React, { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mail,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  Send,
  XCircle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"
import YanaLeadReviewModal from "@/components/admin/YanaLeadReviewModal"

async function get(path) {
  return apiFetch(path)
}

async function post(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) })
}

const RUN_BUTTONS = [
  { mode: "discover-prospects", label: "Discover prospects" },
  { mode: "verify-contacts", label: "Verify contacts" },
  { mode: "score-fit", label: "Score fit" },
  { mode: "build-packets", label: "Build packets" },
  { mode: "qualify", label: "Qualify" },
  { mode: "draft-outreach", label: "Draft outreach" },
  { mode: "full-cycle", label: "Full cycle" },
]

function safeFormatTime(value) {
  if (!value) return "—"
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

export default function AdminYanaConsole() {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [runs, setRuns] = useState([])
  const [leads, setLeads] = useState([])
  const [selectedLeadId, setSelectedLeadId] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [s, r, l] = await Promise.all([
        get("/api/yana-leads/status"),
        get("/api/yana-leads/runs?limit=10"),
        get("/api/yana-leads/leads?limit=50"),
      ])
      setStatus(s)
      setRuns(Array.isArray(r?.runs) ? r.runs : [])
      setLeads(Array.isArray(l?.leads) ? l.leads : [])
    } catch (err) {
      toast({
        title: "Failed to load Yana status",
        description: err?.message || String(err),
        variant: "destructive",
      })
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const run = async (mode) => {
    setBusy(true)
    try {
      const res = await post("/api/yana-leads/run", { mode })
      toast({
        title: `Yana: ${mode}`,
        description: res?.ok ? `run_id=${res.run_id || "(none)"}` : res?.reason || "completed",
      })
      await refresh()
    } catch (err) {
      toast({
        title: `Yana ${mode} failed`,
        description: err?.message || String(err),
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  // Yana's discovery + drafting are ALWAYS available — she finds leads and saves
  // drafts for review; she never sends email. The badge therefore never reads a
  // bare "Disabled" (that would wrongly imply Yana is broken). It reflects only
  // the SEPARATE, manual send step's switch.
  const enabledBadge = useMemo(() => {
    if (!status) return null
    return (
      <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        Finding leads
      </Badge>
    )
  }, [status])

  const sendStepBadge = useMemo(() => {
    if (!status) return null
    const sendOn = status.send_step_enabled ?? status.enabled
    return sendOn ? (
      <Badge className="bg-amber-100 text-amber-700 border border-amber-200">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        Manual send: on
      </Badge>
    ) : (
      <Badge className="bg-slate-100 text-slate-700 border border-slate-200">
        <XCircle className="w-3 h-3 mr-1" />
        Manual send: off
      </Badge>
    )
  }, [status])

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-amber-600" />
            Yana — Lead Discovery & Drafting Agent
            {enabledBadge}
            {sendStepBadge}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <ShieldAlert className="w-4 h-4" />
            <AlertDescription>
              <p className="text-sm">
                Yana finds likely GrantFlow <strong>clients</strong>, verifies public contact info,
                scores fit and urgency, builds lead packets, and <strong>drafts outreach</strong>.
                Drafts are <strong>saved for your review</strong> (in the canonical pipeline John
                saves them to your Outlook draft folder) — <strong>Yana never sends email</strong>.
                Sending is a separate, manual step you do yourself. Yana is <strong>not</strong> Anya,
                Robert, or a code-fixing agent.
              </p>
              {status ? (
                <p className="mt-2 text-[11px] text-slate-500">
                  mode={status.mode} · manual_send_daily_cap=
                  {status.manual_send_daily_cap ?? status.daily_send_cap} · approval_required=
                  {String(status.require_approval_to_send)} · live_web=
                  {String(status.allow_live_web)}
                </p>
              ) : null}
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2">
            {RUN_BUTTONS.map((b) => (
              <Button key={b.mode} onClick={() => run(b.mode)} disabled={busy} variant="outline">
                {busy ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <PlayCircle className="w-4 h-4 mr-2" />
                )}
                {b.label}
              </Button>
            ))}
            <Button onClick={refresh} variant="ghost">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="w-4 h-4 text-amber-600" />
            Lead queue
          </CardTitle>
        </CardHeader>
        <CardContent>
          {leads.length === 0 ? (
            <div className="text-sm text-slate-500">
              No leads yet. Run discovery → verify → score → qualify to populate the queue.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b">
                    <th className="py-1 pr-2">Lead</th>
                    <th className="py-1 pr-2">Fit</th>
                    <th className="py-1 pr-2">Urgency</th>
                    <th className="py-1 pr-2">Composite</th>
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">Approved</th>
                    <th className="py-1 pr-2">Updated</th>
                    <th className="py-1 pr-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id} className="border-b last:border-0">
                      <td className="py-1 pr-2">
                        <div className="font-medium">
                          {lead?.packet_json?.organization_name || lead.id}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {[
                            lead?.packet_json?.address?.city,
                            lead?.packet_json?.address?.state,
                          ]
                            .filter(Boolean)
                            .join(", ") || "—"}
                        </div>
                      </td>
                      <td className="py-1 pr-2">{lead.fit_score ?? "—"}</td>
                      <td className="py-1 pr-2">{lead.urgency_score ?? "—"}</td>
                      <td className="py-1 pr-2 font-semibold">
                        {lead.composite_score ?? "—"}
                      </td>
                      <td className="py-1 pr-2">
                        <Badge variant="outline">{lead.status}</Badge>
                      </td>
                      <td className="py-1 pr-2">
                        {lead.approved_for_outreach ? (
                          <Badge className="bg-emerald-100 text-emerald-700">Approved</Badge>
                        ) : (
                          <Badge variant="outline">Pending</Badge>
                        )}
                      </td>
                      <td className="py-1 pr-2 text-[11px] text-slate-500">
                        {safeFormatTime(lead.updated_at || lead.created_at)}
                      </td>
                      <td className="py-1 pr-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSelectedLeadId(lead.id)}
                        >
                          Review
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="text-base">Recent runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <div className="text-sm text-slate-500">No runs recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b">
                    <th className="py-1 pr-2">Run</th>
                    <th className="py-1 pr-2">Mode</th>
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">Started</th>
                    <th className="py-1 pr-2">Drafted</th>
                    <th className="py-1 pr-2">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-1 pr-2 text-xs">{r.id?.slice(0, 8)}</td>
                      <td className="py-1 pr-2">{r.mode}</td>
                      <td className="py-1 pr-2">
                        {r.status === "failed" ? (
                          <Badge className="bg-red-100 text-red-700">
                            <AlertCircle className="w-3 h-3 mr-1" />
                            failed
                          </Badge>
                        ) : (
                          <Badge variant="outline">{r.status}</Badge>
                        )}
                      </td>
                      <td className="py-1 pr-2 text-[11px] text-slate-500">
                        {safeFormatTime(r.started_at)}
                      </td>
                      <td className="py-1 pr-2">{r.outreach_drafted ?? 0}</td>
                      <td className="py-1 pr-2">{r.outreach_sent ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <YanaLeadReviewModal
        leadId={selectedLeadId}
        open={Boolean(selectedLeadId)}
        onClose={() => setSelectedLeadId(null)}
        onAfterChange={refresh}
      />
    </div>
  )
}
