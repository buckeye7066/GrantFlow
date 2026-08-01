/**
 * PortalSyncCard
 *
 * Two-way portal sync surface for a profile. Lists the portals this profile can
 * sync with — derived from its saved/authenticated portal sessions (the hosts
 * Hamilton can actually sign in to) — and offers, per host:
 *   • "Pull data from portal"  → POST /api/hamilton/portal-sync/read
 *   • "Push my data to portal"  → POST /api/hamilton/portal-sync/write
 * plus a last-synced status line read straight from `portal_sync_runs`
 * (GET /api/hamilton/portal-sync/runs).
 *
 * HONESTY: the underlying per-portal read/write is selector-fragile, so this
 * card never claims success on its own. The status line reflects the REAL latest
 * run row (status + timestamp + error). A kicked-off run shows "Syncing…", and
 * the actual outcome is whatever the next runs fetch reports.
 *
 * Sibling to PortalSessionsCard (which manages the saved logins this card syncs
 * over). Designed to mount next to it on the profile's portal-logins section.
 */

import React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  listPortalSessions,
  listPortalCredentials,
  runPortalSyncRead,
  runPortalSyncWrite,
  submitPortalAwards,
  listPortalSyncRuns,
} from "@/api/hamilton"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { showSuccessToast, showErrorToast } from "@/components/shared/toastHelpers"
import {
  RefreshCw,
  Loader2,
  Download,
  Upload,
  Send,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Globe,
} from "lucide-react"

