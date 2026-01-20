import React, { useEffect, useState } from "react"
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
  const [payload, setPayload] = useState('{"dryRun": false}')

  const refresh = async () => {
    try {
      const res = await getStatus("all")
      setStatus(res)
    } catch (err) {
      toast({ title: "Failed to load Anya status", description: err.message, variant: "destructive" })
    }
  }

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
  }, [])

  const run = async (label, path) => {
    setBusy(true)
    try {
      let parsed = {}
      try {
        parsed = JSON.parse(payload || "{}")
      } catch {
        parsed = {}
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
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run("Run autonomous code ops", "/api/anya/autonomous/code")} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
              Code ops
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
            <Button onClick={refresh} disabled={busy} variant="ghost">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
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

