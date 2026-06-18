import React, { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Loader2, Lock, Plus, ShieldCheck, Trash2 } from "lucide-react"
import { apiFetch } from "@/api/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"

/**
 * SavedLoginsCard
 *
 * Lets the user store portal logins (site + username + password) on a profile
 * that Hamilton picks up to authenticate herself during autopilot. The password
 * is encrypted at rest server-side and is NEVER returned to the browser — the
 * list shows only a masked username. Used together with the "Use saved login"
 * authorization on the Automate-with-Hamilton screen.
 */
export default function SavedLoginsCard({ profileId }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ portalHost: "", login_url: "", username: "", password: "", label: "" })

  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }))

  const { data, isLoading } = useQuery({
    queryKey: ["hamilton-credentials", profileId],
    queryFn: () => apiFetch(`/api/hamilton/automation/credentials?profileId=${encodeURIComponent(profileId)}`),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })
  const credentials = Array.isArray(data?.credentials) ? data.credentials : []

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/hamilton/automation/credentials`, {
        method: "POST",
        body: JSON.stringify({
          profileId,
          portalHost: form.portalHost || form.login_url,
          login_url: form.login_url || null,
          username: form.username,
          password: form.password,
          label: form.label || null,
        }),
      }),
    onSuccess: () => {
      toast({ title: "Login saved", description: "Hamilton can now sign in to this portal for this profile." })
      setOpen(false)
      setForm({ portalHost: "", login_url: "", username: "", password: "", label: "" })
      queryClient.invalidateQueries({ queryKey: ["hamilton-credentials", profileId] })
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not save login", description: err?.message || "Check the fields and try again." })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => apiFetch(`/api/hamilton/automation/credentials/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Login removed" })
      queryClient.invalidateQueries({ queryKey: ["hamilton-credentials", profileId] })
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not remove login", description: err?.message || "Try again." })
    },
  })

  const canSave = form.username.trim() && form.password.trim() && (form.portalHost.trim() || form.login_url.trim())

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-indigo-600" />
            Saved portal logins
            {credentials.length > 0 && (
              <Badge variant="secondary" className="text-xs">{credentials.length}</Badge>
            )}
          </CardTitle>
          {profileId && (
            <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add login
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Alert className="border-indigo-200 bg-indigo-50">
          <ShieldCheck className="h-4 w-4 text-indigo-700" />
          <AlertDescription className="text-indigo-950 text-sm">
            Passwords are <span className="font-semibold">encrypted at rest</span> and never shown again or sent back to your browser.
            Hamilton uses them only to sign in to that portal during autopilot — and still stops at CAPTCHA, 2FA, payment, or signature.
          </AlertDescription>
        </Alert>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : credentials.length === 0 ? (
          <p className="text-sm text-slate-500">No saved logins yet. Add one so Hamilton can sign in to that portal for this profile.</p>
        ) : (
          <div className="space-y-2">
            {credentials.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Lock className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <span className="text-sm font-medium text-slate-900 truncate">{c.portal_host}</span>
                    {c.label && <Badge variant="outline" className="text-[11px]">{c.label}</Badge>}
                  </div>
                  <p className="text-xs text-slate-500 truncate">
                    {c.username_masked || "saved login"} · password stored
                    {c.last_used_at ? " · used by Hamilton" : ""}
                  </p>
                </div>
                <Button
                  variant="ghost" size="sm" className="text-slate-500 hover:text-red-600"
                  onClick={() => deleteMutation.mutate(c.id)}
                  disabled={deleteMutation.isPending}
                  title="Remove login"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a portal login</DialogTitle>
            <DialogDescription>
              Hamilton will use this to sign in to the portal for this profile. The password is encrypted and never displayed again.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="cred-host">Portal site or login URL</Label>
              <Input id="cred-host" placeholder="mtsu.edu  (or https://login.mtsu.edu)"
                value={form.portalHost} onChange={(e) => set("portalHost", e.target.value)} />
              <p className="text-xs text-slate-500">Hamilton matches this against the portal she opens (host or any subdomain).</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cred-loginurl">Direct login URL (optional)</Label>
              <Input id="cred-loginurl" placeholder="https://login.mtsu.edu/sign-in"
                value={form.login_url} onChange={(e) => set("login_url", e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="cred-user">Username</Label>
                <Input id="cred-user" autoComplete="off" value={form.username} onChange={(e) => set("username", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cred-pass">Password</Label>
                <Input id="cred-pass" type="password" autoComplete="new-password"
                  value={form.password} onChange={(e) => set("password", e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cred-label">Label (optional)</Label>
              <Input id="cred-label" placeholder="MTSU student login"
                value={form.label} onChange={(e) => set("label", e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saveMutation.isPending}>Cancel</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending}>
              {saveMutation.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…</> : "Save login"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
