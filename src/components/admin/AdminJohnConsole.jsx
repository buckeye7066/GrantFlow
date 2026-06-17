import React, { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mail,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

import JohnDraftReview from "@/components/john/JohnDraftReview"

async function get(path) {
  return apiFetch(path)
}

async function post(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) })
}

function StatusPill({ ok, children }) {
  return (
    <Badge
      className={
        ok
          ? "bg-emerald-100 text-emerald-700 border-emerald-200"
          : "bg-amber-100 text-amber-800 border-amber-200"
      }
      variant="outline"
    >
      {ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 mr-1" />
      )}
      {children}
    </Badge>
  )
}

function MetricCard({ label, value, sublabel }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value ?? "—"}</div>
      {sublabel ? <div className="text-xs text-slate-500 mt-1">{sublabel}</div> : null}
    </div>
  )
}

export default function AdminJohnConsole() {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [lastRun, setLastRun] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const res = await get("/api/john/status")
      setStatus(res?.status || null)
    } catch (err) {
      toast({
        title: "Failed to load John status",
        description: err.message,
        variant: "destructive",
      })
    }
  }, [toast])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 10_000)
    return () => window.clearInterval(id)
  }, [refresh, refreshTick])

  const run = async (label, payload) => {
    setBusy(true)
    try {
      const res = await post("/api/john/run", payload || {})
      setLastRun(res)
      toast({ title: label, description: res?.status || "submitted" })
      setRefreshTick((n) => n + 1)
    } catch (err) {
      toast({ title: `Failed: ${label}`, description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const verifyAlias = async () => {
    setBusy(true)
    try {
      const res = await post("/api/john/verify-alias", {})
      toast({
        title: res?.ok ? "Alias verified" : "Alias verification reported issues",
        description:
          res?.alias_send_supported === true
            ? "Microsoft Graph accepted the From alias."
            : res?.reason || "Fallback may apply.",
      })
      setLastRun(res)
      setRefreshTick((n) => n + 1)
    } catch (err) {
      toast({ title: "verify-alias failed", description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const createTestDraft = async () => {
    setBusy(true)
    try {
      const res = await post("/api/john/create-test-draft", {})
      toast({
        title: res?.ok ? "Test draft created" : "Test draft blocked",
        description: res?.draft?.provider_draft_id
          ? `Provider draft ID: ${res.draft.provider_draft_id}`
          : res?.reason || "See audit log for details.",
        variant: res?.ok ? "default" : "destructive",
      })
      setLastRun(res)
      setRefreshTick((n) => n + 1)
    } catch (err) {
      toast({ title: "create-test-draft failed", description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const metrics = status?.metrics || {}
  const remaining24h = useMemo(() => {
    const cap = Number(status?.daily_cap || 0)
    const used = Number(metrics?.drafts_last_24h || 0)
    return Math.max(0, cap - used)
  }, [status, metrics])

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-blue-600" />
            John — Outreach Drafting Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              John writes Outlook draft emails from Yana&apos;s qualified leads. He
              never sends. Dr. John White reviews and sends manually.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-2">
            <StatusPill ok={!!status?.enabled}>{status?.enabled ? "Enabled" : "Disabled"}</StatusPill>
            <StatusPill ok={status?.draft_only !== false}>Draft-only</StatusPill>
            <StatusPill ok={!!status?.alias_check?.alias_send_supported}>
              {status?.alias_check?.alias_send_supported
                ? "Alias verified"
                : "Alias not verified"}
            </StatusPill>
            <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">
              Mode: {status?.mode || "observe"}
            </Badge>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Drafts (24h)"
              value={metrics?.drafts_last_24h ?? 0}
              sublabel={`Cap: ${status?.daily_cap ?? 50}`}
            />
            <MetricCard
              label="Remaining today"
              value={remaining24h}
              sublabel={`Hourly cap: ${status?.hourly_cap ?? 10}`}
            />
            <MetricCard
              label="Drafts blocked (24h)"
              value={metrics?.drafts_blocked_24h ?? 0}
              sublabel="See audit for reasons"
            />
            <MetricCard
              label="Needs alias review"
              value={metrics?.needs_alias_review ?? 0}
              sublabel="Drafts pending sender review"
            />
            <MetricCard
              label="Safety failures (24h)"
              value={metrics?.safety_failed_24h ?? 0}
            />
            <MetricCard
              label="Suppression list"
              value={metrics?.suppression_count ?? 0}
            />
            <MetricCard
              label="Primary mailbox"
              value={status?.primary_mailbox || "—"}
            />
            <MetricCard
              label="From alias"
              value={status?.from_alias || "—"}
              sublabel={`Reply-To: ${status?.reply_to || "—"}`}
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={() => refresh()} variant="outline" disabled={busy}>
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
            <Button onClick={() => verifyAlias()} disabled={busy} variant="outline">
              {busy ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ShieldCheck className="w-4 h-4 mr-2" />
              )}
              Verify Alias
            </Button>
            <Button onClick={() => createTestDraft()} disabled={busy} variant="outline">
              <Mail className="w-4 h-4 mr-2" /> Create Test Draft
            </Button>
            <Button
              onClick={() => run("Observe Yana Leads", { mode: "observe" })}
              disabled={busy}
              variant="outline"
            >
              <PlayCircle className="w-4 h-4 mr-2" /> Observe Yana Leads
            </Button>
            <Button
              onClick={() =>
                run("Draft Today's Batch", { mode: "draft", maxDrafts: 50 })
              }
              disabled={busy}
            >
              <PlayCircle className="w-4 h-4 mr-2" /> Draft Today&apos;s Batch
            </Button>
            <Button
              onClick={() => run("Full Cycle", { mode: "full-cycle", maxDrafts: 50 })}
              disabled={busy}
              variant="secondary"
            >
              <PlayCircle className="w-4 h-4 mr-2" /> Full Cycle
            </Button>
          </div>

          {lastRun ? (
            <Alert variant={lastRun?.ok === false ? "destructive" : "default"}>
              {lastRun?.ok === false ? (
                <XCircle className="w-4 h-4" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              <AlertDescription className="text-xs">
                <span className="font-medium">Last run:</span>{" "}
                {lastRun?.status || (lastRun?.ok ? "ok" : "failed")} —
                created {lastRun?.drafts_created ?? 0}, blocked{" "}
                {lastRun?.drafts_blocked ?? 0}, failed {lastRun?.drafts_failed ?? 0}
                {lastRun?.error ? ` — ${lastRun.error}` : ""}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <JohnDraftReview refreshTick={refreshTick} />
    </div>
  )
}
