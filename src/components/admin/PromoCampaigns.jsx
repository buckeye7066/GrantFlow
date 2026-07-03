/**
 * PromoCampaigns — Admin → Promotion.
 *
 * The owner's checkbox-driven, cross-app promotion system: check a platform
 * and GrantFlow starts posting AI-written promos for the enabled apps on an
 * aggressive (but platform-capped) cadence, attaching each app's uploaded
 * video where the platform supports media. Apps are extensible — "Add app"
 * registers a new product without code changes. Every post lands in the log
 * below, successes and failures alike.
 *
 * A channel posts only when BOTH its box is checked AND its platform
 * credentials are configured (the card shows exactly which env vars a
 * platform needs, with a setup hint) — checking a box never fakes a post.
 */

import React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { showSuccessToast, showErrorToast } from "@/components/shared/toastHelpers"
import { Megaphone, Loader2, Upload, Trash2, Plus, Send, Video } from "lucide-react"

const CADENCES = [
  { label: "Aggressive — every 3h", minutes: 180 },
  { label: "Bold — every 6h", minutes: 360 },
  { label: "Daily", minutes: 1440 },
  { label: "Every 2 days", minutes: 2880 },
  { label: "Weekly", minutes: 10080 },
]

function cadenceLabel(minutes) {
  const hit = CADENCES.find((c) => c.minutes === Number(minutes))
  if (hit) return hit.label
  const h = Math.round(Number(minutes) / 60)
  return h >= 24 ? `Every ${Math.round(h / 24)}d` : `Every ${h}h`
}

