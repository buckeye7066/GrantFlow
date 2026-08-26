import React, { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Copy, Eye, FileUp, KeyRound, Loader2, Lock, Plus, ShieldCheck, Sparkles, Trash2, Upload, Wand2 } from "lucide-react"
import { apiFetch } from "@/api/client"
import { suggestPortalLogin } from "@/api/hamilton"
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
import { copyTextToClipboard } from "@/utils/clipboard"

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

  // Bulk CSV import (Chrome / Edge / Brave / Firefox / 1Password / LastPass).
  // The user picks a file, the textarea fills in, and the server returns a
  // structured summary that we render below the dialog. Plaintext content
  // is never echoed in the UI — only counts and skipped/error reasons.
  const [importOpen, setImportOpen] = useState(false)
  const [importCsvText, setImportCsvText] = useState("")
  const [importSource, setImportSource] = useState("Chrome")
  const [importResult, setImportResult] = useState(null)

  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }))
  const setGen = (k, v) => setGenForm((s) => ({ ...s, [k]: v }))

  // "✨ Auto-fill with Hamilton" state. When a suggestion lands we show a subtle
  // "filled by Hamilton — edit if needed" hint under the affected dialog.
  const [addFilledByHamilton, setAddFilledByHamilton] = useState(false)
  const [genFilledByHamilton, setGenFilledByHamilton] = useState(false)

  // Apply a best-effort suggestion to a form without clobbering anything the
  // user already typed. Returns true if it changed at least one field.
  const applySuggestion = (suggestion, current, applyFn) => {
    if (!suggestion) return false
    let changed = false
    const next = {}
    if (suggestion.portalHost && !current.portalHost.trim()) { next.portalHost = suggestion.portalHost; changed = true }
    if ((suggestion.login_url || suggestion.loginUrl) && !current.login_url.trim()) { next.login_url = suggestion.login_url || suggestion.loginUrl; changed = true }
    if (suggestion.username && !current.username.trim()) { next.username = suggestion.username; changed = true }
    if (suggestion.label && !current.label.trim()) { next.label = suggestion.label; changed = true }
    if (changed) applyFn(next)
    return changed
  }

  // Auto-fill the Add-login dialog. Passes the typed partial as both a host hint
  // and a free-text context so Hamilton can resolve a portal she already knows.
  const addSuggestMutation = useMutation({
    mutationFn: () => suggestPortalLogin(profileId, {
      portalHost: form.portalHost || form.login_url || null,
      context: form.portalHost || form.label || null,
    }),
    onSuccess: (resp) => {
      const filled = applySuggestion(resp, form, (next) => setForm((s) => ({ ...s, ...next })))
      setAddFilledByHamilton(filled)
      if (!filled) {
        toast({ title: "Nothing to auto-fill yet", description: "Type the portal name or pick it from an opportunity, then try again." })
      }
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Auto-fill failed", description: err?.message || "Enter the details manually." })
    },
  })

  const genSuggestMutation = useMutation({
    mutationFn: () => suggestPortalLogin(profileId, {
      portalHost: genForm.portalHost || genForm.login_url || null,
      context: genForm.portalHost || genForm.label || null,
    }),
    onSuccess: (resp) => {
      const filled = applySuggestion(resp, genForm, (next) => setGenForm((s) => ({ ...s, ...next })))
      setGenFilledByHamilton(filled)
      if (!filled) {
        toast({ title: "Nothing to auto-fill yet", description: "Type the portal name or pick it from an opportunity, then try again." })
      }
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Auto-fill failed", description: err?.message || "Enter the details manually." })
    },
  })

  // On open, default the username to the profile's primary email when the user
  // hasn't typed one. We reuse the suggest endpoint (username comes from the
  // profile) so we never duplicate the email-resolution logic on the client.
  // The functional setter guard prevents clobbering anything the user has
  // already typed, and the `active` flag avoids state updates after unmount.
  useEffect(() => {
    if (!open || !profileId) return undefined
    let active = true
    suggestPortalLogin(profileId, {})
      .then((resp) => { if (active && resp?.username) setForm((s) => (s.username.trim() ? s : { ...s, username: resp.username })) })
      .catch(() => { /* manual entry still works */ })
    return () => { active = false }
  }, [open, profileId])

  useEffect(() => {
    if (!genOpen || !profileId) return undefined
    let active = true
    suggestPortalLogin(profileId, {})
      .then((resp) => { if (active && resp?.username) setGenForm((s) => (s.username.trim() ? s : { ...s, username: resp.username })) })
      .catch(() => { /* manual entry still works */ })
    return () => { active = false }
  }, [genOpen, profileId])

  // Deep-link target for Hamilton's "Add a login for <host>" flag: when the URL
  // carries ?addLogin=<host>&loginUrl=<url>, open the add-login dialog prefilled
  // so the student or admin jumps straight to adding the missing credential.
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search)
      const host = sp.get("addLogin")
      if (!host) return
      setForm((s) => ({ ...s, portalHost: host, login_url: sp.get("loginUrl") || s.login_url }))
      setOpen(true)
    } catch { /* ignore malformed query */ }
    // run once on mount
  }, [])

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
      toast({
        title: "Login saved",
        description: "Hamilton can now sign in to this portal for this profile. If the portal asks for 2FA, complete it yourself and save a trusted session.",
      })
      setOpen(false)
      setForm({ portalHost: "", login_url: "", username: "", password: "", label: "" })
      queryClient.invalidateQueries({ queryKey: ["hamilton-credentials", profileId] })
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not save login", description: err?.message || "Check the fields and try again." })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => apiFetch(`/api/hamilton/automation/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
      } else {
        // Success response without the expected password field. Keep the dialog
        // open and surface a clear error so the user isn't left without their
        // one-time password and no feedback.
        toast({
          variant: "destructive",
          title: "Password was not returned",
          description: "Hamilton saved nothing to reveal. Please try generating the login again.",
        })
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
    mutationFn: (id) => apiFetch(`/api/hamilton/automation/credentials/${encodeURIComponent(id)}/reveal-once`, { method: "POST" }),
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
      } else {
        // Unexpected response shape — neither a password nor an
        // already-revealed flag. Surface an error instead of failing silently.
        toast({
          variant: "destructive",
          title: "Could not reveal password",
          description: "Hamilton returned an unexpected response. Try again, or delete and regenerate the login.",
        })
      }
      queryClient.invalidateQueries({ queryKey: ["hamilton-credentials", profileId] })
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not reveal password", description: err?.message || "Try again." })
    },
  })

  const copyToClipboard = async (text) => {
    try {
      const copied = await copyTextToClipboard(text)
      if (!copied) throw new Error("Clipboard copy unavailable")
      toast({ title: "Copied to clipboard" })
    } catch (err) {
      console.error("Clipboard copy failed:", err)
      toast({
        variant: "destructive",
        title: "Copy failed",
        description: err?.message ? `Please select and copy manually. (${err.message})` : "Please select and copy manually.",
      })
    }
  }

  const importMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/hamilton/automation/credentials/import-csv`, {
        method: "POST",
        body: JSON.stringify({
          profileId,
          csv_text: importCsvText,
          source: importSource || "CSV import",
        }),
      }),
    onSuccess: (resp) => {
      setImportResult(resp)
      // Drop the textarea contents from memory the moment the import is
      // accepted. The encrypted rows live on the server; the plaintext
      // CSV doesn't need to linger in the React state.
      setImportCsvText("")
      queryClient.invalidateQueries({ queryKey: ["hamilton-credentials", profileId] })
      const imported = Number(resp?.imported || 0)
      const skipped = Array.isArray(resp?.skipped) ? resp.skipped.length : 0
      const errors = Array.isArray(resp?.errors) ? resp.errors.length : 0
      toast({
        title: `Imported ${imported} login${imported === 1 ? "" : "s"}`,
        description: skipped || errors
          ? `${skipped} skipped, ${errors} errors. See the dialog for details.`
          : "All entries saved.",
      })
    },
    onError: (err) => {
      toast({
        variant: "destructive",
        title: "Could not import CSV",
        description: err?.message || "Check that the file has url, username, and password columns.",
      })
    },
  })

  const handleCsvFile = (file) => {
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      toast({ variant: "destructive", title: "File too large", description: "CSV must be under 5 MB." })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : ""
      setImportCsvText(text)
      // Heuristically guess the source label from the filename so the
      // imported rows are tagged "Chrome", "Edge", etc. The user can
      // override before clicking Import.
      const lower = (file.name || "").toLowerCase()
      if (lower.includes("chrome")) setImportSource("Chrome")
      else if (lower.includes("edge")) setImportSource("Edge")
      else if (lower.includes("brave")) setImportSource("Brave")
      else if (lower.includes("firefox")) setImportSource("Firefox")
      else if (lower.includes("1password")) setImportSource("1Password")
      else if (lower.includes("lastpass")) setImportSource("LastPass")
      else if (lower.includes("safari")) setImportSource("Safari")
      else setImportSource("CSV import")
    }
    reader.onerror = () => {
      const reason = reader.error?.message || reader.error?.name || "Unknown error"
      console.error("CSV file read failed:", reader.error)
      toast({ variant: "destructive", title: "Could not read file", description: `Please try again. (${reason})` })
    }
    reader.readAsText(file)
  }

  const canSave = form.username.trim() && form.password.trim() && (form.portalHost.trim() || form.login_url.trim())
  const canGenerate = genForm.username.trim() && (genForm.portalHost.trim() || genForm.login_url.trim())
  // Relaxed header heuristic: strip CR, handle single-line files (no trailing
  // newline), and let the server perform authoritative validation. We only
  // block obviously empty input here.
  const importFirstLine = (importCsvText.split(/\r?\n/)[0] || "").trim()
  const canImport = importCsvText.trim().length > 0 && importFirstLine.length > 0
  // Estimate the data-row count for the button label, ignoring blank/trailing
  // lines and the header row, clamped at 0.
  const importRowCount = Math.max(0, importCsvText.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1)

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
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => { setImportResult(null); setImportOpen(true) }}
                title="Import a Chrome / Edge / Brave / Firefox / 1Password / LastPass CSV password export"
              >
                <FileUp className="h-3.5 w-3.5" />
                Import CSV
              </Button>
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
            Hamilton uses them only to sign in to that portal during autopilot. If a portal asks for 2FA, Hamilton stops for you; finish the check yourself and save a trusted browser session.
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

      {/* Bulk CSV import (Chrome / Edge / Brave / Firefox / 1Password /
          LastPass). Plaintext CSV is sent ONCE; the server encrypts each
          row at rest and returns a structured, no-plaintext summary. */}
      <Dialog open={importOpen} onOpenChange={(o) => { setImportOpen(o); if (!o) { setImportResult(null); setImportCsvText("") } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileUp className="h-4 w-4 text-indigo-600" />
              Import logins from a CSV
            </DialogTitle>
            <DialogDescription>
              Drop in a Chrome / Edge / Brave / Firefox / 1Password / LastPass password export.
              Hamilton encrypts every password as soon as it lands on the server and skips Android-only entries
              (apps without a usable web host) and rows missing a username or password.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <Label
                htmlFor="csv-file"
                className="cursor-pointer inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
              >
                <Upload className="h-4 w-4 text-slate-600" />
                Choose CSV file…
              </Label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => handleCsvFile(e.target.files?.[0])}
              />
              <div className="flex-1" />
              <Label htmlFor="csv-source" className="text-xs text-slate-500">Tag rows as</Label>
              <Input
                id="csv-source"
                className="h-8 w-32"
                value={importSource}
                onChange={(e) => setImportSource(e.target.value)}
                placeholder="Chrome"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="csv-text" className="text-xs">…or paste the CSV contents</Label>
              <textarea
                id="csv-text"
                className="min-h-[140px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 font-mono text-xs"
                placeholder={'name,url,username,password,note\nExample,https://example.com/login,user@example.com,hunter2,'}
                value={importCsvText}
                onChange={(e) => setImportCsvText(e.target.value)}
              />
              <p className="text-xs text-slate-500">
                The first row must be a header with at least <code>url</code>, <code>username</code>, <code>password</code> columns.
                The CSV is sent over HTTPS and never stored on disk in plaintext.
              </p>
            </div>
            {importResult && (
              <Alert className="border-indigo-200 bg-indigo-50">
                <ShieldCheck className="h-4 w-4 text-indigo-700" />
                <AlertDescription className="text-indigo-950 text-sm space-y-1">
                  <div>
                    <span className="font-semibold">Imported {importResult.imported}</span>
                    {" of "}{importResult.total} row{importResult.total === 1 ? "" : "s"}
                    {Array.isArray(importResult.skipped) && importResult.skipped.length > 0 && (
                      <> · {importResult.skipped.length} skipped</>
                    )}
                    {Array.isArray(importResult.errors) && importResult.errors.length > 0 && (
                      <> · {importResult.errors.length} errors</>
                    )}
                  </div>
                  {Array.isArray(importResult.skipped) && importResult.skipped.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer">Show skipped rows</summary>
                      <ul className="mt-1 ml-4 list-disc">
                        {importResult.skipped.slice(0, 50).map((s, i) => (
                          <li key={i}>
                            row {s.row}: {s.reason}{s.label ? ` — ${s.label}` : ""}
                          </li>
                        ))}
                        {importResult.skipped.length > 50 && (
                          <li>…and {importResult.skipped.length - 50} more.</li>
                        )}
                      </ul>
                    </details>
                  )}
                  {Array.isArray(importResult.errors) && importResult.errors.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer">Show errors</summary>
                      <ul className="mt-1 ml-4 list-disc">
                        {importResult.errors.slice(0, 50).map((e, i) => (
                          <li key={i}>row {e.row}: {e.reason}{e.message ? ` — ${e.message}` : ""}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)} disabled={importMutation.isPending}>Close</Button>
            <Button
              onClick={() => importMutation.mutate()}
              disabled={!canImport || importMutation.isPending}
            >
              {importMutation.isPending
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing…</>
                : <>Import {importCsvText ? `${importRowCount} rows` : "CSV"}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hamilton-generated login dialog: user supplies host + username; the
          server picks the password. Password is shown ONCE in the next dialog. */}
      <Dialog open={genOpen} onOpenChange={(o) => { setGenOpen(o); if (!o) setGenFilledByHamilton(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              Have Hamilton pick a strong password
            </DialogTitle>
            <DialogDescription>
              Tell Hamilton the portal and the username you want to use — or let Hamilton auto-fill what she already
              knows. He'll pick a strong, random password, save it encrypted in this vault, and show it to you exactly
              once so you can also store it elsewhere.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-slate-500">Hamilton usually already knows the portal and your username.</p>
              <Button
                type="button" variant="outline" size="sm"
                className="h-7 gap-1 px-2 text-xs border-indigo-200 bg-indigo-50 text-indigo-900 hover:bg-indigo-100"
                onClick={() => genSuggestMutation.mutate()}
                disabled={genSuggestMutation.isPending}
                title="Let Hamilton fill the portal site, login URL, and username"
              >
                {genSuggestMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Wand2 className="h-3.5 w-3.5" />}
                Auto-fill with Hamilton
              </Button>
            </div>
            {genFilledByHamilton && (
              <p className="text-xs text-indigo-600 flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> Filled by Hamilton — edit if needed.
              </p>
            )}
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
              <Input id="gen-user" autoComplete="off" placeholder="demo_stem_student@example.com"
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

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setAddFilledByHamilton(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a portal login</DialogTitle>
            <DialogDescription>
              Hamilton already knows the portal (and usually your username) — tap <span className="font-medium">Auto-fill with Hamilton</span> and
              you only need to enter your password. The password is encrypted and never displayed again.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-slate-500">Only your password is usually required.</p>
              <Button
                type="button" variant="outline" size="sm"
                className="h-7 gap-1 px-2 text-xs border-indigo-200 bg-indigo-50 text-indigo-900 hover:bg-indigo-100"
                onClick={() => addSuggestMutation.mutate()}
                disabled={addSuggestMutation.isPending}
                title="Let Hamilton fill the portal site, login URL, and username"
              >
                {addSuggestMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Wand2 className="h-3.5 w-3.5" />}
                Auto-fill with Hamilton
              </Button>
            </div>
            {addFilledByHamilton && (
              <p className="text-xs text-indigo-600 flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> Filled by Hamilton — edit if needed.
              </p>
            )}
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

