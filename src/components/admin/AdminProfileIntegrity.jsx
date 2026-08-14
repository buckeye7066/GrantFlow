import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, RefreshCw, Wrench } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch } from '@/api/client'

async function post(path, body) {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

export default function AdminProfileIntegrity() {
  const { toast } = useToast()

  const [loading, setLoading] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [report, setReport] = useState(null)
  const [repairOutput, setRepairOutput] = useState(null)

  const [actions, setActions] = useState({
    reattach_unowned_by_email: true,
    fix_dangling_user_links_by_email: true,
    cleanup_orphan_profiles: false,
  })

  const [options, setOptions] = useState({
    include_deleted_profiles: false,
    allow_attach_to_admin: false,
    tombstone_orphans: true,
  })

  const summary = useMemo(() => {
    const totals = report?.totals || {}
    const profiles = report?.profiles || {}
    const orphans = report?.orphans || {}
    const duplicates = report?.duplicates || {}
    return {
      totalsProfiles: totals.profiles ?? 0,
      totalsUsers: totals.users ?? 0,
      totalsOrgs: totals.organizations ?? 0,
      unowned: profiles.unowned ?? 0,
      danglingUsers: profiles.dangling_user_links ?? 0,
      danglingOrgs: profiles.dangling_org_links ?? 0,
      orphanSampled: orphans.sampled ?? 0,
      duplicateGroups: Array.isArray(duplicates.groups) ? duplicates.groups.length : 0,
    }
  }, [report])

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      setRepairOutput(null)
      const res = await apiFetch('/api/admin/profiles/integrity')
      setReport(res)
      toast({ title: 'Loaded', description: 'Profile integrity report refreshed' })
    } catch (err) {
      toast({ title: 'Failed', description: err.message, variant: 'destructive' })
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const runRepair = async ({ dryRun }) => {
    try {
      setRepairing(true)
      setRepairOutput(null)
      const payload = {
        dry_run: dryRun === true,
        actions,
        options: {
          ...options,
          reason: 'admin_ui_integrity_repair',
        },
      }
      const res = await post('/api/admin/profiles/integrity/repair', payload)
      setRepairOutput(res)

      const planned = res?.reattach?.planned ?? res?.planned ?? res?.results?.planned ?? 0
      const applied = res?.reattach?.applied ?? res?.applied ?? res?.results?.applied ?? 0
      if (dryRun !== false) {
        toast({ title: 'Dry-run ready', description: `Planned ${planned} change(s)` })
      } else {
        toast({ title: 'Applied', description: `Applied ${applied} change(s)` })
        await refresh()
      }
    } catch (err) {
      toast({ title: 'Repair failed', description: err.message, variant: 'destructive' })
      setRepairOutput({ ok: false, error: err.message })
    } finally {
      setRepairing(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border border-border bg-card/80 text-card-foreground backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Wrench className="w-5 h-5 text-primary" />
            Profile integrity (report + repair)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              This panel shows the backend integrity report and lets you run a <span className="font-medium">dry-run</span> repair. Apply only after reviewing the output.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={refresh} disabled={loading || repairing}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh report
            </Button>

            <Button
              variant="outline"
              onClick={() => runRepair({ dryRun: true })}
              disabled={loading || repairing}
            >
              {repairing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Wrench className="w-4 h-4 mr-2" />}
              Dry-run repair
            </Button>

            <Button
              variant="destructive"
              onClick={() => {
                const ok = window.confirm(
                  'Apply integrity repair now?\n\nThis will update profile.user_id for matches and may delete orphaned deleted profiles if enabled.',
                )
                if (!ok) return
                runRepair({ dryRun: false })
              }}
              disabled={loading || repairing}
            >
              Apply repair
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-md border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">Totals</div>
              <div className="text-sm text-foreground mt-1">
                Profiles: <span className="font-semibold">{summary.totalsProfiles}</span> · Users:{' '}
                <span className="font-semibold">{summary.totalsUsers}</span> · Orgs:{' '}
                <span className="font-semibold">{summary.totalsOrgs}</span>
              </div>
            </div>
            <div className="rounded-md border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">Signals</div>
              <div className="text-sm text-foreground mt-1">
                Unowned: <span className="font-semibold">{summary.unowned}</span> · Dangling users:{' '}
                <span className="font-semibold">{summary.danglingUsers}</span> · Dangling orgs:{' '}
                <span className="font-semibold">{summary.danglingOrgs}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-md border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">Orphans (sample)</div>
              <div className="text-sm text-foreground mt-1">
                Hard-deletable candidates sampled: <span className="font-semibold">{summary.orphanSampled}</span>
              </div>
            </div>
            <div className="rounded-md border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">Duplicates (sample)</div>
              <div className="text-sm text-foreground mt-1">
                Duplicate groups sampled: <span className="font-semibold">{summary.duplicateGroups}</span>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border bg-background/60 p-3 space-y-2">
            <div className="text-sm font-semibold text-foreground">Repair configuration</div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={actions.reattach_unowned_by_email}
                  onChange={(e) => setActions((s) => ({ ...s, reattach_unowned_by_email: e.target.checked }))}
                />
                Reattach unowned profiles by email
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={actions.fix_dangling_user_links_by_email}
                  onChange={(e) => setActions((s) => ({ ...s, fix_dangling_user_links_by_email: e.target.checked }))}
                />
                Fix dangling user_id links by email
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={actions.cleanup_orphan_profiles}
                  onChange={(e) => setActions((s) => ({ ...s, cleanup_orphan_profiles: e.target.checked }))}
                />
                Cleanup orphan deleted profiles (hard-delete)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={options.tombstone_orphans}
                  onChange={(e) => setOptions((s) => ({ ...s, tombstone_orphans: e.target.checked }))}
                  disabled={!actions.cleanup_orphan_profiles}
                />
                Tombstone orphan deletes (prevent re-seed)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={options.include_deleted_profiles}
                  onChange={(e) => setOptions((s) => ({ ...s, include_deleted_profiles: e.target.checked }))}
                />
                Include deleted profiles in ownership repair scan
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={options.allow_attach_to_admin}
                  onChange={(e) => setOptions((s) => ({ ...s, allow_attach_to_admin: e.target.checked }))}
                />
                Allow attaching to admin (usually false)
              </label>
            </div>
          </div>

          {repairOutput ? (
            <pre className="text-xs bg-muted text-foreground rounded-md p-3 overflow-auto max-h-96 border border-border">
              {JSON.stringify(repairOutput, null, 2)}
            </pre>
          ) : report ? (
            <pre className="text-xs bg-muted text-foreground rounded-md p-3 overflow-auto max-h-96 border border-border">
              {JSON.stringify(report, null, 2)}
            </pre>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

