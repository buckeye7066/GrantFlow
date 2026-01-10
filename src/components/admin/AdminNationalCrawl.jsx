import React, { useEffect, useState } from "react"
import { AlertCircle, Loader2, PauseCircle, PlayCircle, RefreshCw } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

async function fetchStatus() {
  return apiFetch("/api/admin/national-crawl/status")
}

export default function AdminNationalCrawl() {
  const { toast } = useToast()
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [batchSize, setBatchSize] = useState(50)
  const [minSources, setMinSources] = useState(3)

  const refresh = async () => {
    try {
      const res = await fetchStatus()
      setStatus(res)
    } catch (err) {
      toast({ title: "Failed to load national crawl status", description: err.message, variant: "destructive" })
    }
  }

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    setBusy(true)
    try {
      const res = await apiFetch("/api/admin/national-crawl/start", {
        method: "POST",
        body: JSON.stringify({
          batch_size: Number(batchSize) || 50,
          min_sources_per_zip: Number(minSources) || 3,
        }),
      })
      toast({ title: "National crawl started", description: res?.message || "Started" })
      await refresh()
    } catch (err) {
      toast({ title: "Failed to start national crawl", description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      const res = await apiFetch("/api/admin/national-crawl/stop", { method: "POST" })
      toast({ title: "National crawl stopped", description: res?.message || "Stopped" })
      await refresh()
    } catch (err) {
      toast({ title: "Failed to stop national crawl", description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const jobStatus = status?.job?.status || status?.last_job?.status || "unknown"

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle>National ZIP Crawl (legacy)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              This is the legacy nationwide ZIP crawl. Your new approach is state/county/ZIP scoped via Geo Crawl. Keep
              this separate as requested.
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Batch size</Label>
              <Input type="number" min={1} value={batchSize} onChange={(e) => setBatchSize(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Min sources per ZIP</Label>
              <Input type="number" min={1} value={minSources} onChange={(e) => setMinSources(e.target.value)} />
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={start} disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
                Start
              </Button>
              <Button variant="outline" onClick={stop} disabled={busy}>
                <PauseCircle className="w-4 h-4 mr-2" />
                Stop
              </Button>
              <Button variant="ghost" onClick={refresh} disabled={busy}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
            </div>
          </div>

          <div className="text-sm text-slate-700">
            Status: <strong>{jobStatus}</strong>
          </div>

          {status ? (
            <pre className="text-xs bg-slate-950 text-slate-50 rounded-md p-3 overflow-auto max-h-96">
              {JSON.stringify(status, null, 2)}
            </pre>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

