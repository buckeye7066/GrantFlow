import React from "react"
import { useQuery } from "@tanstack/react-query"
import { getHamiltonReadiness } from "@/api/hamilton"
import { AlertTriangle, KeyRound, CalendarClock, RefreshCw } from "lucide-react"

/**
 * Login-time prompt: when a profile has active Hamilton work but no schedule, a
 * portal still needs a login session captured (so Hamilton can act inside the
 * real account and you can stand by for 2FA), or a portal has drifted out of
 * sync, surface it here.
 *
 * THE SYNC PROMPT (owner rule, 2026-08-01): a portal needs syncing when it has
 * not synced in 7 days, or when awards / profile information changed after the
 * last sync. It is deliberately the LOGIN moment, because a human being present
 * is the only reliable way to refresh a short-lived portal session — a
 * studentaid.gov session measured authenticated at T+30s was already refused at
 * T+~20min, so no background cadence can be counted on to find one alive.
 *
 * SCOPE: this renders whatever `/readiness?profileId=` returns for the ONE
 * profile in context. An admin working inside a profile sees exactly what that
 * profile's owner sees — never a digest across every profile they can access
 * (39 in prod), which is a wall of prompts people learn to ignore.
 *
 * Shows nothing when there's no work or everything is ready.
 */
export default function HamiltonReadinessBanner({ profileId }) {
  const { data } = useQuery({
    queryKey: ["hamilton-readiness", profileId],
    queryFn: () => getHamiltonReadiness({ profileId }),
    enabled: !!profileId,
    staleTime: 60_000,
  })

  const r = data?.readiness ?? data?.data?.readiness ?? null
  if (!r || !r.needs_attention) return null

  const needCapture = Array.isArray(r.portals_needing_capture) ? r.portals_needing_capture : []
  const noSchedule = !r.has_schedule && r.pending_task_count > 0
  const syncPortals = Array.isArray(r.sync_needs?.portals) ? r.sync_needs.portals : []
  // The list is capped for readability; the totals still describe every
  // qualifying portal, so the banner never understates the backlog.
  const totalNeedingSync = r.sync_needs?.total_needing_action ?? syncPortals.length
  const truncatedCount = r.sync_needs?.truncated_count ?? 0

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
        <div className="space-y-2">
          <p className="font-medium">Set Hamilton up to prepare your applications</p>
          {needCapture.length > 0 && (
            <p className="flex items-center gap-1.5 text-sm">
              <KeyRound className="h-4 w-4" />
              These portals need a saved login before Hamilton can open your real account and prepare drafts:{" "}
              <span className="font-semibold">{needCapture.join(", ")}</span>. Capture a session
              (you complete login + 2FA once), then Hamilton can reuse it for authorized preparation.
              You still review and complete final submission in the portal.
            </p>
          )}
          {noSchedule && (
            <p className="flex items-center gap-1.5 text-sm">
              <CalendarClock className="h-4 w-4" />
              You have {r.pending_task_count} application{r.pending_task_count === 1 ? "" : "s"} ready.
              Set a schedule so Hamilton prepares them — she&apos;ll flag any times you need to be available for 2FA.
            </p>
          )}
          {syncPortals.length > 0 && (
            <div className="space-y-1.5 text-sm">
              <p className="flex items-center gap-1.5">
                <RefreshCw className="h-4 w-4" />
                {totalNeedingSync} portal{totalNeedingSync === 1 ? "" : "s"} need
                {totalNeedingSync === 1 ? "s" : ""} a sync:
              </p>
              <ul className="ml-6 list-disc space-y-1">
                {syncPortals.map((p) => (
                  <li key={p.portal_host}>
                    <span className="font-semibold">{p.label}</span>{" "}
                    {/* The two asks are different: you cannot sync a portal you
                        cannot get into, so a portal with no captured session is
                        asked for one sign-in, never "sync now". */}
                    {p.action === "sign_in" ? (
                      <span>— sign in once so it can sync (the sync runs right away, while the session is still warm).</span>
                    ) : (
                      <span>— ready to sync now.</span>
                    )}
                    <span className="block text-xs opacity-80">
                      {p.reasons.map((reason) => reason.detail).join(" ")}
                      {/* The payload already carries the last SUCCESSFUL sync
                          stamp — render it so "needs a sync" always says when
                          information last actually moved. */}
                      {p.last_successful_sync_at && (
                        <>
                          {" "}Last synced{" "}
                          {new Date(p.last_successful_sync_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                          .
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {truncatedCount > 0 && (
                <p className="ml-6 text-xs opacity-80">
                  +{truncatedCount} more on the Portals page.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
