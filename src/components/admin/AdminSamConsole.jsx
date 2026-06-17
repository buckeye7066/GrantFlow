import React, { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Hammer,
  Loader2,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

/**
 * AdminSamConsole — admin UI for Sam, GrantFlow's production-readiness
 * agent. Sam is read-only by default; the "Apply Safe Fixes" button is
 * disabled unless the server is started with SAM_ALLOW_SAFE_REPAIR=true
 * AND the current mode is repair-safe.
 *
 * Mirrors the AdminAnyaConsole UX so admins recognise the pattern.
 */

async function getStatus() {
  return apiFetch("/api/sam/status")
}

async function post(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) })
}

const SEVERITY_TONE = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-amber-100 text-amber-900 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
  info: "bg-sky-100 text-sky-800 border-sky-200",
}

function fmtDate(value) {
  if (!value) return "—"
  try { return new Date(value).toLocaleString() } catch { return String(value) }
}

function HealthBadge({ score, ready }) {
  if (ready === true) {
    return (
      <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200" variant="outline">
        <CheckCircle2 className="h-3 w-3 mr-1" />
        Production ready
        {typeof score === "number" ? ` · ${Math.round(score)}` : ""}
      </Badge>
    )
  }
  if (ready === false) {
    return (
      <Badge className="bg-red-100 text-red-800 border-red-200" variant="outline">
        <AlertTriangle className="h-3 w-3 mr-1" />
        Not production ready
        {typeof score === "number" ? ` · ${Math.round(score)}` : ""}
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      Sam has not run yet
    </Badge>
  )
}

export default function AdminSamConsole() {
  const { toast } = useToast()
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lastRun, setLastRun] = useState(null)
  const [payload, setPayload] = useState('{\n  "mode": "observe",\n  "dryRun": true\n}')

  const refresh = useCallback(async () => {
    try {
      const res = await getStatus()
      setStatus(res?.status ?? res)
    } catch (err) {
      toast({
        title: "Failed to load Sam status",
        description: err?.message || "Unknown error",
        variant: "destructive",
      })
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const runWith = async (label, path, override = null) => {
    setBusy(true)
    try {
      let body = override
      if (!body) {
        try { body = JSON.parse(payload || "{}") }
        catch (parseErr) {
          toast({ title: "Invalid JSON payload", description: parseErr.message, variant: "destructive" })
          setBusy(false)
          return
        }
      }
      const res = await post(path, body)
      setLastRun(res)
      toast({ title: label, description: res?.production_ready ? "Production ready" : `Health ${res?.health_score ?? "?"}` })
      await refresh()
    } catch (err) {
      toast({ title: `Failed: ${label}`, description: err?.message || "Unknown error", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const findings = useMemo(() => {
    return Array.isArray(lastRun?.findings) ? lastRun.findings : []
  }, [lastRun])

  const repairPlan = useMemo(() => {
    return Array.isArray(lastRun?.repair_plan) ? lastRun.repair_plan : []
  }, [lastRun])

  const safeRepairAllowed = Boolean(status?.allow_safe_repair)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Stethoscope className="h-5 w-5" />
            Sam — Production Readiness Agent
            <span className="ml-auto"><HealthBadge score={status?.health_score ?? lastRun?.health_score} ready={status?.production_ready ?? lastRun?.production_ready} /></span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-sm">
              Sam is GrantFlow's dedicated production engineer. He runs diagnostics, plans repairs, and runs production gates.
              <strong className="ml-1">Sam never modifies code without an authorised admin clicking "Apply Safe Fixes".</strong>
              {!safeRepairAllowed && (
                <span className="block mt-1 text-xs text-amber-700">
                  Safe-fix mode is disabled on this server (set <code>SAM_ALLOW_SAFE_REPAIR=true</code> to enable).
                </span>
              )}
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-slate-500">Mode</div>
              <div className="font-medium">{status?.mode || "observe"}</div>
            </div>
            <div>
              <div className="text-slate-500">Last run</div>
              <div className="font-medium">{fmtDate(status?.last_run_at)}</div>
            </div>
            <div>
              <div className="text-slate-500">Open findings</div>
              <div className="font-medium">
                {status?.open_findings_count ?? 0}
                {status?.critical_findings_count ? <span className="text-red-700 ml-2">({status.critical_findings_count} critical)</span> : null}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Last failure</div>
              <div className="font-medium">{fmtDate(status?.last_failure_at)}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => runWith("Run Diagnostics", "/api/sam/diagnose", { mode: "observe", dryRun: true })} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Stethoscope className="h-4 w-4 mr-2" />}
              Run Diagnostics
            </Button>
            <Button variant="secondary" onClick={() => runWith("Plan Repairs", "/api/sam/plan-repair", { mode: "advise", dryRun: true })} disabled={busy}>
              <ClipboardList className="h-4 w-4 mr-2" />
              Plan Repairs
            </Button>
            <Button variant="secondary" onClick={() => runWith("Run Production Gates", "/api/sam/run-gates", { mode: "gatekeeper", dryRun: true })} disabled={busy}>
              <PlayCircle className="h-4 w-4 mr-2" />
              Run Production Gates
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!safeRepairAllowed) {
                  toast({ title: "Safe-fix disabled", description: "Set SAM_ALLOW_SAFE_REPAIR=true on the server.", variant: "destructive" })
                  return
                }
                runWith("Apply Safe Fixes", "/api/sam/apply-safe-fixes", null)
              }}
              disabled={busy || !safeRepairAllowed}
              title={safeRepairAllowed ? "Apply only deterministic safe fixes." : "Disabled (SAM_ALLOW_SAFE_REPAIR=false)"}
            >
              <Hammer className="h-4 w-4 mr-2" />
              Apply Safe Fixes
            </Button>
            <Button variant="ghost" onClick={refresh} disabled={busy}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>

          <div>
            <Label htmlFor="sam-payload">Advanced JSON payload</Label>
            <Textarea
              id="sam-payload"
              rows={6}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="text-xs text-slate-500 mt-1">
              Used by &quot;Apply Safe Fixes&quot; and any custom <code>/api/sam/run</code> call. Example:
              <code className="ml-1">{`{"mode":"repair-safe","fixIds":["docs.regenerate-readiness-log"]}`}</code>
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" />
            Findings
            <span className="ml-auto text-sm text-slate-500">{findings.length} total</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {findings.length === 0 ? (
            <p className="text-sm text-slate-500">No findings yet — run diagnostics to generate a report.</p>
          ) : findings.slice(0, 50).map((f) => (
            <div key={f.id} className={`border rounded-md px-3 py-2 ${SEVERITY_TONE[f.severity] || ""}`}>
              <div className="flex items-center gap-2 text-sm font-medium">
                <Badge variant="outline" className="uppercase text-[10px] tracking-wider">
                  {f.severity}
                </Badge>
                <span>{f.title}</span>
                <span className="ml-auto text-xs text-slate-500">{f.category}</span>
              </div>
              {f.description ? (
                <div className="text-xs text-slate-700 mt-1 whitespace-pre-line line-clamp-3">{f.description}</div>
              ) : null}
              {Array.isArray(f.affected_files) && f.affected_files.length > 0 && (
                <div className="text-xs text-slate-500 mt-1 font-mono">
                  {f.affected_files.slice(0, 3).join(", ")}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {repairPlan.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5" />
              Repair plan ({repairPlan.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {repairPlan.slice(0, 50).map((p) => (
              <div key={p.finding_id} className="border rounded-md px-3 py-2 bg-white">
                <div className="text-sm font-medium">{p.strategy}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Risk: <span className="font-mono">{p.risk_level}</span> · Files: {p.files_to_change?.join(", ") || "(none)"}
                </div>
                {p.patch_summary ? (
                  <div className="text-xs text-slate-700 mt-1 line-clamp-2">{p.patch_summary}</div>
                ) : null}
                {p.requires_admin_approval && (
                  <div className="text-xs text-amber-700 mt-1">Requires admin approval before apply.</div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
