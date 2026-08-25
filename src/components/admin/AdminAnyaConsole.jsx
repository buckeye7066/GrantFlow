import React, { useCallback, useEffect, useState } from "react"
import { AlertCircle, Bot, Loader2, PlayCircle, RefreshCw } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

async function getStatus(type = "all") {
  return apiFetch(`/api/anya/autonomous/status?type=${encodeURIComponent(type)}`)
}

async function post(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) })
}

export default function AdminAnyaConsole() {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [payload, setPayload] = useState('{}')

  const refresh = useCallback(async () => {
    try {
      const res = await getStatus("all")
      setStatus(res)
    } catch (err) {
      toast({ title: "Failed to load Anya status", description: err.message, variant: "destructive" })
    }
  }, [toast])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
  }, [refresh])

  const run = async (label, path) => {
    setBusy(true)
    try {
      let parsed = {}
      try {
        parsed = JSON.parse(payload || "{}")
      } catch (parseErr) {
        toast({ title: "Invalid JSON payload", description: parseErr.message, variant: "destructive" })
        setBusy(false)
        return
      }
      const res = await post(path, parsed)
      toast({ title: label, description: "Submitted" })
      setStatus((prev) => ({ ...(prev || {}), last_run: res }))
      await refresh()
    } catch (err) {
      toast({ title: `Failed: ${label}`, description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-blue-600" />
            Anya Admin Console
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              These endpoints are admin-only and drive Anya autonomous operations. Use small batches and monitor status.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label>Payload (JSON)</Label>
            <Textarea value={payload} onChange={(e) => setPayload(e.target.value)} className="min-h-[90px]" />
            <p className="text-[11px] text-slate-400">
              Geo Crawl tip: <code>{`{"states":["OH","CA"]}`}</code> or <code>{`{"state":"TN","zip_list":["37201"]}`}</code>
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run("Run autonomous code ops", "/api/anya/autonomous/code")} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
              Code ops
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                setBusy(true)
                try {
                  const res = await post("/api/anya/autonomous/code/background", {})
                  toast({ title: res.queued ? "Started in background" : "Status", description: res.message })
                  await refresh()
                } catch (err) {
                  toast({ title: "Background start failed", description: err.message, variant: "destructive" })
                } finally {
                  setBusy(false)
                }
              }}
              disabled={busy || (status?.background_code_crawl_repair?.running)}
            >
              {(status?.background_code_crawl_repair?.running) ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
              Code crawl & repair (background)
            </Button>
            <Button onClick={() => run("Run autonomous crawlers", "/api/anya/autonomous/crawlers")} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
              Crawlers
            </Button>
            <Button onClick={() => run("Test functions", "/api/anya/autonomous/functions")} disabled={busy} variant="outline">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
              Test functions
            </Button>
            <Button onClick={() => run("Test buttons", "/api/anya/autonomous/buttons")} disabled={busy} variant="outline">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
              Test buttons
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                setBusy(true)
                try {
                  let parsed = {}
                  try {
                    parsed = JSON.parse(payload || "{}")
                  } catch (parseErr) {
                    toast({ title: "Invalid JSON payload", description: parseErr.message, variant: "destructive" })
                    return  // finally will call setBusy(false)
                  }
                  const body = { run_all_states: true, ...parsed }
                  const res = await post("/api/geo-crawl/start", body)
                  toast({ title: "Geo Crawl All States", description: res?.message || `Job ${res?.jobId || ''} started` })
                  await refresh()
                } catch (err) {
                  toast({ title: "Geo Crawl failed", description: err.message, variant: "destructive" })
                } finally {
                  setBusy(false)
                }
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
              Geo Crawl All States
            </Button>
            <Button onClick={refresh} disabled={busy} variant="ghost">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>

          {status?.background_code_crawl_repair ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 dark:bg-slate-900/50 dark:border-slate-700 p-3 text-sm">
              <span className="font-medium">Background code crawl & repair: </span>
              {status.background_code_crawl_repair.running ? (
                <span className="text-amber-600 dark:text-amber-400">Running… started {status.background_code_crawl_repair.startedAt ? new Date(status.background_code_crawl_repair.startedAt).toLocaleTimeString() : ''}</span>
              ) : status.background_code_crawl_repair.lastError ? (
                <span className="text-red-600 dark:text-red-400">Last run failed: {status.background_code_crawl_repair.lastError}</span>
              ) : status.background_code_crawl_repair.completedAt ? (
                <span className="text-slate-600 dark:text-slate-400">Idle. Last completed {new Date(status.background_code_crawl_repair.completedAt).toLocaleString()}{status.background_code_crawl_repair.lastResult?.status ? ` (${status.background_code_crawl_repair.lastResult.status})` : ''}</span>
              ) : (
                <span className="text-slate-500">Not run yet. Click &quot;Code crawl & repair (background)&quot; to start.</span>
              )}
            </div>
          ) : null}

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

