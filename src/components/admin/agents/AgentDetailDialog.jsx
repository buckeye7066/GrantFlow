import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { agentControlApi } from '@/api/agentControl'
import { Loader2 } from 'lucide-react'

function formatTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

/**
 * Shared detail dialog for an agent card: full status, a "Run now" action,
 * and a free-text instruction the owner can attach before the next run. The
 * instruction is stored server-side (agent.directive.<name>) and consumed
 * one-shot by agentControlOrchestrator.startRun — every adapter receives it
 * as options.directives[agentName].
 */
export default function AgentDetailDialog({ agent, open, onOpenChange, onStarted }) {
  const [instruction, setInstruction] = useState('')
  const [existingDirective, setExistingDirective] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    if (!open || !agent || agent.agent_name === 'anya') return
    let active = true
    setError(null)
    setNotice(null)
    agentControlApi.getDirective(agent.agent_name)
      .then((res) => { if (active) setExistingDirective(res?.directive || null) })
      .catch(() => { if (active) setExistingDirective(null) })
    return () => { active = false }
  }, [open, agent])

  if (!agent) return null
  const isAnya = agent.agent_name === 'anya'

  async function handleSendInstruction() {
    setBusy(true)
    setError(null)
    try {
      const res = await agentControlApi.setDirective(agent.agent_name, instruction)
      setExistingDirective(res?.directive || null)
      setInstruction('')
      setNotice(instruction.trim() ? 'Instruction saved — it will apply to the next run.' : 'Instruction cleared.')
    } catch (err) {
      setError(err?.message || 'Failed to save instruction')
    } finally {
      setBusy(false)
    }
  }

  async function handleRunNow({ withInstruction } = {}) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (withInstruction && instruction.trim()) {
        await agentControlApi.setDirective(agent.agent_name, instruction)
        setInstruction('')
      }
      await agentControlApi.startAgent(agent.agent_name, {})
      setNotice(`${agent.label} started.`)
      onStarted?.(agent.agent_name)
      const res = await agentControlApi.getDirective(agent.agent_name)
      setExistingDirective(res?.directive || null)
    } catch (err) {
      setError(err?.message || 'Failed to start agent')
    } finally {
      setBusy(false)
    }
  }

  const m = agent.primary_metrics || {}

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {agent.label}
            <Badge variant="outline" className="text-[10px] uppercase">{agent.health}</Badge>
          </DialogTitle>
          <DialogDescription>{agent.tagline}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <div className="flex items-center justify-between">
              <dt className="text-xs text-slate-500">Last run</dt>
              <dd className="font-mono text-xs">{formatTime(agent.last_run_at)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-xs text-slate-500">Last success</dt>
              <dd className="font-mono text-xs">{formatTime(agent.last_success_at)}</dd>
            </div>
            {Object.entries(m).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => (
              <div key={k} className="flex items-center justify-between">
                <dt className="text-xs text-slate-500">{k.replace(/_/g, ' ')}</dt>
                <dd className="font-mono text-xs">{String(v)}</dd>
              </div>
            ))}
          </dl>

          {Array.isArray(agent.notes) && agent.notes.length ? (
            <div className="rounded border bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-900/40 dark:text-slate-300">
              {agent.notes.map((n, i) => <div key={i}>{n}</div>)}
            </div>
          ) : null}

          {isAnya ? (
            <div className="rounded border bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-900/40 dark:text-slate-300">
              Anya is interactive-only — she doesn't run on a schedule or take a queued instruction here.
              Talk to her directly in the Anya chat panel.
            </div>
          ) : (
            <>
              {existingDirective?.text ? (
                <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  <span className="font-medium">Pending instruction:</span> {existingDirective.text}
                  <span className="ml-1 text-amber-700 dark:text-amber-400">(applies on next run)</span>
                </div>
              ) : null}

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Give {agent.label} a specific instruction
                </label>
                <Textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={`e.g. "Focus on the Smith profile" or "Re-check the web-parity benchmark"`}
                  rows={3}
                  disabled={busy}
                />
              </div>
            </>
          )}

          {error ? <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div> : null}
          {notice ? <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">{notice}</div> : null}
        </div>

        {!isAnya ? (
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <Button variant="outline" size="sm" disabled={busy} onClick={handleSendInstruction}>
              {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Save instruction only
            </Button>
            <Button size="sm" disabled={busy} onClick={() => handleRunNow({ withInstruction: true })}>
              {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Run {agent.label} now
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
