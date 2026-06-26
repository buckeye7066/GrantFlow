import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, RefreshCw, Trash2, Users } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch } from '@/api/client'

async function post(path, body) {
  return apiFetch(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  })
}

export default function AdminProfileDedupe() {
  const { toast } = useToast()
  const [strategy, setStrategy] = useState('similar_name')
  const [loading, setLoading] = useState(false)
  const [groups, setGroups] = useState([])
  const [output, setOutput] = useState(null)

  const summary = useMemo(() => {
    const totalGroups = Array.isArray(groups) ? groups.length : 0
    const totalProfiles = (groups || []).reduce((sum, g) => sum + (g?.count || 0), 0)
    return { totalGroups, totalProfiles }
  }, [groups])

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      setOutput(null)
      const res = await apiFetch(
        `/api/admin/profiles/duplicates?strategy=${encodeURIComponent(strategy)}&limitGroups=50&minGroupSize=2`,
      )
      setGroups(res?.groups || [])
      toast({ title: 'Loaded', description: `Found ${res?.groups?.length || 0} duplicate groups` })
    } catch (err) {
      toast({ title: 'Failed', description: err.message, variant: 'destructive' })
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [strategy, toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const runDedupeAll = async ({ dryRun }) => {
    try {
      setLoading(true)
      const res = await post('/api/admin/profiles/deduplicate', {
        strategy,
        dryRun: Boolean(dryRun),
        // Be generous: users asked to delete duplicates globally.
        limitGroups: 2000,
        minGroupSize: 2,
      })
      setOutput(res)
      if (dryRun) {
        toast({ title: 'Preview ready', description: `Prepared ${res?.merged_groups ?? 0} group(s)` })
      } else {
        toast({ title: 'Done', description: `Merged ${res?.merged_groups ?? 0} group(s)` })
        await refresh()
      }
    } catch (err) {
      const requestId = err?.requestId || err?.details?.request_id || null
      toast({
        title: 'Bulk merge failed',
        description: requestId ? `${err.message} (request_id=${requestId})` : err.message,
        variant: 'destructive',
      })
      setOutput({ ok: false, error: err.message, request_id: requestId })
    } finally {
      setLoading(false)
    }
  }

  const runMerge = async ({ winnerId, loserIds, dryRun }) => {
    try {
      setLoading(true)
      const res = await post('/api/admin/profiles/merge', { winnerId, loserIds, dryRun })
      setOutput(res)
      if (dryRun) {
        toast({ title: 'Preview ready', description: 'Dry-run completed' })
      } else {
        toast({ title: 'Merged', description: 'Profiles merged successfully' })
        await refresh()
      }
    } catch (err) {
      const requestId = err?.requestId || err?.details?.request_id || null
      toast({
        title: 'Merge failed',
        description: requestId ? `${err.message} (request_id=${requestId})` : err.message,
        variant: 'destructive',
      })

      const base = { ok: false, error: err.message, request_id: requestId }
      setOutput(base)

      // Best-effort: fetch server-side error details (in-memory store) for quicker debugging.
      if (requestId) {
        try {
          const details = await apiFetch(`/api/admin/errors/${encodeURIComponent(requestId)}`)
          setOutput({ ...base, server_error: details })
        } catch (lookupErr) {
          setOutput({
            ...base,
            server_error_lookup_failed: lookupErr?.message || String(lookupErr),
          })
        }
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border border-slate-200 bg-white/70 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-slate-900">
            <Users className="w-5 h-5 text-blue-600" />
            Profile de-duplication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              This tool merges duplicate profiles by moving linked data (sections, documents, crawler history, Anya state) into a single “winner” profile and deleting the duplicates.
              Use <strong>Similar names</strong> to combine profiles like “Lina” with “Lina S. Moreno”.
              The bulk merge button keeps the profile owned by the real (non-admin) user whose email matches the profile email when possible.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={strategy === 'similar_name' ? 'default' : 'outline'}
              onClick={() => setStrategy('similar_name')}
              disabled={loading}
            >
              Similar names
            </Button>
            <Button
              variant={strategy === 'exact_name' ? 'default' : 'outline'}
              onClick={() => setStrategy('exact_name')}
              disabled={loading}
            >
              Exact name
            </Button>
            <Button
              variant={strategy === 'email_or_phone' ? 'default' : 'outline'}
              onClick={() => setStrategy('email_or_phone')}
              disabled={loading}
            >
              Email/phone
            </Button>

            <Button variant="outline" onClick={refresh} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>

            <Button
              variant="destructive"
              onClick={() => {
                const ok = window.confirm(
                  `Merge & delete ALL duplicates for strategy "${strategy}"?\n\n` +
                    `This will pick the best winner per group and delete the rest.`,
                )
                if (!ok) return
                runDedupeAll({ dryRun: false })
              }}
              disabled={loading}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Merge & delete ALL duplicates
            </Button>

            <div className="ml-auto text-sm text-slate-600">
              Groups: <span className="font-medium text-slate-900">{summary.totalGroups}</span> · Profiles:{' '}
              <span className="font-medium text-slate-900">{summary.totalProfiles}</span>
            </div>
          </div>

          {groups?.length ? (
            <div className="space-y-3">
              {groups.map((g) => {
                const winner = g?.winner
                const losers = g?.losers || []
                return (
                  <div key={g.key} className="rounded-md border border-slate-200 bg-white">
                    <div className="p-3 flex flex-col md:flex-row md:items-center gap-2">
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-slate-900">
                          {g.key} <span className="text-slate-500 font-normal">({g.count})</span>
                        </div>
                        <div className="text-xs text-slate-600">
                          Winner: <span className="font-medium">{winner?.display_name}</span> · sections {winner?.section_count ?? 0} · fields {winner?.non_empty_fields ?? 0}
                        </div>
                        <div className="text-xs text-slate-500">
                          Losers: {losers.map((l) => l.display_name).join(', ')}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => runMerge({ winnerId: winner.id, loserIds: losers.map((l) => l.id), dryRun: true })}
                          disabled={loading || !winner?.id || losers.length === 0}
                        >
                          Preview
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() => {
                            const ok = window.confirm(
                              `Merge ${losers.length} profile(s) into "${winner.display_name}"?\n\nThis will delete the duplicates after moving their data.`,
                            )
                            if (!ok) return
                            runMerge({ winnerId: winner.id, loserIds: losers.map((l) => l.id), dryRun: false })
                          }}
                          disabled={loading || !winner?.id || losers.length === 0}
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Merge & delete duplicates
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-sm text-slate-600">No duplicate groups found for the selected strategy.</div>
          )}

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