function formatWhen(iso) {
  if (!iso) return "never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "never"
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

// Map a real portal_sync_runs.status to an honest visual cue. We never invent a
// "synced!" state — running/queued stays neutral, only a recorded ok/success is
// green, and error/failed (or a present error string) is surfaced as bad.
function statusTone(run) {
  if (!run) return { label: "Never synced", variant: "secondary", tone: "muted", Icon: Clock }
  const s = String(run.status || "").toLowerCase()
  if (run.error || s === "error" || s === "failed") {
    return { label: "Failed", variant: "destructive", tone: "bad", Icon: AlertTriangle }
  }
  if (s === "ok" || s === "success" || s === "completed" || s === "done") {
    return { label: "Synced", variant: "default", tone: "ok", Icon: CheckCircle2 }
  }
  if (s === "running" || s === "queued" || s === "pending" || s === "in_progress") {
    return { label: "Syncing…", variant: "secondary", tone: "muted", Icon: Loader2 }
  }
  return { label: run.status || "Unknown", variant: "secondary", tone: "muted", Icon: Clock }
}

function directionLabel(dir) {
  const d = String(dir || "").toLowerCase()
  if (d === "read") return "pulled from portal"
  if (d === "write") return "pushed to portal"
  if (d === "both") return "two-way sync"
  return d || "sync"
}

export default function PortalSyncCard({ profileId }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  // The portals this profile can sync are the ones it has a saved login OR
  // session for — those are the accounts Hamilton can actually sign in to.
  const sessionsQuery = useQuery({
    queryKey: ["hamilton-portal-sessions", profileId],
    queryFn: () => listPortalSessions(profileId),
    enabled: !!profileId,
    staleTime: 30_000,
  })

  // Saved logins (username/password) are also connectable portals — this is the
  // common case (the user just enters username/password/2FA once).
  const credentialsQuery = useQuery({
    queryKey: ["hamilton-portal-credentials", profileId],
    queryFn: () => listPortalCredentials(profileId),
    enabled: !!profileId,
    staleTime: 30_000,
  })

  const runsQuery = useQuery({
    queryKey: ["hamilton-portal-sync-runs", profileId],
    queryFn: () => listPortalSyncRuns(profileId),
    enabled: !!profileId,
    staleTime: 15_000,
  })

  const sessions = Array.isArray(sessionsQuery.data?.sessions) ? sessionsQuery.data.sessions : []
  const credentials = Array.isArray(credentialsQuery.data?.credentials) ? credentialsQuery.data.credentials : []
  const runs = Array.isArray(runsQuery.data?.runs) ? runsQuery.data.runs : []

  // Unique portal hosts the profile can sign in to — the union of saved
  // sessions and saved logins (non-revoked). Hamilton owns navigation from the
  // host, so the user never has to supply a URL.
  const hosts = React.useMemo(() => {
    const seen = new Map()
    const add = (host, label) => {
      if (!host || seen.has(host)) return
      seen.set(host, { host, label: label || null })
    }
    for (const s of sessions) {
      if (String(s?.status || "").toLowerCase() === "revoked") continue
      add(s?.portal_host, s?.label)
    }
    for (const c of credentials) {
      if (String(c?.status || "").toLowerCase() === "revoked") continue
      // Prefer a human label, else the masked username, so the row is identifiable.
      add(c?.portal_host, c?.label || c?.username_masked || c?.username || null)
    }
    return [...seen.values()]
  }, [sessions, credentials])

  // Latest run per host (runs come back newest-first from the API).
  const latestByHost = React.useMemo(() => {
    const map = new Map()
    for (const r of runs) {
      const host = r?.portal_host
      if (!host || map.has(host)) continue
      map.set(host, r)
    }
    return map
  }, [runs])

  const refetchRuns = () =>
    queryClient.invalidateQueries({ queryKey: ["hamilton-portal-sync-runs", profileId] })

  const readMutation = useMutation({
    mutationFn: (portalHost) => runPortalSyncRead(profileId, portalHost),
    onSuccess: (res, portalHost) => {
      refetchRuns()
      if (res?.ok === false) {
        showErrorToast(toast, "Pull failed", res?.error || res?.detail || "See the status line for details.")
      } else {
        showSuccessToast(toast, "Pull started", `Pulling data from ${portalHost}. Watch the status line for the result.`)
      }
    },
    onError: (err) => showErrorToast(toast, "Could not start pull", err?.message || "Please try again."),
  })

  const writeMutation = useMutation({
    mutationFn: (portalHost) => runPortalSyncWrite(profileId, portalHost),
    onSuccess: (res, portalHost) => {
      refetchRuns()
      if (res?.ok === false) {
        showErrorToast(toast, "Push failed", res?.error || res?.detail || "See the status line for details.")
      } else {
        showSuccessToast(toast, "Push started", `Pushing your data to ${portalHost}. Watch the status line for the result.`)
      }
    },
    onError: (err) => showErrorToast(toast, "Could not start push", err?.message || "Please try again."),
  })

  // ONE-CLICK SUBMIT. A push FILLS the portal's outside-award form and stops —
  // submitting on a real financial-aid account is hard to reverse, so GrantFlow
  // never does it autonomously. THIS click is the owner's (or an admin's)
  // explicit authorization, and GrantFlow completes the submission for them.
  const submitMutation = useMutation({
    mutationFn: (portalHost) => submitPortalAwards(profileId, portalHost),
    onSuccess: (res, portalHost) => {
      refetchRuns()
      if (res?.ok === false) {
        showErrorToast(toast, "Submission failed", res?.error || res?.detail || "See the status line for details.")
        return
      }
      // Report what ACTUALLY happened: a portal with no submit control leaves
      // the values filled, and saying "submitted" there would be a lie.
      if (res?.write?.submitted === true) {
        const n = (res?.write?.written || []).length
        showSuccessToast(toast, "Submitted", `Reported ${n} award${n === 1 ? "" : "s"} to ${portalHost}.`)
      } else {
        showErrorToast(
          toast,
          "Not submitted",
          res?.write?.skipped?.[0]?.reason
            || `${portalHost} did not expose a submit control — your awards were filled in but not sent.`,
        )
      }
    },
    onError: (err) => showErrorToast(toast, "Could not submit", err?.message || "Please try again."),
  })

  const isLoading = sessionsQuery.isLoading || credentialsQuery.isLoading || runsQuery.isLoading
  const busyHost = readMutation.isPending
    ? readMutation.variables
    : writeMutation.isPending
      ? writeMutation.variables
      : submitMutation.isPending
        ? submitMutation.variables
        : null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4" /> Two-way portal sync
            </CardTitle>
            <CardDescription>
              Pull the latest data from a portal into this profile, or push this profile&rsquo;s data
              out to the portal — using the saved logins above. Status below is the real result of the
              last run; portal pages change, so a sync can fail and you&rsquo;ll see it here honestly.
            </CardDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={refetchRuns} title="Refresh status">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading connectable portals…
          </p>
        )}

        {!isLoading && hosts.length === 0 && (
          <div className="rounded-lg border border-dashed border-muted-foreground/30 p-6 text-center">
            <Globe className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No connectable portals yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a saved login (username, password, and 2FA) in{" "}
              <span className="font-medium">Saved portal logins</span> above — that&rsquo;s all Hamilton
              needs. Once it can sign in to a portal, it shows up here for two-way sync.
            </p>
          </div>
        )}

        {!isLoading && hosts.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border">
            {hosts.map(({ host, label }) => {
              const run = latestByHost.get(host) || null
              const status = statusTone(run)
              const StatusIcon = status.Icon
              const isBusy = busyHost === host
              const at = run?.finished_at || run?.started_at || null
              return (
                <li key={host} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium truncate">{host}</span>
                      <Badge variant={status.variant}>
                        <StatusIcon
                          className={`h-3 w-3 mr-1 ${status.label === "Syncing…" ? "animate-spin" : ""}`}
                        />
                        {status.label}
                      </Badge>
                    </div>
                    {label && <p className="text-sm text-muted-foreground truncate">{label}</p>}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {run ? (
                        <span className={status.tone === "bad" ? "text-destructive font-medium" : ""}>
                          Last {directionLabel(run.direction)} {formatWhen(at)}
                        </span>
                      ) : (
                        <span>Never synced</span>
                      )}
                      {run?.error && (
                        <span className="text-destructive">Error: {String(run.error).slice(0, 160)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => readMutation.mutate(host)}
                    >
                      {isBusy && readMutation.variables === host ? (
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-1.5" />
                      )}
                      Pull data from portal
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => writeMutation.mutate(host)}
                    >
                      {isBusy && writeMutation.variables === host ? (
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4 mr-1.5" />
                      )}
                      Push my data to portal
                    </Button>
                    <Button
                      size="sm"
                      disabled={isBusy}
                      onClick={() => submitMutation.mutate(host)}
                      title={
                        "Report the awards you've accepted in GrantFlow to this portal AND submit them. "
                        + "A plain push only fills the form — this sends it."
                      }
                    >
                      {isBusy && submitMutation.variables === host ? (
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4 mr-1.5" />
                      )}
                      Submit my awards
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
