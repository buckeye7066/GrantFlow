/**
 * YanaTaskDrawer — full task review modal. Shows portal link, missing
 * info form, audit timeline, and the auto-submit toggle.
 */

import React, { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Sparkles, AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { showErrorToast, showInfoToast } from '@/components/shared/toastHelpers'
import * as yanaApi from '@/api/yana'

export default function YanaTaskDrawer({ open, onClose, task: initialTask, onTaskUpdated }) {
  const { toast } = useToast()
  const [task, setTask] = useState(initialTask || null)
  const [events, setEvents] = useState([])
  const [missingInfo, setMissingInfo] = useState([])
  const [values, setValues] = useState({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [browser, setBrowser] = useState(null)
  const [browserEnabled, setBrowserEnabled] = useState(false)
  const [autoSubmitGlobal, setAutoSubmitGlobal] = useState(false)

  useEffect(() => {
    setTask(initialTask || null)
    setValues({})
  }, [initialTask?.id])

  useEffect(() => {
    if (!open || !task?.id) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [detail, browserStatus] = await Promise.all([
          yanaApi.getApplicationTask(task.id),
          yanaApi.getBrowserStatus(task.id).catch(() => null),
        ])
        if (!cancelled) {
          setTask(detail?.task || task)
          setEvents(Array.isArray(detail?.events) ? detail.events : [])
          setMissingInfo(Array.isArray(detail?.missing_info) ? detail.missing_info.filter((m) => !m.resolved) : [])
          if (browserStatus?.ok) {
            setBrowser(browserStatus.session || null)
            setBrowserEnabled(Boolean(browserStatus.enabled))
            setAutoSubmitGlobal(Boolean(browserStatus.auto_submit_enabled_globally))
          }
        }
      } catch (err) {
        if (!cancelled) {
          showErrorToast(toast, 'Could not load task', err?.message || 'See logs.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [open, task?.id, toast])

  async function refreshBrowserStatus() {
    if (!task?.id) return
    try {
      const s = await yanaApi.getBrowserStatus(task.id)
      if (s?.ok) {
        setBrowser(s.session || null)
        setBrowserEnabled(Boolean(s.enabled))
        setAutoSubmitGlobal(Boolean(s.auto_submit_enabled_globally))
      }
    } catch { /* ignore */ }
  }

  async function callBrowser(label, fn) {
    if (!task?.id) return
    setBusy(true)
    try {
      const r = await fn(task.id)
      if (r?.session) setBrowser(r.session)
      showInfoToast(toast, label, r?.session?.status ? `Status: ${yanaApi.browserStatusLabel(r.session.status)}` : 'Done.')
      await refreshBrowserStatus()
    } catch (err) {
      showErrorToast(toast, `${label} failed`, err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function submitMissingInfo() {
    if (!task?.id) return
    const items = missingInfo
      .filter((m) => values[m.id] !== undefined && values[m.id] !== '')
      .map((m) => ({ kind: m.kind, key: m.key, value: values[m.id] }))
    if (items.length === 0) {
      showErrorToast(toast, 'Nothing to send', 'Fill in at least one item to update Yana.')
      return
    }
    setBusy(true)
    try {
      const result = await yanaApi.supplyMissingInfo(task.id, items)
      setMissingInfo(result?.remaining_missing_info || [])
      setTask(result?.task || task)
      onTaskUpdated?.(result?.task || task)
      showInfoToast(toast, 'Yana updated', `Resolved ${result?.resolved_count || 0} item(s). Click "Let Yana continue" to advance.`)
      setValues({})
    } catch (err) {
      showErrorToast(toast, 'Update failed', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function continueYana() {
    if (!task?.id) return
    setBusy(true)
    try {
      const result = await yanaApi.continueYana(task.id)
      setTask(result?.task || task)
      onTaskUpdated?.(result?.task || task)
      if (result?.adapter_result?.message) {
        showInfoToast(toast, 'Yana update', result.adapter_result.message)
      }
      // refetch events/missing
      const detail = await yanaApi.getApplicationTask(task.id)
      setEvents(detail?.events || [])
      setMissingInfo((detail?.missing_info || []).filter((m) => !m.resolved))
    } catch (err) {
      showErrorToast(toast, 'Yana could not continue', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  async function approveAutoSubmit(enable) {
    if (!task?.id) return
    setBusy(true)
    try {
      const result = await yanaApi.approveAutoSubmit(task.id, enable)
      setTask(result?.task || task)
      onTaskUpdated?.(result?.task || task)
      showInfoToast(toast, enable ? 'Auto-submit enabled' : 'Auto-submit disabled', 'Yana will respect this on the next continue.')
    } catch (err) {
      showErrorToast(toast, 'Update failed', err?.message || 'See logs.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose?.()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            Yana application task
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="py-6 flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading task…
          </div>
        )}

        {!loading && task && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{yanaApi.statusLabel(task.status)}</Badge>
              {task.application_id && (
                <Badge variant="outline" className="text-xs">apply-engine: {String(task.application_id).slice(0, 8)}…</Badge>
              )}
              <Badge variant="outline" className="text-xs">{task.assigned_agent}</Badge>
              {task.auto_submit_enabled && (
                <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
                  Auto-submit ON
                </Badge>
              )}
            </div>
            {task.last_agent_message && (
              <div className="text-sm bg-purple-50 border border-purple-200 rounded p-3">
                <span className="font-medium text-purple-900">Yana said:</span> {task.last_agent_message}
              </div>
            )}

            {missingInfo.length > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-amber-800">
                  <AlertTriangle className="w-4 h-4" />
                  <h4 className="text-sm font-semibold">Provide missing information</h4>
                </div>
                {missingInfo.map((m) => (
                  <div key={m.id} className="space-y-1">
                    <label className="text-xs font-medium text-slate-700 flex items-center gap-2">
                      {m.label || m.key}
                      <Badge variant="outline" className="text-[10px]">{m.kind}</Badge>
                    </label>
                    {m.description && <p className="text-xs text-slate-500">{m.description}</p>}
                    {m.kind === 'document' || m.kind === 'login' ? (
                      <Input
                        placeholder={m.kind === 'login' ? 'Confirmation that you logged in (e.g. yes)' : 'Document filename or note'}
                        value={values[m.id] ?? ''}
                        onChange={(e) => setValues((prev) => ({ ...prev, [m.id]: e.target.value }))}
                      />
                    ) : (
                      <Textarea
                        rows={2}
                        placeholder="Type the answer here…"
                        value={values[m.id] ?? ''}
                        onChange={(e) => setValues((prev) => ({ ...prev, [m.id]: e.target.value }))}
                      />
                    )}
                  </div>
                ))}
                <Button onClick={submitMissingInfo} disabled={busy} size="sm">
                  {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                  Send to Yana
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="w-4 h-4" />
                No missing information. Yana is ready to continue.
              </div>
            )}

            {/* Real browser automation panel */}
            {(browserEnabled || browser) && (
              <div className="space-y-2 border border-purple-200 rounded p-3 bg-purple-50/40">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-purple-600" />
                  <h4 className="text-sm font-semibold">Supervised browser automation</h4>
                  {browser?.status && (
                    <Badge variant="outline" className="text-[10px]">
                      {yanaApi.browserStatusLabel(browser.status)}
                    </Badge>
                  )}
                </div>
                {!browserEnabled && (
                  <p className="text-xs text-slate-500">
                    Set <code>YANA_ENABLE_BROWSER_AUTOMATION=true</code> on the server to enable.
                  </p>
                )}
                {browser?.current_url && (
                  <p className="text-xs text-slate-700">
                    Current page: <a href={browser.current_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">{browser.page_title || browser.current_url}</a>
                  </p>
                )}
                {Array.isArray(browser?.missing_fields) && browser.missing_fields.length > 0 && (
                  <div className="text-xs text-amber-800">
                    <strong>{browser.missing_fields.filter((m) => m.required).length}</strong> required fields are missing:{' '}
                    {browser.missing_fields.slice(0, 5).map((m) => m.label).join(', ')}
                    {browser.missing_fields.length > 5 ? ` +${browser.missing_fields.length - 5} more` : ''}
                  </div>
                )}
                {browser?.confirmation_reference && (
                  <div className="text-xs text-emerald-800">
                    Confirmation reference: <code>{browser.confirmation_reference}</code>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  {!browser && browserEnabled && (
                    <Button size="sm" onClick={() => callBrowser('Open with Yana', yanaApi.startBrowser)} disabled={busy}>
                      Open with Yana
                    </Button>
                  )}
                  {browser && browser.status !== 'submitted' && browser.status !== 'cancelled' && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => callBrowser("I'm logged in", yanaApi.userReadyContinue)} disabled={busy}>
                        I'm logged in — continue
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => callBrowser('Refill', yanaApi.fillBrowser)} disabled={busy}>
                        Re-fill known fields
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => callBrowser('Save draft', yanaApi.saveBrowserDraft)} disabled={busy}>
                        Save draft
                      </Button>
                      {autoSubmitGlobal && task?.auto_submit_enabled && (
                        <Button size="sm" onClick={() => callBrowser('Approve submit', yanaApi.approveBrowserSubmit)} disabled={busy}>
                          Approve submit
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => callBrowser('Cancel', (id) => yanaApi.cancelBrowser(id))} disabled={busy}>
                        Cancel browser session
                      </Button>
                    </>
                  )}
                  {browser?.status === 'submitted' && (
                    <Button size="sm" variant="ghost" onClick={() => callBrowser('Reopen', yanaApi.startBrowser)} disabled={busy}>
                      Open audit
                    </Button>
                  )}
                </div>
                {!autoSubmitGlobal && (
                  <p className="text-[10px] text-slate-500">
                    Auto-submit is globally disabled (server flag <code>YANA_ALLOW_AUTOSUBMIT</code>). Yana will only fill + draft.
                  </p>
                )}
              </div>
            )}

            {events.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-slate-800">Audit timeline</h4>
                <ol className="space-y-2 max-h-48 overflow-auto pr-2">
                  {events.slice().reverse().map((e) => (
                    <li key={e.id} className="text-xs text-slate-700 border-l-2 border-purple-300 pl-3">
                      <div className="font-medium">{e.event_type}{e.status ? ` — ${e.status}` : ''}</div>
                      {e.message && <div className="text-slate-500">{e.message}</div>}
                      <div className="text-[10px] text-slate-400">{new Date(e.created_at).toLocaleString()}</div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {task && !['submitted', 'cancelled', 'failed'].includes(task.status) && (
            <>
              <Button variant="outline" size="sm" onClick={continueYana} disabled={busy}>
                {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
                Let Yana continue
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => approveAutoSubmit(!task.auto_submit_enabled)}
                disabled={busy}
              >
                {task.auto_submit_enabled ? 'Disable auto-submit' : 'Enable auto-submit'}
              </Button>
            </>
          )}
          {task?.application_url && (
            <a
              href={task.application_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" /> Open portal
            </a>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
