import React, { useState } from "react"
import { AlertCircle, Database, Loader2, RefreshCw, Wand2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { apiFetch } from "@/api/client"

async function post(path, body) {
  return apiFetch(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  })
}

export default function AdminMaintenance() {
  const { toast } = useToast()
  const [busy, setBusy] = useState(null)
  const [output, setOutput] = useState(null)
  const [excludeProfilesJson, setExcludeProfilesJson] = useState('["admin"]')

  const run = async (label, fn) => {
    try {
      setBusy(label)
      setOutput(null)
      const res = await fn()
      setOutput(res)
      toast({ title: "Success", description: label })
    } catch (err) {
      toast({ title: "Failed", description: err.message, variant: "destructive" })
      setOutput({ error: err.message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-slate-900">
            <Database className="w-5 h-5 text-blue-600" />
            Maintenance & Data Ops
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              These are admin-only maintenance tools (seed/sync/ingest/repair). Run carefully.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => run("DB stats", () => apiFetch("/api/admin/db-stats"))}
              disabled={!!busy}
            >
              {busy === "DB stats" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              DB stats
            </Button>

            <Button
              variant="outline"
              onClick={() => run("Seed opportunities (curated files)", () => post("/api/admin/seed-opportunities"))}
              disabled={!!busy}
            >
              {busy === "Seed opportunities (curated files)" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Wand2 className="w-4 h-4 mr-2" />
              )}
              Seed opportunities
            </Button>

            <Button
              variant="outline"
              onClick={() => run("Sync designated profiles", () => post("/api/admin/sync-profiles"))}
              disabled={!!busy}
            >
              {busy === "Sync designated profiles" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Sync profiles
            </Button>

            <Button
              variant="outline"
              onClick={() => run("Seed baseline profiles (15)", () => post("/api/admin/seed-baseline-profiles"))}
              disabled={!!busy}
            >
              {busy === "Seed baseline profiles (15)" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
              Seed baseline profiles
            </Button>

            <Button
              variant="outline"
              onClick={() => run("Ingest (Grants.gov + USASpending.gov)", () => post("/api/admin/ingest"))}
              disabled={!!busy}
            >
              {busy === "Ingest (Grants.gov + USASpending.gov)" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              Ingest
            </Button>

            <Button
              variant="outline"
              onClick={() => run("Link admin to organizations", () => post("/api/admin/link-admin-to-organizations"))}
              disabled={!!busy}
            >
              {busy === "Link admin to organizations" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              Link admin → orgs
            </Button>

            <Button
              variant="outline"
              onClick={() => run("Reattach users to profiles", () => post("/api/admin/reattach-users"))}
              disabled={!!busy}
            >
              {busy === "Reattach users to profiles" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              Reattach users
            </Button>
          </div>

          <div className="space-y-2">
            <Label>Seed profile grants (optional exclude list)</Label>
            <Textarea
              value={excludeProfilesJson}
              onChange={(e) => setExcludeProfilesJson(e.target.value)}
              placeholder='e.g. ["admin","test"]'
              className="min-h-[84px]"
            />
            <Button
              variant="outline"
              onClick={() =>
                run("Seed profile grants", () => {
                  let excludeProfiles = []
                  try {
                    excludeProfiles = JSON.parse(excludeProfilesJson || "[]")
                  } catch {
                    excludeProfiles = []
                  }
                  return post("/api/admin/seed-profile-grants", { excludeProfiles })
                })
              }
              disabled={!!busy}
            >
              {busy === "Seed profile grants" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
              Seed profile grants
            </Button>
          </div>

          {output ? (
            <pre className="text-xs bg-slate-950 text-slate-50 rounded-md p-3 overflow-auto max-h-96">
              {JSON.stringify(output, null, 2)}
            </pre>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

