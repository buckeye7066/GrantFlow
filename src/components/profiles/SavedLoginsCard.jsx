import React, { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Copy, Eye, KeyRound, Loader2, Lock, Plus, ShieldCheck, Sparkles, Trash2 } from "lucide-react"
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
  // Hamilton-generated credential flow: separate dialog so the user only ever
  // supplies host + username; the server picks the password.
  const [genOpen, setGenOpen] = useState(false)
  const [genForm, setGenForm] = useState({ portalHost: "", login_url: "", username: "", label: "" })
  const [revealedPassword, setRevealedPassword] = useState(null) // { host, username, password }
  const [revealAlreadyDone, setRevealAlreadyDone] = useState(false)

  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }))
  const setGen = (k, v) => setGenForm((s) => ({ ...s, [k]: v }))

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

  const generateMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/hamilton/automation/credentials/generate`, {
        method: "POST",
        body: JSON.stringify({
          profileId,
          portalHost: genForm.portalHost || genForm.login_url,
          login_url: genForm.login_url || null,
          username: genForm.username,
          label: genForm.label || null,
          reason: "user_requested_generate",
        }),
      }),
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ["hamilton-credentials", profileId] })
      if (resp?.already_existed) {
        toast({
          title: "A login is already saved for that portal",
          description: "Hamilton will use the existing saved login. Delete it first if you want a new one.",
        })
      } else if (resp?.password_one_time_view) {
        setRevealedPassword({
          host: genForm.portalHost || genForm.login_url,
          username: genForm.username,
          password: resp.password_one_time_view,
          credentialId: resp.credential?.id,
        })
        setRevealAlreadyDone(false)
        setGenOpen(false)
        setGenForm({ portalHost: "", login_url: "", username: "", label: "" })
      }
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not generate login", description: err?.message || "Check the host and username and try again." })
    },
  })

  // Re-reveal the password ONCE for an existing row (e.g. user closed the
  // initial reveal before copying). After this call succeeds the row's
  // reveal-counter is exhausted server-side and the password becomes
  // server-only forever.
  const revealMutation = useMutation({
    mutationFn: (id) => apiFetch(`/api/hamilton/automation/credentials/${id}/reveal-once`, { method: "POST" }),
    onSuccess: (resp, id) => {
      const row = credentials.find((c) => c.id === id)
      if (resp?.already_revealed) {
        setRevealedPassword({
          host: row?.portal_host || "",
          username: row?.username_masked || "",
          password: null,
          credentialId: id,
        })
        setRevealAlreadyDone(true)
      } else if (resp?.password) {
        setRevealedPassword({
          host: row?.portal_host || "",
          username: row?.username_masked || "",
          password: resp.password,
          credentialId: id,
        })
        setRevealAlreadyDone(false)
      }
      queryClient.invalidateQueries({ queryKey: ["hamilton-credentials", profileId] })
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not reveal password", description: err?.message || "Try again." })
    },
  })

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({ title: "Copied to clipboard" })
    } catch {
      toast({ variant: "destructive", title: "Copy failed — please select and copy manually." })
    }
  }

  const canSave = form.username.trim() && form.password.trim() && (form.portalHost.trim() || form.login_url.trim())
  const canGenerate = genForm.username.trim() && (genForm.portalHost.trim() || genForm.login_url.trim())

  return (
    <Card data-flash-id="saved-logins">
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
            <div className="flex items-center gap-1">
              <Button
                variant="outline" size="sm"
                className="h-7 gap-1 px-2 text-xs border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100"
                onClick={() => setGenOpen(true)}
                title="Hamilton picks a strong password and saves it here"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Generate login
              </Button>
              <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add login
              </Button>
            </div>
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <Lock className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <span className="text-sm font-medium text-slate-900 truncate">{c.portal_host}</span>
                    {c.label && <Badge variant="outline" className="text-[11px]">{c.label}</Badge>}
                    {c.generated_by && (
                      <Badge className="text-[11px] bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100 gap-1">
                        <Bot className="h-3 w-3" />
                        Generated by {c.generated_by === "hamilton" ? "Hamilton" : c.generated_by}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 truncate">
                    {c.username_masked || "saved login"} · password stored
                    {c.last_used_at ? " · used by Hamilton" : ""}
                    {c.password_revealed_once_at ? " · password reveal used" : c.generated_by ? " · password reveal available" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Reveal-once is only meaningful for Hamilton-generated rows
                      where the user may have closed the initial dialog before
                      copying. Existing user-entered passwords aren't revealed
                      here — the user already has them. */}
                  {c.generated_by && !c.password_revealed_once_at && (
                    <Button
                      variant="ghost" size="sm" className="text-slate-500 hover:text-amber-700"
                      onClick={() => revealMutation.mutate(c.id)}
                      disabled={revealMutation.isPending}
                      title="Reveal generated password (one time only)"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost" size="sm" className="text-slate-500 hover:text-red-600"
                    onClick={() => deleteMutation.mutate(c.id)}
                    disabled={deleteMutation.isPending}
                    title="Remove login"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Hamilton-generated login dialog: user supplies host + username; the
          server picks the password. Password is shown ONCE in the next dialog. */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              Have Hamilton pick a strong password
            </DialogTitle>
            <DialogDescription>
              Tell Hamilton the portal and the username you want to use. He'll pick a strong, random password, save it
              encrypted in this vault, and show it to you exactly once so you can also store it elsewhere.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="gen-host">Portal site or login URL</Label>
              <Input id="gen-host" placeholder="commonapp.org  (or https://app.commonapp.org/login)"
                value={genForm.portalHost} onChange={(e) => setGen("portalHost", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gen-loginurl">Direct login URL (optional)</Label>
              <Input id="gen-loginurl" placeholder="https://app.commonapp.org/login"
                value={genForm.login_url} onChange={(e) => setGen("login_url", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gen-user">Username, email, or handle</Label>
              <Input id="gen-user" autoComplete="off" placeholder="anastasia@example.com"
                value={genForm.username} onChange={(e) => setGen("username", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gen-label">Label (optional)</Label>
              <Input id="gen-label" placeholder="Common App account"
                value={genForm.label} onChange={(e) => setGen("label", e.target.value)} />
            </div>
            <Alert className="border-amber-200 bg-amber-50">
              <ShieldCheck className="h-4 w-4 text-amber-700" />
              <AlertDescription className="text-amber-950 text-xs">
                Hamilton picks a random 28-character password. The password is shown once on the next screen
                so you can also save it in your own password manager. After that, only Hamilton's autopilot path
                can use it — the password is never returned to a browser again.
              </AlertDescription>
            </Alert>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGenOpen(false)} disabled={generateMutation.isPending}>Cancel</Button>
            <Button onClick={() => generateMutation.mutate()} disabled={!canGenerate || generateMutation.isPending}>
              {generateMutation.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating…</> : "Generate strong password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time reveal dialog for a freshly-generated (or re-revealed) login. */}
      <Dialog open={Boolean(revealedPassword)} onOpenChange={(o) => { if (!o) setRevealedPassword(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-amber-600" />
              {revealAlreadyDone ? "Reveal already used" : "Save this password now"}
            </DialogTitle>
            <DialogDescription>
              {revealAlreadyDone
                ? "This password has already been revealed once. For your security it can no longer be displayed in the browser. Hamilton can still use it during autopilot. Delete and regenerate if you need a new one."
                : "Hamilton picked this random password for the portal below. Copy it into your own password manager now — it will not be shown again."}
            </DialogDescription>
          </DialogHeader>
          {revealedPassword && (
            <div className="space-y-3">
              <div className="rounded-md bg-slate-50 border border-slate-200 p-3 text-sm">
                <div className="text-slate-500 text-xs">Portal</div>
                <div className="font-medium text-slate-900 break-all">{revealedPassword.host}</div>
                <div className="text-slate-500 text-xs mt-2">Username</div>
                <div className="font-medium text-slate-900 break-all">{revealedPassword.username}</div>
                {revealedPassword.password ? (
                  <>
                    <div className="text-slate-500 text-xs mt-2">Password (shown once)</div>
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm bg-white border border-slate-200 rounded px-2 py-1.5 break-all flex-1 select-all">
                        {revealedPassword.password}
                      </code>
                      <Button variant="outline" size="sm" className="h-8 gap-1" onClick={() => copyToClipboard(revealedPassword.password)}>
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealedPassword(null)}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
