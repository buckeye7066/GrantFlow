import React from "react"
import { useQuery } from "@tanstack/react-query"
import { getHamiltonReadiness } from "@/api/hamilton"
import { AlertTriangle, KeyRound, CalendarClock } from "lucide-react"

/**
 * Login-time prompt: when a profile has active Hamilton work but no schedule, or
 * a portal still needs a login session captured (so Hamilton can act inside the
 * real account and you can stand by for 2FA), surface it here.
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

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
        <div className="space-y-2">
          <p className="font-medium">Set Hamilton up to apply for you</p>
          {needCapture.length > 0 && (
            <p className="flex items-center gap-1.5 text-sm">
              <KeyRound className="h-4 w-4" />
              These portals need a saved login before Hamilton can submit inside your real account:{" "}
              <span className="font-semibold">{needCapture.join(", ")}</span>. Capture a session
              (you complete login + 2FA once), then Hamilton reuses it.
            </p>
          )}
          {noSchedule && (
            <p className="flex items-center gap-1.5 text-sm">
              <CalendarClock className="h-4 w-4" />
              You have {r.pending_task_count} application{r.pending_task_count === 1 ? "" : "s"} ready.
              Set a schedule so Hamilton runs them — she&apos;ll flag any times you need to be available for 2FA.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
