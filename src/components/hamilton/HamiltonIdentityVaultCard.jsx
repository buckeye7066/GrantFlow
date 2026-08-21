import React, { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ShieldCheck, Loader2, Trash2, Lock } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  getHamiltonIdentityVault,
  setHamiltonIdentitySecret,
  revokeHamiltonIdentitySecret,
} from "@/api/hamilton"

/**
 * The identity vault (owner directive 2026-08-21): a secure place for the
 * SENSITIVE values a portal may demand for identity proofing / SSO — SSN, date
 * of birth, government ID, FSA ID, university SSO. Hamilton fills them under
 * full automation when they are on file, and asks for anything missing.
 *
 * The value is ENCRYPTED server-side and NEVER returned again — this card only
 * ever shows which values are on file and a masked hint (last-4 / birth year).
 * `?addIdentity=<kind>` deep-links here from Hamilton's "I need X" notification.
 */
export default function HamiltonIdentityVaultCard({ profileId }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const key = ["hamilton-identity-vault", profileId]

  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => getHamiltonIdentityVault(profileId),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })

  const catalogue = useMemo(() => (Array.isArray(data?.kinds) ? data.kinds : []), [data])
  const onFile = useMemo(() => {
    const m = new Map()
    for (const r of data?.on_file || []) m.set(r.kind, r)
    return m
  }, [data])

  // Preselect the kind Hamilton asked for, if the deep link named one.
  const requestedKind = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("addIdentity") || ""
    } catch { return "" }
  }, [])

  const [selectedKind, setSelectedKind] = useState(requestedKind || "")
  const [value, setValue] = useState("")

  const refresh = () => queryClient.invalidateQueries({ queryKey: key })

  const save = useMutation({
    mutationFn: () => setHamiltonIdentitySecret({ profileId, kind: selectedKind, value }),
    onSuccess: () => {
      setValue("")
      refresh()
      toast({ title: "Saved securely", description: "Hamilton can use it and will resume any application that was waiting on it." })
    },
    onError: (err) => toast({ variant: "destructive", title: "Couldn't save", description: err?.message || "Please try again." }),
  })

  const remove = useMutation({
    mutationFn: (kind) => revokeHamiltonIdentitySecret({ profileId, kind }),
    onSuccess: () => { refresh(); toast({ title: "Removed", description: "Hamilton will ask for it again if a portal needs it." }) },
    onError: (err) => toast({ variant: "destructive", title: "Couldn't remove", description: err?.message || "Please try again." }),
  })

  const canSave = Boolean(selectedKind) && value.trim() !== "" && !save.isPending

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <CardTitle className="text-base font-semibold text-slate-900">Identity details for portals</CardTitle>
            <p className="mt-1 text-sm text-slate-600">
              Some portals ask for an SSN, date of birth, government ID, FSA&nbsp;ID or university sign-in.
              Save them here once and Hamilton uses them under full automation. They&apos;re encrypted, never
              shown again, and Hamilton never makes one up — if he needs one he asks you.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <>
            {onFile.size > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">On file</div>
                {[...onFile.values()].map((r) => (
                  <div key={r.kind} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-2.5">
                    <div className="min-w-0 text-sm">
                      <span className="font-medium text-slate-900">{r.label}</span>
                      {r.display_hint && <span className="ml-2 text-slate-400">{r.display_hint}</span>}
                      {!r.display_hint && <Badge variant="outline" className="ml-2 border-slate-300 text-slate-500"><Lock className="mr-1 h-3 w-3" />saved</Badge>}
                    </div>
                    <Button size="sm" variant="ghost" className="text-slate-400 hover:text-red-600" disabled={remove.isPending} onClick={() => remove.mutate(r.kind)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Add a detail</div>
              <select
                className="w-full rounded-md border border-slate-300 bg-white p-2 text-sm"
                value={selectedKind}
                onChange={(e) => setSelectedKind(e.target.value)}
              >
                <option value="">Choose what to add…</option>
                {catalogue.map((k) => (
                  <option key={k.kind} value={k.kind}>{k.label}{onFile.has(k.kind) ? " (replace)" : ""}</option>
                ))}
              </select>
              <Input
                type="password"
                autoComplete="off"
                placeholder="Enter the value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <Button size="sm" disabled={!canSave} onClick={() => save.mutate()}>
                {save.isPending ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving…</> : "Save securely"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
