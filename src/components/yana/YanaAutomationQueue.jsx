import React, { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sparkles, Loader2, RefreshCw } from 'lucide-react'
import client from '@/api/client'
import { statusLabel } from '@/api/yana'
import YanaTaskDrawer from './YanaTaskDrawer'

/**
 * YanaAutomationQueue
 *
 * Renders a compact list of the active Yana automation tasks for one
 * profile. Each row shows: title, automation_type badge, status, and a
 * View button that opens the YanaTaskDrawer.
 *
 * Polls /api/yana/automation/tasks every 15s while mounted so the queue
 * reflects orchestrator progress without manual refresh.
 */
export default function YanaAutomationQueue({ profileId }) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(false)
  const [openTask, setOpenTask] = useState(null)

  const load = useCallback(async () => {
    if (!profileId) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ profile_id: String(profileId) })
      const res = await client.get(`/api/yana/automation/tasks?${params.toString()}`)
      setTasks(Array.isArray(res?.tasks) ? res.tasks : [])
    } catch {
      // Network errors shouldn't tear the panel down — leave the prior list visible.
    } finally {
      setLoading(false)
    }
  }, [profileId])

  useEffect(() => {
    if (!profileId) return
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [profileId, load])

  if (!profileId) return null

  return (
    <Card className="border-indigo-100">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-indigo-600" />
          Yana automation queue
          <Badge variant="outline" className="ml-1 text-[10px]">{tasks.length}</Badge>
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={load} title="Refresh">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </Button>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <div className="text-xs text-slate-500">
            Nothing here yet. Select funding sources from the pipeline and click <span className="font-semibold">Automate selected with Yana</span>.
          </div>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800 truncate">
                    {t.opportunity_id ? `opportunity ${String(t.opportunity_id).slice(0, 8)}…`
                      : t.grant_id ? `grant ${String(t.grant_id).slice(0, 8)}…`
                      : 'task'}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                    <Badge variant="outline" className="text-[10px]">{statusLabel(t.status)}</Badge>
                    {t.automation_type && t.automation_type !== 'unknown' && (
                      <Badge variant="outline" className="text-[10px] bg-indigo-50 text-indigo-700 border-indigo-200">{t.automation_type.replace('_', ' ')}</Badge>
                    )}
                    {t.selected_from_stage && (
                      <span>· from {t.selected_from_stage}</span>
                    )}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => setOpenTask(t)}>
                  View
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {openTask && (
        <YanaTaskDrawer
          open={!!openTask}
          task={openTask}
          onClose={() => setOpenTask(null)}
          onTaskUpdated={(updated) => {
            setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
          }}
        />
      )}
    </Card>
  )
}
