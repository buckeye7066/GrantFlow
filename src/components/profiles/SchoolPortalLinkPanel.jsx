import React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { GraduationCap, Link2Off, RefreshCw, ShieldCheck, AlertTriangle } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { getProfileSchoolLink, revokeProfileSchoolLink } from "@/api/profiles"

/**
 * SchoolPortalLinkPanel
 *
 * Renders nothing when the profile has no school-portal bridge.
 * When a registered school's SIS has synced this student's record into
 * GrantFlow, this panel is the student-facing acknowledgement: it shows
 * which school the data came from, when it last synced, and lets the
 * student revoke the connection at any time (mission goal 4 + 7 + 9).
 */
function relativeTime(value) {
  if (!value) return null
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true })
  } catch {
    return null
  }
}

export default function SchoolPortalLinkPanel({ profileId }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const enabled = Boolean(profileId)

  const { data, isLoading, isError } = useQuery({
    queryKey: ["profile", profileId, "school-link"],
    queryFn: () => getProfileSchoolLink(profileId),
    enabled,
    staleTime: 30_000,
    retry: 1,
  })

  const revoke = useMutation({
    mutationFn: () => revokeProfileSchoolLink(profileId),
    onSuccess: () => {
      toast({
        title: "School connection revoked",
        description:
          "Your school portal will no longer sync data to your GrantFlow profile. " +
          "Existing matches stay until your next sync from any source.",
      })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId, "school-link"] })
    },
    onError: (err) => {
      toast({
        variant: "destructive",
        title: "Could not revoke",
        description: err?.message || "Try again in a moment.",
      })
    },
  })

  if (!enabled || isLoading) return null
  if (isError) {
    return (
      <Card className="border-amber-200 bg-amber-50/40">
        <CardContent className="py-4 text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Could not load school portal connection status.
        </CardContent>
      </Card>
    )
  }

  const link = data?.link
  if (!link) return null

  const synced = relativeTime(link.last_synced_at)
  const isRevoked = link.consent_status === "revoked"

  return (
    <Card className={isRevoked ? "border-slate-200" : "border-emerald-200 bg-emerald-50/40"}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GraduationCap className="h-5 w-5 text-emerald-700" />
          School portal connection
          {isRevoked ? (
            <Badge variant="outline" className="ml-auto">
              Revoked
            </Badge>
          ) : (
            <Badge className="ml-auto bg-emerald-600 hover:bg-emerald-700">
              <ShieldCheck className="h-3 w-3 mr-1" />
              Active
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-700">
        <div>
          <div className="font-medium text-slate-900">{link.partner_name}</div>
          <div className="text-xs text-slate-500">
            Student ID: <span className="font-mono">{link.external_student_id}</span>
          </div>
        </div>

        {synced && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <RefreshCw className="h-3.5 w-3.5" />
            Last synced {synced}
          </div>
        )}

        {isRevoked ? (
          <p className="text-xs text-slate-500">
            You revoked this connection
            {link.revoked_at ? ` ${relativeTime(link.revoked_at)}` : ""}.
            Your school can no longer push data into your GrantFlow profile.
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-600">
              {link.partner_name} is sharing your enrollment, major, financial-need, and
              demographic flags with GrantFlow so we can match real funding sources to
              your specific situation. We never share your profile back to your school
              unless you ask us to.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="border-rose-200 text-rose-700 hover:bg-rose-50"
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
            >
              <Link2Off className="h-4 w-4 mr-2" />
              {revoke.isPending ? "Revoking..." : "Disconnect school portal"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
