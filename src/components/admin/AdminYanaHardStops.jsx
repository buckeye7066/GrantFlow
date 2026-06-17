/**
 * AdminYanaHardStops
 *
 * Admin dashboard view of every open Yana hard stop. One row per
 * unresolved blocker. Surfaces the profile, funding source, blocker
 * type, deadline, who needs to act, and inline resume / cancel /
 * escalate controls.
 */

import React, { useEffect, useState, useCallback } from 'react'
import client from '@/api/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showInfoToast, showErrorToast } from '@/components/shared/toastHelpers'

const ACTION_LABEL = {
  provide_info: 'Provide info',
  upload_document: 'Upload doc',
  renew_session: 'Renew session',
  approve_payment: 'Approve payment',
  review_attestation: 'Review attestation',
  admin_review: 'Admin review',
  resume: 'Resume',
  review: 'Review',
  find_alternate: 'Find alternate',
  cancel: 'Cancel',
}

function severityClass(s) {
  switch (s) {
    case 'error':   return 'bg-rose-50 text-rose-800 border-rose-200'
    case 'warning': return 'bg-amber-50 text-amber-900 border-amber-200'
    case 'success': return 'bg-emerald-50 text-emerald-800 border-emerald-200'
    default:        return 'bg-slate-50 text-slate-800 border-slate-200'
  }
}

export default function AdminYanaHardStops() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(null)
  const [blockers, setBlockers] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await client.get('/api/yana/automation/admin/hard-stops')
      setBlockers(Array.isArray(res?.blockers) ? res.blockers : [])
    } catch (err) {
      showErrorToast(toast, 'Could not load Yana hard stops', err?.message || 'See logs.')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  async function resume(b) {
    setBusy(b.id)
    try {
      await client.post(`/api/yana/automation/tasks/${b.task_id}/resolve-blocker`, {
        note: `Admin resolved ${b.blocker_type} from dashboard.`,
      })
      showInfoToast(toast, 'Yana resumed', 'The blocker was marked resolved and Yana is running again.')
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not resume Yana', err?.message || 'See logs.')
    } finally {
      setBusy(null)
    }
  }

  async function cancel(b) {
    if (!window.confirm('Cancel this Yana task? She will stop and the alert will be cleared.')) return
    setBusy(b.id)
    try {
      await client.post(`/api/yana/automation/tasks/${b.task_id}/cancel`, { reason: 'admin_cancelled_from_dashboard' })
      showInfoToast(toast, 'Task cancelled', 'Yana stopped and the alert was cleared.')
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not cancel', err?.message || 'See logs.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
          Yana hard stops
          <Badge variant="outline" className="ml-2">{blockers.length} open</Badge>
        </h2>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
          Refresh
        </Button>
      </div>

      {!loading && blockers.length === 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> No open Yana hard stops. Everything is running clean.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Profile</th>
              <th className="text-left px-3 py-2">Funding source</th>
              <th className="text-left px-3 py-2">Blocker</th>
              <th className="text-left px-3 py-2">Who acts</th>
              <th className="text-left px-3 py-2">Deadline</th>
              <th className="text-left px-3 py-2">Detected</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {blockers.map((b) => (
              <tr key={b.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono text-[11px] text-slate-700">{(b.profile_id || '').slice(0, 8)}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-slate-700">{(b.funding_source_id || '—').slice(0, 8)}</td>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{b.blocker_title || b.blocker_type}</div>
                  <div className="text-xs text-slate-500">{b.blocker_message || ''}</div>
                  <span className={`mt-1 inline-block text-[10px] px-2 py-0.5 rounded border ${severityClass(b.severity)}`}>
                    {b.blocker_type.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-700">
                  {b.user_required && <div>User</div>}
                  {b.admin_required && <div className="text-amber-800 font-medium">Admin</div>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-700">
                  {b.deadline_at ? new Date(b.deadline_at).toLocaleDateString() : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {b.detected_at ? new Date(b.detected_at).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white mr-1" onClick={() => resume(b)} disabled={busy === b.id}>
                    {busy === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : (ACTION_LABEL[b.required_action] || 'Resolve')}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-rose-700 hover:bg-rose-50" onClick={() => cancel(b)} disabled={busy === b.id}>
                    <X className="w-3 h-3" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
