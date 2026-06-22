import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Wrench, Power } from 'lucide-react'
import { getMaintenanceStatus, scheduleMaintenance, endMaintenance, runNightlySweep } from '@/api/maintenance'

/**
 * Owner control for the maintenance window: warn signed-in users (toast/banner
 * + grace), then take the app down so nobody is on a half-deployed build, and
 * reopen when CI is green. Also exposes a manual run of Sam's nightly sweep.
 */
export default function AdminMaintenanceWindow() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [grace, setGrace] = useState(5)
  const [estimated, setEstimated] = useState(15)
  const [message, setMessage] = useState('')

  const statusQuery = useQuery({
    queryKey: ['maintenance-status'],
    queryFn: getMaintenanceStatus,
    refetchInterval: 10_000,
  })
  const status = statusQuery.data

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['maintenance-status'] })

  const scheduleMut = useMutation({
    mutationFn: () => scheduleMaintenance({ graceMinutes: Number(grace) || 0, estimatedMinutes: Number(estimated) || 15, reason: 'deploy', message: message || null }),
    onSuccess: () => { toast({ title: 'Maintenance scheduled', description: `Users warned; going down in ${grace} min.` }); invalidate() },
    onError: (e) => toast({ variant: 'destructive', title: 'Could not schedule', description: e?.message }),
  })
  const endMut = useMutation({
    mutationFn: endMaintenance,
    onSuccess: () => { toast({ title: 'App reopened', description: 'Users can sign back in.' }); invalidate() },
    onError: (e) => toast({ variant: 'destructive', title: 'Could not reopen', description: e?.message }),
  })
  const sweepMut = useMutation({
    mutationFn: runNightlySweep,
    onSuccess: (r) => { toast({ title: 'Nightly sweep run', description: r?.green ? `Green — reopened (${r.applied_fixes} fixes).` : `Not green (${r.criticals} critical) — left in maintenance.` }); invalidate() },
    onError: (e) => toast({ variant: 'destructive', title: 'Sweep failed', description: e?.message }),
  })

  const phase = status?.phase || 'open'
  const busy = scheduleMut.isPending || endMut.isPending || sweepMut.isPending

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Wrench className="w-5 h-5 text-amber-600" /> Maintenance window
          {phase === 'down' ? <Badge className="bg-red-600 text-white">DOWN</Badge>
            : phase === 'warning' ? <Badge className="bg-amber-500 text-white">WARNING</Badge>
            : <Badge className="bg-emerald-600 text-white">OPEN</Badge>}
        </CardTitle>
        <CardDescription>
          Warn signed-in users (banner + countdown), then take the app down so nobody is on a glitching build
          while you deploy. Reopen when CI is green. Sam's nightly sweep runs automatically at 04:00 ET.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {phase !== 'open' ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {status?.message}
            {status?.estimated_end_at ? <div className="text-xs mt-1">Estimated back by {new Date(status.estimated_end_at).toLocaleTimeString()}.</div> : null}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Grace (minutes)</label>
            <Input type="number" min={0} value={grace} onChange={(e) => setGrace(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Estimated downtime (minutes)</label>
            <Input type="number" min={1} value={estimated} onChange={(e) => setEstimated(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Message (optional)</label>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What users see — defaults to a friendly maintenance notice." className="min-h-[60px]" />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => scheduleMut.mutate()} disabled={busy} className="gap-2">
            {scheduleMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
            Schedule maintenance
          </Button>
          <Button variant="outline" onClick={() => endMut.mutate()} disabled={busy || phase === 'open'} className="gap-2">
            <Power className="w-4 h-4" /> Reopen app
          </Button>
          <Button variant="ghost" onClick={() => sweepMut.mutate()} disabled={busy} className="gap-2 text-slate-600">
            Run Sam nightly sweep now
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
