/**
 * AdminHamiltonHardStops
 *
 * Admin dashboard view of every open Hamilton hard stop. One row per
 * unresolved blocker. Surfaces the profile, funding source, blocker
 * type, deadline, who needs to act, and inline resume / cancel /
 * escalate controls.
 */

import React, { useEffect, useState, useCallback } from 'react'
import client from '@/api/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, X, Trash2, Unlock } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showInfoToast, showErrorToast } from '@/components/shared/toastHelpers'
import HamiltonInlineHardStopFix from '@/components/hamilton/HamiltonInlineHardStopFix'

const ACTION_LABEL = {
  provide_info: 'Provide info',
  upload_document: 'Upload doc',
  renew_session: 'Renew session',
  review_flagged_source: 'Review source',
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

const TASK_FILTERS = [
  { id: 'blocked',   label: 'Pending hard stops' },
  { id: 'active',    label: 'Active' },
  { id: 'failed',    label: 'Failed' },
  { id: 'completed', label: 'Completed' },
]

export default function AdminHamiltonHardStops() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(null)
  const [blockers, setBlockers] = useState([])
  const [adminEmail, setAdminEmail] = useState(null)
  const [tasksByFilter, setTasksByFilter] = useState({
    blocked: [], active: [], failed: [], completed: [],
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [hardStops, ...taskResults] = await Promise.all([
        client.get('/api/hamilton/automation/admin/hard-stops'),
        ...TASK_FILTERS.map((f) => client.get(`/api/hamilton/automation/admin/tasks?status=${f.id}&limit=50`)),
      ])
      setBlockers(Array.isArray(hardStops?.blockers) ? hardStops.blockers : [])
      setAdminEmail(hardStops?.admin_email || null)
      const next = { blocked: [], active: [], failed: [], completed: [] }
      taskResults.forEach((res, i) => { next[TASK_FILTERS[i].id] = Array.isArray(res?.tasks) ? res.tasks : [] })
      setTasksByFilter(next)
    } catch (err) {
      showErrorToast(toast, 'Could not load Hamilton admin dashboard', err?.message || 'See logs.')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  // Inline fixer already saved the field + cleared the stop server-side; drop the
  // row and refresh the task columns so a resumed task moves to "active".
  const handleInlineResolved = useCallback((blocker) => {
    setBlockers((prev) => prev.filter((x) => x.id !== blocker.id))
    load()
  }, [load])

  async function resume(b) {
    setBusy(b.id)
    try {
      await client.post(`/api/hamilton/automation/tasks/${b.task_id}/resolve-blocker`, {
        note: `Admin resolved ${b.blocker_type} from dashboard.`,
      })
      showInfoToast(toast, 'Hamilton resumed', 'The blocker was marked resolved and Hamilton is running again.')
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not resume Hamilton', err?.message || 'See logs.')
    } finally {
      setBusy(null)
    }
  }

  async function cancel(b) {
    if (!window.confirm('Cancel this Hamilton task? She will stop and the alert will be cleared.')) return
    setBusy(b.id)
    try {
      await client.post(`/api/hamilton/automation/tasks/${b.task_id}/cancel`, { reason: 'admin_cancelled_from_dashboard' })
      showInfoToast(toast, 'Task cancelled', 'Hamilton stopped and the alert was cleared.')
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not cancel', err?.message || 'See logs.')
    } finally {
      setBusy(null)
    }
  }

  // Bulk-clear every open hard stop. Soft-dismisses them server-side (audit
  // row kept) and clears their notifications. Does not resume Hamilton.
  async function dismissAll() {
    if (blockers.length === 0) return
    if (!window.confirm(`Dismiss all ${blockers.length} open hard stop${blockers.length === 1 ? '' : 's'}? They will be cleared from the list. This does not resume Hamilton.`)) return
    setBusy('__all__')
    try {
      const res = await client.post('/api/hamilton/automation/admin/hard-stops/dismiss-all', {})
      showInfoToast(toast, 'Hard stops cleared', `${res?.dismissed ?? 0} hard stop${(res?.dismissed ?? 0) === 1 ? '' : 's'} dismissed.`)
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not clear hard stops', err?.message || 'See logs.')
    } finally {
      setBusy(null)
    }
  }

  // Release stuck "need you" portals so the next full-automation run revisits
  // them — clears the retry backoff on the backlog that stopped before the
  // block-removal fixes deployed. Uses the app's authenticated client (Bearer
  // token), so it works where a raw console fetch 401s. Never submits.
  async function releaseNeedYou() {
    if (!window.confirm('Revisit every "needs you" card across all profiles and clear the block on any that is NOT one of the four legitimate hand-offs (physical-copy packet, genuinely-missing info, an unbeatable bot wall, or an existing external login). Cleared cards are revisited by the next full-automation run; ineligible sources are REMOVED to the Archived tab; any maybe-already-submitted card is left blocked. This never submits by itself.')) return
    setBusy('__release__')
    try {
      const res = await client.post('/api/hamilton/automation/admin/release-need-you', { allProfiles: true })
      const kept = Object.entries(res?.kept_by_category || {}).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')
      showInfoToast(
        toast,
        'Cards revisited',
        `${res?.released ?? 0} block${(res?.released ?? 0) === 1 ? '' : 's'} cleared, ${res?.removed ?? 0} ineligible removed to the archive, across ${res?.profiles_affected ?? 0} profile(s); ${res?.kept ?? 0} kept legitimate${kept ? ` (${kept})` : ''}. Start a full-automation run to submit the cleared ones.`,
      )
      await load()
    } catch (err) {
      showErrorToast(toast, 'Could not revisit cards', err?.message || 'See logs.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
          Hamilton operator dashboard
          <Badge variant="outline" className="ml-2">{blockers.length} open</Badge>
          {adminEmail && (
            <span className="ml-2 text-xs font-normal text-slate-500">routed to <strong>{adminEmail}</strong></span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={releaseNeedYou}
            disabled={busy === '__release__' || loading}
            className="text-emerald-700 border-emerald-200 hover:bg-emerald-50"
            title="Clear the retry backoff on stuck 'need you' portals so the next run revisits them"
          >
            {busy === '__release__' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Unlock className="w-3 h-3 mr-1" />}
            Release stuck portals
          </Button>
          {blockers.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={dismissAll}
              disabled={busy === '__all__' || loading}
              className="text-rose-700 border-rose-200 hover:bg-rose-50"
            >
              {busy === '__all__' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />}
              Delete all ({blockers.length})
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Refresh
          </Button>
        </div>
      </div>

      {/* Status overview cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {TASK_FILTERS.map((f) => (
          <div key={f.id} className="border border-slate-200 rounded-lg p-3 bg-white">
            <div className="text-xs uppercase text-slate-500">{f.label}</div>
            <div className="text-2xl font-semibold text-slate-900">
              {f.id === 'blocked' ? blockers.length : (tasksByFilter[f.id]?.length || 0)}
            </div>
          </div>
        ))}
      </div>

      {!loading && blockers.length === 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> No open Hamilton hard stops. Everything is running clean.
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
                <td className="px-3 py-2 max-w-sm">
                  <div className="font-medium text-slate-900">{b.blocker_title || b.blocker_type}</div>
                  <div className="text-xs text-slate-500">{b.blocker_message || ''}</div>
                  <span className={`mt-1 inline-block text-[10px] px-2 py-0.5 rounded border ${severityClass(b.severity)}`}>
                    {(b.blocker_type ?? '').replace(/_/g, ' ')}
                  </span>
                  {/* Inline fix: for a missing/ambiguous field, type the value here
                      and it's saved back to the profile + Hamilton resumes. */}
                  <HamiltonInlineHardStopFix blocker={b} onResolved={handleInlineResolved} />
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

      {/* Recent tasks across all states */}
      {(['active', 'failed', 'completed']).map((state) => {
        const tasks = tasksByFilter[state] || []
        if (!tasks.length) return null
        return (
          <div key={state} className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700 capitalize">{state} Hamilton tasks ({tasks.length})</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2">Task</th>
                    <th className="text-left px-3 py-2">Profile</th>
                    <th className="text-left px-3 py-2">Funding source</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">Last update</th>
                    <th className="text-left px-3 py-2">Last message</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-mono">{(t.id || '').slice(0, 8)}</td>
                      <td className="px-3 py-1.5 font-mono">{(t.profile_id || '').slice(0, 8)}</td>
                      <td className="px-3 py-1.5 font-mono">{(t.opportunity_id || t.grant_id || '—').slice(0, 8)}</td>
                      <td className="px-3 py-1.5">{t.status}</td>
                      <td className="px-3 py-1.5">{t.updated_at ? new Date(t.updated_at).toLocaleString() : '—'}</td>
                      <td className="px-3 py-1.5 text-slate-600">{t.last_agent_message || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}
