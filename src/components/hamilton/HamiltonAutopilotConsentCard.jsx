import React, { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { KeyRound, ShieldCheck, Loader2, CheckCircle2, Lock, Unlock } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  getHamiltonAuthorizations,
  grantHamiltonAuthorization,
  revokeHamiltonAuthorization,
  getPortalVaultStatus,
  enableAutonomousUnlock,
  disableAutonomousUnlock,
} from "@/api/hamilton"

// Profile-level consent covers saved-login draft preparation only. Real-portal
// final Submit remains a visible human handoff. A retired submit grant may still
// be shown so the owner can revoke it, but this surface never creates one.
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

  // "Stay signed in without me" — autonomous vault unlock (escrow).
  const [passphrase, setPassphrase] = useState("")
  const vaultQuery = useQuery({
    queryKey: ["portal-vault", profileId],
    queryFn: () => getPortalVaultStatus(profileId),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })
  const vault = vaultQuery.data?.vault || null
  const autoUnlockOn = Boolean(vault?.autonomous_unlock)
  const hasPassphrase = Boolean(vault?.has_passphrase)

  const setAutoUnlock = useMutation({
    mutationFn: async ({ enable, pass }) =>
      enable ? enableAutonomousUnlock(profileId, pass) : disableAutonomousUnlock(profileId),
    onSuccess: (_d, vars) => {
      setPassphrase("")
      queryClient.invalidateQueries({ queryKey: ["portal-vault", profileId] })
      toast({
        title: vars.enable ? "Autonomous sign-in on" : "Autonomous sign-in off",
        description: vars.enable
          ? "Hamilton can now unlock and sign in on its own — no passphrase each run."
          : "Hamilton will ask for the passphrase again before using saved logins.",
      })
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Couldn't update", description: err?.message || "Check the passphrase and try again." })
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

            <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900">Final portal Submit stays with you</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Hamilton can prepare and save drafts. Login, attestations, signatures, 2FA, final Submit,
                  and submission confirmation remain visible human steps.
                </div>
              </div>
              {submitOn && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={busy}
                  onClick={() => setConsent.mutate({ types: [SUBMIT_TYPE], enable: false })}
                >
                  {busy && busyKind?.[0] === SUBMIT_TYPE
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : "Revoke legacy submit permission"}
                </Button>
              )}
            </div>

            {loginOn && (
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                      {autoUnlockOn ? <Unlock className="h-4 w-4 text-emerald-600" /> : <Lock className="h-4 w-4 text-slate-400" />}
                      Stay signed in without me
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Lets Hamilton unlock its saved logins on scheduled/background runs, so you never
                      re-enter the passphrase.
                    </div>
                  </div>
                  {autoUnlockOn && (
                    <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700 shrink-0">On</Badge>
                  )}
                </div>
                {vaultQuery.isLoading ? null : autoUnlockOn ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    disabled={setAutoUnlock.isPending}
                    onClick={() => setAutoUnlock.mutate({ enable: false })}
                  >
                    {setAutoUnlock.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Turn off"}
                  </Button>
                ) : hasPassphrase ? (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (passphrase) setAutoUnlock.mutate({ enable: true, pass: passphrase })
                    }}
                  >
                    <Input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="Enter portal passphrase once"
                      autoComplete="off"
                      className="h-9"
                    />
                    <Button type="submit" size="sm" disabled={!passphrase || setAutoUnlock.isPending}>
                      {setAutoUnlock.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enable"}
                    </Button>
                  </form>
                ) : (
                  <div className="mt-3 text-xs text-slate-500">
                    Set a portal passphrase first (Advanced → add a portal) to enable this.
                  </div>
                )}
              </div>
            )}

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
