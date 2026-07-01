import React, { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { KeyRound, ShieldCheck, Loader2, CheckCircle2 } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  getHamiltonAuthorizations,
  grantHamiltonAuthorization,
  revokeHamiltonAuthorization,
} from "@/api/hamilton"

// One profile-level consent = "sign in with my saved logins and prepare my
// applications on every portal." Granted at scope:'profile' so it covers every
// funding source without per-portal authorizing. Submitting is a SEPARATE,
// explicit opt-in below (kept distinct so consent stays informed).
const LOGIN_TYPES = [
  "use_saved_credentials_reference",
  "use_saved_session",
  "complete_forms",
  "save_drafts",
  "generate_narratives",
  "upload_documents",
]
const SUBMIT_TYPE = "submit_applications"

export default function HamiltonAutopilotConsentCard({ profileId }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const key = ["hamilton-authorizations", profileId]

  const authQuery = useQuery({
    queryKey: key,
    queryFn: () => getHamiltonAuthorizations(profileId),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })

  // Only profile-scoped, non-revoked grants count as standing consent.
  const active = useMemo(
    () => (authQuery.data?.active || []).filter((a) => a?.scope === "profile" && !a?.revoked_at),
    [authQuery.data],
  )
  const loginOn = active.some((a) => a.authorization_type === "use_saved_credentials_reference")
  const submitOn = active.some((a) => a.authorization_type === SUBMIT_TYPE)

  const refresh = () => queryClient.invalidateQueries({ queryKey: key })

  const setConsent = useMutation({
    mutationFn: async ({ types, enable }) => {
      if (enable) {
        await grantHamiltonAuthorization({ profileId, authorizationTypes: types })
      } else {
        // Revoke every active profile-scoped grant whose type is in `types`.
        const toRevoke = active.filter((a) => types.includes(a.authorization_type))
        for (const a of toRevoke) await revokeHamiltonAuthorization(a.id, "user_toggled_off")
      }
    },
    onSuccess: (_d, vars) => {
      refresh()
      toast({
        title: vars.enable ? "Hamilton is authorized" : "Permission turned off",
        description: vars.enable
          ? "Hamilton can now sign in and prepare applications using your saved logins."
          : "Hamilton will no longer act on this profile until you re-enable it.",
      })
    },
    onError: (err) => {
      refresh()
      toast({ variant: "destructive", title: "Couldn't update permission", description: err?.message || "Please try again." })
    },
  })

  const busy = setConsent.isPending
  const busyKind = setConsent.variables?.types

  return (
    <Card className="border-blue-200 bg-blue-50/40">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white">
              <KeyRound className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base font-semibold text-slate-900">
                Let Hamilton sign in for you
              </CardTitle>
              <p className="mt-1 text-sm text-slate-600">
                Grant permission once and Hamilton uses this profile's saved logins to sign in and
                prepare applications on <span className="font-medium">every</span> portal — no
                authorizing each one.
              </p>
            </div>
          </div>
          {loginOn && (
            <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700 shrink-0">
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> On
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {authQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading permission…
          </div>
        ) : (
          <>
            <label className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900">Sign in &amp; prepare with my saved logins</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Uses your saved passwords/sessions to log in, fill forms, write narratives, and save drafts.
                </div>
              </div>
              <span className="shrink-0 pt-0.5">
                {busy && busyKind === LOGIN_TYPES ? (
                  <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                ) : (
                  <Switch
                    checked={loginOn}
                    disabled={busy}
                    onCheckedChange={(v) => setConsent.mutate({ types: LOGIN_TYPES, enable: v })}
                    aria-label="Allow Hamilton to sign in and prepare applications"
                  />
                )}
              </span>
            </label>

            <label className={`flex items-start justify-between gap-4 rounded-lg border p-3 ${loginOn ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-60"}`}>
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900">Also submit finished applications for me</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Optional. When off, Hamilton prepares everything and leaves the final submit to you.
                </div>
              </div>
              <span className="shrink-0 pt-0.5">
                {busy && busyKind?.[0] === SUBMIT_TYPE ? (
                  <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                ) : (
                  <Switch
                    checked={submitOn}
                    disabled={busy || !loginOn}
                    onCheckedChange={(v) => setConsent.mutate({ types: [SUBMIT_TYPE], enable: v })}
                    aria-label="Allow Hamilton to submit finished applications"
                  />
                )}
              </span>
            </label>

            <div className="flex items-start gap-2 text-xs text-slate-500">
              <ShieldCheck className="h-4 w-4 shrink-0 text-slate-400 mt-0.5" />
              <span>
                Hamilton never makes up identity, SSN, or ID-verification answers, and never enters
                your two-factor codes — those still come from you. You can turn this off anytime.
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
