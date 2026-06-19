import React, { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, Plus, Trash2 } from "lucide-react"
import { apiFetch } from "@/api/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"

const TZ_OPTIONS = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "UTC",
]

/**
 * PortalAccessScheduleCard
 *
 * Lets the owner pick the time-of-day window(s) when Hamilton may access portals
 * unattended, so they're available for any sign-in / 2FA prompt. Outside the
 * window Hamilton defers portal work to the next window. Empty = any time.
 */
export default function PortalAccessScheduleCard({ profileId }) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return "America/New_York" } })()

  const { data, isLoading } = useQuery({
    queryKey: ["portal-access-schedule", profileId],
    queryFn: () => apiFetch(`/api/profiles/${profileId}/portal-access-schedule`),
    enabled: Boolean(profileId),
  })

  const [enabled, setEnabled] = useState(false)
  const [timezone, setTimezone] = useState(browserTz)
  const [windows, setWindows] = useState([{ start: "09:00", end: "10:00" }])

  useEffect(() => {
    const s = data?.schedule
    if (!s) return
    setEnabled(Boolean(s.enabled))
    if (s.timezone) setTimezone(s.timezone)
    if (Array.isArray(s.windows) && s.windows.length) {
      setWindows(s.windows.map((w) => ({ start: w.start, end: w.end })))
    }
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/profiles/${profileId}/portal-access-schedule`, {
        method: "PUT",
        body: JSON.stringify({ enabled, timezone, windows }),
      }),
    onSuccess: () => {
      toast({ title: "Access schedule saved" })
      qc.invalidateQueries({ queryKey: ["portal-access-schedule", profileId] })
    },
    onError: (err) => toast({ title: "Could not save", description: err?.message, variant: "destructive" }),
  })

  const setWin = (i, k, v) => setWindows((ws) => ws.map((w, idx) => (idx === i ? { ...w, [k]: v } : w)))
  const addWin = () => setWindows((ws) => [...ws, { start: "18:00", end: "19:00" }])
  const removeWin = (i) => setWindows((ws) => ws.filter((_, idx) => idx !== i))

  const tzList = TZ_OPTIONS.includes(browserTz) ? TZ_OPTIONS : [browserTz, ...TZ_OPTIONS]

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-5 w-5 text-emerald-600" /> When Hamilton accesses portals
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-600">
          Choose the time(s) of day Hamilton may sign in to portals unattended, so you can be available if a portal
          asks for a verification code or approval. Outside these times Hamilton waits and resumes at the next window.
          Leave this off to let her work any time.
        </p>

        <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
          <span className="text-sm font-medium text-slate-800">Only access portals during set times</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {enabled ? (
          <>
            <label className="block text-xs text-slate-600">
              Timezone
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger className="mt-1 h-9 max-w-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {tzList.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>

            <div className="space-y-2">
              {windows.map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input type="time" value={w.start} onChange={(e) => setWin(i, "start", e.target.value)} className="max-w-[8rem]" />
                  <span className="text-slate-500">to</span>
                  <Input type="time" value={w.end} onChange={(e) => setWin(i, "end", e.target.value)} className="max-w-[8rem]" />
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-rose-600" onClick={() => removeWin(i)} aria-label="Remove time window">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={addWin}><Plus className="mr-1 h-3.5 w-3.5" /> Add another time</Button>
            </div>
          </>
        ) : null}

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending || isLoading}>
            {save.isPending ? "Saving…" : "Save schedule"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
