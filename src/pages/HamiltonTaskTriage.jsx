/**
 * HamiltonTaskTriage — a usable way to work through Hamilton's tasks.
 *
 * Owner 2026-08-22: the flat 200-row table is unworkable. This groups tasks by
 * WHAT HAPPENED (via the shared categorizer) and lets the owner act on a whole
 * class or a hand-picked set at once: Acknowledge (mark reviewed → done),
 * Delete (cancel), or Finish with AI (re-run, now with the LLM field layer).
 * Uses the app's authenticated client, so no console.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import client from '@/api/client'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { showInfoToast, showErrorToast } from '@/components/shared/toastHelpers'
import { Loader2, RefreshCw, CheckCircle2, Trash2, Sparkles, ChevronDown, ChevronRight, Archive } from 'lucide-react'
import { categorizeHamiltonTask, HAMILTON_TASK_CATEGORIES } from '../../shared/hamiltonTaskCategory.js'

const ORDER = HAMILTON_TASK_CATEGORIES.map((c) => c.key)
// Finished/terminal statuses live on the ARCHIVE tab; everything else is ACTIVE.
const ARCHIVED_STATUSES = new Set(['submitted', 'completed', 'completed_draft', 'failed', 'cancelled'])
const isArchived = (t) => ARCHIVED_STATUSES.has(String(t?.status || '').toLowerCase())

export default function HamiltonTaskTriage() {
  const [params] = useSearchParams()
  const profileId = params.get('profile') || ''
  const { toast } = useToast()

  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [view, setView] = useState('active') // 'active' | 'archived'

  const load = useCallback(async () => {
    if (!profileId) return
    setLoading(true)
    try {
      const res = await client.get(`/api/hamilton/automation/tasks?profile=${encodeURIComponent(profileId)}`)
      const list = Array.isArray(res?.data) ? res.data : (res?.data?.tasks || res?.data?.items || [])
      setTasks(list)
      setSelected(new Set())
    } catch (err) {
      showErrorToast(toast, 'Could not load tasks', err?.message || 'See logs.')
    } finally {
      setLoading(false)
    }
  }, [profileId, toast])

  useEffect(() => { load() }, [load])

  const counts = useMemo(() => {
    let active = 0; let archived = 0
    for (const t of tasks) (isArchived(t) ? archived++ : active++, 0)
    return { active, archived }
  }, [tasks])

  const groups = useMemo(() => {
    const byKey = new Map()
    for (const t of tasks) {
      if (view === 'archived' ? !isArchived(t) : isArchived(t)) continue
      const cat = categorizeHamiltonTask(t)
      if (!byKey.has(cat.key)) byKey.set(cat.key, { ...cat, tasks: [] })
      byKey.get(cat.key).tasks.push(t)
    }
    return [...byKey.values()].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key))
  }, [tasks, view])

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const toggleGroup = (g) => setSelected((prev) => {
    const next = new Set(prev)
    const ids = g.tasks.map((t) => t.id)
    const allSel = ids.every((id) => next.has(id))
    for (const id of ids) { if (allSel) next.delete(id); else next.add(id) }
    return next
  })
  const toggleCollapse = (key) => setCollapsed((prev) => {
    const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next
  })

  const runAction = useCallback(async (action, { taskIds = null, category = null } = {}) => {
    const verb = action === 'acknowledge' ? 'Acknowledge'
      : action === 'delete' ? 'Delete'
      : action === 'purge' ? 'Delete permanently'
      : 'Finish with AI'
    const n = taskIds ? taskIds.length : (groups.find((g) => g.key === category)?.tasks.length || 0)
    if (!n) return
    if (action === 'delete' && !window.confirm(`Delete (cancel) ${n} task${n === 1 ? '' : 's'}? This tombstones them.`)) return
    if (action === 'purge' && !window.confirm(`Permanently delete ${n} finished task${n === 1 ? '' : 's'} from the archive? This cannot be undone.`)) return
    setBusy(`${action}:${category || 'selected'}`)
    try {
      const body = { action, ...(taskIds ? { taskIds } : { profileId, category }) }
      const res = await client.post('/api/hamilton/automation/admin/tasks/bulk', body)
      const r = res?.data || {}
      showInfoToast(toast, `${verb} — done`, `${r.done ?? 0} actioned${r.queued ? `, ${r.queued} re-running` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}${r.retry_capped ? ' (re-run capped at 25 — run again for more)' : ''}.`)
      await load()
    } catch (err) {
      showErrorToast(toast, `Could not ${verb.toLowerCase()}`, err?.response?.data?.message || err?.message || 'See logs.')
    } finally {
      setBusy(null)
    }
  }, [groups, profileId, toast, load])

  if (!profileId) {
    return <div className="p-8 text-slate-600">Open this from a profile (add <code>?profile=&lt;id&gt;</code>).</div>
  }

  const selectedIds = [...selected]

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-slate-900">Hamilton task triage <span className="text-sm font-normal text-slate-500">· {tasks.length} tasks</span></h1>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Refresh
          </Button>
        </div>

        {/* Sticky bulk bar for the hand-picked selection */}
        {selectedIds.length > 0 && (
          <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-slate-300 bg-white p-2 shadow">
            <span className="px-2 text-sm font-medium text-slate-700">{selectedIds.length} selected</span>
            <Button size="sm" variant="outline" className="text-emerald-700 border-emerald-200" disabled={!!busy} onClick={() => runAction('acknowledge', { taskIds: selectedIds })}><CheckCircle2 className="mr-1 h-3.5 w-3.5" />Acknowledge</Button>
            <Button size="sm" variant="outline" className="text-indigo-700 border-indigo-200" disabled={!!busy} onClick={() => runAction('retry', { taskIds: selectedIds })}><Sparkles className="mr-1 h-3.5 w-3.5" />Finish with AI</Button>
            <Button size="sm" variant="outline" className="text-rose-700 border-rose-200" disabled={!!busy} onClick={() => runAction('delete', { taskIds: selectedIds })}><Trash2 className="mr-1 h-3.5 w-3.5" />Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          const ids = g.tasks.map((t) => t.id)
          const allSel = ids.length > 0 && ids.every((id) => selected.has(id))
          return (
            <div key={g.key} className="rounded-lg border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
                <button onClick={() => toggleCollapse(g.key)} className="text-slate-400 hover:text-slate-700" aria-label="expand">
                  {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                <input type="checkbox" checked={allSel} onChange={() => toggleGroup(g)} className="h-4 w-4" aria-label={`select all ${g.label}`} />
                <span className="font-medium text-slate-900">{g.label}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{g.tasks.length}</span>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" className="text-emerald-700" disabled={!!busy} onClick={() => runAction('acknowledge', { category: g.key })} title="Acknowledge all in this group">
                    {busy === `acknowledge:${g.key}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-indigo-700" disabled={!!busy} onClick={() => runAction('retry', { category: g.key })} title="Finish all in this group with AI">
                    {busy === `retry:${g.key}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-rose-700" disabled={!!busy} onClick={() => runAction('delete', { category: g.key })} title="Delete all in this group">
                    {busy === `delete:${g.key}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </span>
              </div>
              {!isCollapsed && (
                <>
                  <p className="px-3 pt-2 text-xs text-slate-500">{g.hint}</p>
                  <ul className="divide-y divide-slate-50 p-2">
                    {g.tasks.slice(0, 100).map((t) => (
                      <li key={t.id} className="flex items-start gap-2 rounded p-1.5 hover:bg-slate-50">
                        <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} className="mt-0.5 h-4 w-4" />
                        <div className="min-w-0">
                          <div className="truncate text-sm text-slate-800">{t.display_title || t.funder_name || t.title || t.id}</div>
                          {t.last_agent_message && <div className="truncate text-xs text-slate-400">{t.last_agent_message}</div>}
                        </div>
                      </li>
                    ))}
                    {g.tasks.length > 100 && <li className="px-2 py-1 text-xs text-slate-400">…and {g.tasks.length - 100} more — use the group action above to act on all.</li>}
                  </ul>
                </>
              )}
            </div>
          )
        })}
        {!loading && groups.length === 0 && <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-500">No tasks for this profile.</div>}
      </div>
    </div>
  )
}