export default function PromoCampaigns() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [newApp, setNewApp] = React.useState(null)
  const [postingKey, setPostingKey] = React.useState(null)
  const fileRefs = React.useRef({})

  const overviewQuery = useQuery({
    queryKey: ["promo-overview"],
    queryFn: () => apiFetch("/api/promo/overview"),
    refetchInterval: 60_000,
  })
  const data = overviewQuery.data
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["promo-overview"] })

  const channelMutation = useMutation({
    mutationFn: ({ platform, enabled, cadence_minutes }) =>
      apiFetch(`/api/promo/channels/${platform}`, {
        method: "POST",
        body: JSON.stringify({ enabled, cadence_minutes }),
      }),
    onSuccess: refresh,
    onError: (err) => showErrorToast(toast, "Couldn't update channel", err?.message),
  })

  const appMutation = useMutation({
    mutationFn: (app) => apiFetch("/api/promo/apps", { method: "POST", body: JSON.stringify(app) }),
    onSuccess: () => {
      setNewApp(null)
      refresh()
    },
    onError: (err) => showErrorToast(toast, "Couldn't save app", err?.message),
  })

  const postNow = async (platform, appId = null) => {
    setPostingKey(`${platform}:${appId || "auto"}`)
    try {
      const res = await apiFetch("/api/promo/post-now", {
        method: "POST",
        body: JSON.stringify({ platform, app_id: appId }),
      })
      if (res.status === "posted") {
        showSuccessToast(toast, "Posted", res.external_url || `Published to ${platform}.`)
      } else {
        showErrorToast(toast, `Not posted (${res.status})`, res.error || res.reason || "See the log below.")
      }
    } catch (err) {
      showErrorToast(toast, "Post failed", err?.message)
    } finally {
      setPostingKey(null)
      refresh()
    }
  }

  const uploadAsset = async (appId, file) => {
    if (!file) return
    const fd = new FormData()
    fd.append("file", file)
    try {
      await apiFetch(`/api/promo/apps/${appId}/assets`, { method: "POST", body: fd })
      showSuccessToast(toast, "Video uploaded", `${file.name} will ride along on platforms that take media.`)
      refresh()
    } catch (err) {
      showErrorToast(toast, "Upload failed", err?.message)
    }
  }

  if (overviewQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading promotion campaigns…
      </div>
    )
  }
  if (overviewQuery.isError || !data?.ok) {
    return <p className="py-4 text-sm text-red-600">Could not load promotion campaigns. Refresh to retry.</p>
  }

  const { apps = [], channels = [], recent_posts: recentPosts = [] } = data

  return (
    <div className="space-y-6">
      {/* ── Platform checkboxes ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" />
            Promotion channels
          </CardTitle>
          <CardDescription>
            Check a platform and GrantFlow starts promoting every enabled app on it — fresh AI-written copy each
            post, rotating angles, your videos attached where the platform allows. Cadences are capped per
            platform so an aggressive campaign builds attention without tripping spam rules. A channel posts only
            once its credentials are set (each card names the exact variables).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {channels.map((ch) => (
              <div
                key={ch.platform}
                className={`rounded-lg border p-3 ${ch.enabled ? "border-emerald-300 bg-emerald-50/40" : "border-border"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <label className="flex cursor-pointer items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-emerald-600"
                      checked={Boolean(ch.enabled)}
                      onChange={(e) => channelMutation.mutate({ platform: ch.platform, enabled: e.target.checked })}
                    />
                    {ch.label || ch.platform}
                  </label>
                  {ch.configured ? (
                    <Badge className="bg-emerald-600 text-[10px]">Ready</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">Needs setup</Badge>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <select
                    value={ch.cadence_minutes}
                    onChange={(e) => channelMutation.mutate({ platform: ch.platform, cadence_minutes: Number(e.target.value) })}
                    className="rounded-md border border-input bg-background px-2 py-1"
                  >
                    {[...new Set([...CADENCES.map((c) => c.minutes), Number(ch.cadence_minutes)])]
                      .sort((a, b) => a - b)
                      .map((m) => (
                        <option key={m} value={m}>{cadenceLabel(m)}</option>
                      ))}
                  </select>
                  {ch.supports_video ? (
                    <span className="inline-flex items-center gap-1 text-muted-foreground"><Video className="h-3 w-3" /> video</span>
                  ) : null}
                  <button
                    type="button"
                    disabled={!ch.configured || postingKey === `${ch.platform}:auto`}
                    onClick={() => postNow(ch.platform)}
                    className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 font-medium hover:bg-muted disabled:opacity-50"
                    title="Post one promo right now"
                  >
                    {postingKey === `${ch.platform}:auto` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                    Post now
                  </button>
                </div>
                {!ch.configured ? (
                  <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                    Set <span className="font-mono">{(ch.required_env || []).join(", ")}</span> on Railway.{" "}
                    {ch.setup_hint}
                  </p>
                ) : ch.last_posted_at ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Last post: {new Date(ch.last_posted_at).toLocaleString()}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Apps being promoted ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Apps in the campaign</CardTitle>
            <CardDescription>
              Check the apps to promote. Upload each app&rsquo;s promo video — it&rsquo;s attached automatically on
              platforms that accept media. Add more apps any time.
            </CardDescription>
          </div>
          <Button variant="outline" className="gap-1.5" onClick={() => setNewApp({ name: "", url: "", tagline: "", description: "" })}>
            <Plus className="h-4 w-4" /> Add app
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {newApp ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3">
              <p className="mb-2 text-sm font-semibold">New app</p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <input className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" placeholder="Name *"
                  value={newApp.name} onChange={(e) => setNewApp({ ...newApp, name: e.target.value })} />
                <input className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" placeholder="URL * (where the post links)"
                  value={newApp.url} onChange={(e) => setNewApp({ ...newApp, url: e.target.value })} />
                <input className="rounded-md border border-input bg-background px-2 py-1.5 text-sm md:col-span-2" placeholder="Tagline"
                  value={newApp.tagline} onChange={(e) => setNewApp({ ...newApp, tagline: e.target.value })} />
                <textarea className="rounded-md border border-input bg-background px-2 py-1.5 text-sm md:col-span-2" rows={3}
                  placeholder="What it does (the copywriter only sells what you write here — no invented claims)"
                  value={newApp.description} onChange={(e) => setNewApp({ ...newApp, description: e.target.value })} />
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={!newApp.name.trim() || !newApp.url.trim() || appMutation.isPending}
                  onClick={() => appMutation.mutate(newApp)}
                >
                  Save app
                </Button>
                <Button size="sm" variant="outline" onClick={() => setNewApp(null)}>Cancel</Button>
              </div>
            </div>
          ) : null}

          {apps.map((app) => (
            <div key={app.id} className={`rounded-lg border p-3 ${app.enabled ? "border-border" : "border-border opacity-60"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-emerald-600"
                    checked={Boolean(app.enabled)}
                    onChange={(e) => appMutation.mutate({ ...app, enabled: e.target.checked })}
                  />
                  {app.name}
                  <span className="text-xs font-normal text-muted-foreground">{app.tagline}</span>
                </label>
                <div className="flex items-center gap-2">
                  {(app.assets || []).filter((a) => a.kind === "video").length > 0 ? (
                    <Badge variant="secondary" className="gap-1 text-[10px]"><Video className="h-3 w-3" /> video ready</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">no video yet</Badge>
                  )}
                  <input
                    ref={(el) => { fileRefs.current[app.id] = el }}
                    type="file"
                    accept="video/*,image/*"
                    className="hidden"
                    onChange={(e) => { uploadAsset(app.id, e.target.files?.[0]); e.target.value = "" }}
                  />
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => fileRefs.current[app.id]?.click()}>
                    <Upload className="h-3.5 w-3.5" /> Upload video
                  </Button>
                </div>
              </div>
              {(app.assets || []).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {app.assets.map((a) => (
                    <span key={a.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px]">
                      {a.file_name || a.id} ({Math.round((a.file_size || 0) / 1024 / 1024)}MB)
                      <button
                        type="button"
                        className="text-red-500 hover:text-red-700"
                        title="Delete asset"
                        onClick={async () => {
                          if (!window.confirm(`Delete ${a.file_name || "this asset"}?`)) return
                          try { await apiFetch(`/api/promo/assets/${a.id}`, { method: "DELETE" }); refresh() }
                          catch (err) { showErrorToast(toast, "Delete failed", err?.message) }
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── Post log ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Recent posts</CardTitle>
          <CardDescription>Every attempt, successes and failures alike — the campaign never posts silently.</CardDescription>
        </CardHeader>
        <CardContent>
          {recentPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No posts yet. Check a ready channel above (or hit Post now) to start.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-1.5 pr-2">When</th>
                    <th className="py-1.5 pr-2">Platform</th>
                    <th className="py-1.5 pr-2">App</th>
                    <th className="py-1.5 pr-2">Status</th>
                    <th className="py-1.5">Post</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPosts.map((p) => (
                    <tr key={p.id} className="border-b border-border/60 align-top">
                      <td className="py-1.5 pr-2 whitespace-nowrap">{new Date(p.created_at).toLocaleString()}</td>
                      <td className="py-1.5 pr-2">{p.platform}</td>
                      <td className="py-1.5 pr-2">{p.app_id}</td>
                      <td className="py-1.5 pr-2">
                        {p.status === "posted" ? (
                          <Badge className="bg-emerald-600 text-[10px]">posted</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]" title={p.error || ""}>{p.status}</Badge>
                        )}
                      </td>
                      <td className="py-1.5">
                        <span className="line-clamp-2 max-w-xl">{p.content}</span>
                        {p.external_url ? (
                          <a href={p.external_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                            view ↗
                          </a>
                        ) : null}
                        {p.error ? <span className="block text-red-600">{p.error}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
