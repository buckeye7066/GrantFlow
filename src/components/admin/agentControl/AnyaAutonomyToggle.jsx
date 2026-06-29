import React, { useCallback, useEffect, useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import agentControlApi from '@/api/agentControl'

/**
 * Anya autonomy master toggle for the Agent Control Center.
 *
 * Anya is interactive/on-demand (not part of the automated full-cycle), so she
 * has no start/stop card. This panel exposes the ONE owner switch that matters:
 * her autonomous scheduler (daily discovery + match-scout + portal/geo checks).
 * ON by default; flipping it OFF persists (agent_settings 'anya.autonomous_enabled')
 * and takes effect on the next scheduler tick without a restart.
 */
export default function AnyaAutonomyToggle() {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const res = await agentControlApi.getAnyaAutonomous()
      setState(res)
    } catch (err) {
      setError(err?.message || 'Failed to load Anya autonomy state')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const toggle = useCallback(async () => {
    if (!state || saving) return
    const next = !state.enabled
    setSaving(true)
    setError(null)
    try {
      const res = await agentControlApi.setAnyaAutonomous(next)
      setState(res)
    } catch (err) {
      setError(err?.message || 'Failed to update Anya autonomy')
    } finally {
      setSaving(false)
    }
  }, [state, saving])

  const enabled = Boolean(state?.enabled)

  return (
    <div className="rounded border border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-4 w-4 text-slate-500 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium">Anya</span>
              <span className="text-xs text-slate-500">Autonomous scheduler</span>
              {state?.source === 'toggle' ? (
                <Badge variant="outline" className="text-[10px]">manual override</Badge>
              ) : null}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
              Daily discovery, match-scout, portal &amp; geo checks (code self-edit stays opt-in).
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={toggle}
          disabled={loading || saving || !state}
          aria-pressed={enabled}
          aria-label={enabled ? 'Turn Anya autonomy off' : 'Turn Anya autonomy on'}
          className={[
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
            enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600',
            (loading || saving || !state) ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
              enabled ? 'translate-x-5' : 'translate-x-1',
            ].join(' ')}
          />
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs">
        {loading ? (
          <span className="inline-flex items-center gap-1 text-slate-500"><Loader2 className="h-3 w-3 animate-spin" /> loading…</span>
        ) : saving ? (
          <span className="inline-flex items-center gap-1 text-slate-500"><Loader2 className="h-3 w-3 animate-spin" /> saving…</span>
        ) : (
          <Badge variant="outline" className={enabled
            ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300'
            : 'border-slate-300 text-slate-600 dark:text-slate-300'}>
            {enabled ? 'autonomy ON' : 'autonomy OFF'}
          </Badge>
        )}
        {error ? <span className="text-rose-600 dark:text-rose-400">{error}</span> : null}
      </div>
    </div>
  )
}
