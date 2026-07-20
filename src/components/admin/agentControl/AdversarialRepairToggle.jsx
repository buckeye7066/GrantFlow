import React, { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldAlert, GitPullRequest, GitMerge } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import agentControlApi from '@/api/agentControl'

/**
 * Owner-only control for the Anya/Sam adversarial code-repair feature
 * (+ direct-to-main landing). Persisted DB-authoritative over env, so the owner
 * never needs a Railway env var. The whole Agent Control Center is already
 * owner-gated; the backend re-checks the owner gate on every call.
 *
 * The card TITLE is the owner's explicit verbatim choice. The functional
 * sub-controls beneath it stay clear so the control tells the owner what it does.
 */

function ToggleSwitch({ on, disabled, onClick, label, tone = 'emerald' }) {
  const onColor = tone === 'amber' ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        on ? onColor : 'bg-slate-300 dark:bg-slate-600',
        disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
          on ? 'translate-x-5' : 'translate-x-1',
        ].join(' ')}
      />
    </button>
  )
}

function ReadinessLine({ readiness }) {
  if (!readiness) return null
  const tone =
    readiness.status === 'ready'
      ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300'
      : readiness.status === 'pr_only'
        ? 'border-amber-300 text-amber-700 dark:text-amber-300'
        : 'border-rose-300 text-rose-700 dark:text-rose-300'
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="outline" className={tone}>{readiness.message}</Badge>
      <span className="text-slate-400 dark:text-slate-500">
        AI author {readiness.anthropicKey ? 'ok' : 'missing'} · verifier {readiness.openaiKey ? 'ok' : 'missing'} · GitHub token {readiness.githubToken ? 'ok' : 'missing'}
      </span>
    </div>
  )
}

export default function AdversarialRepairToggle() {
  const [config, setConfig] = useState(null)
  const [readiness, setReadiness] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const apply = useCallback((res) => {
    if (res?.config) setConfig(res.config)
    if (res?.readiness) setReadiness(res.readiness)
  }, [])

  const load = useCallback(async () => {
    try {
      setError(null)
      apply(await agentControlApi.getAdversarialRepair())
    } catch (err) {
      setError(err?.message || 'Failed to load repair settings')
    } finally {
      setLoading(false)
    }
  }, [apply])

  useEffect(() => { load() }, [load])

  const save = useCallback(async (patch) => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      apply(await agentControlApi.setAdversarialRepair(patch))
    } catch (err) {
      setError(err?.message || 'Failed to update repair settings')
    } finally {
      setSaving(false)
    }
  }, [saving, apply])

  const enabled = Boolean(config?.enabled)
  const landMode = config?.landMode === 'direct' ? 'direct' : 'pr'
  const allowCritical = Boolean(config?.allowCritical)
  const busy = loading || saving || !config

  return (
    <Card className="border-slate-200 dark:border-slate-700">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-slate-900 dark:text-slate-100">
          The toggle switch that exists because Claude is a moron
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ReadinessLine readiness={readiness} />

        {/* Master switch */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium">Autonomous code repair (Sam/Anya)</div>
          </div>
          <ToggleSwitch
            on={enabled}
            disabled={busy}
            onClick={() => save({ enabled: !enabled })}
            label={enabled ? 'Turn autonomous code repair off' : 'Turn autonomous code repair on'}
          />
        </div>

        {enabled ? (
          <div className="space-y-3 rounded border border-slate-200 dark:border-slate-700 p-3">
            {/* How fixes land */}
            <div className="text-sm font-medium">How fixes land</div>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => save({ landMode: 'pr' })}
                disabled={busy}
                className={[
                  'flex items-center gap-2 rounded border p-2 text-left text-sm transition-colors',
                  landMode === 'pr'
                    ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
                  busy ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
                ].join(' ')}
              >
                <GitPullRequest className="h-4 w-4 shrink-0 text-slate-500" />
                <span>Open a pull request for review</span>
                {landMode === 'pr' ? <Badge variant="outline" className="ml-auto text-[10px]">selected</Badge> : null}
              </button>
              <button
                type="button"
                onClick={() => save({ landMode: 'direct' })}
                disabled={busy}
                className={[
                  'flex items-center gap-2 rounded border p-2 text-left text-sm transition-colors',
                  landMode === 'direct'
                    ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/30'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
                  busy ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
                ].join(' ')}
              >
                <GitMerge className="h-4 w-4 shrink-0 text-slate-500" />
                <span>Merge directly to main (auto-deploys to production)</span>
                {landMode === 'direct' ? <Badge variant="outline" className="ml-auto text-[10px]">selected</Badge> : null}
              </button>
            </div>

            {/* Critical-path override — warning-styled, only when direct */}
            {landMode === 'direct' ? (
              <div className="flex items-start justify-between gap-3 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
                    <ShieldAlert className="h-4 w-4 shrink-0" />
                    Also allow direct-merge to critical paths
                  </div>
                  <div className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                    Authentication, billing, database migrations, schema, CI. WARNING: unreviewed
                    AI-generated changes will auto-deploy to your most sensitive code with no human review.
                  </div>
                </div>
                <ToggleSwitch
                  on={allowCritical}
                  disabled={busy}
                  tone="amber"
                  onClick={() => save({ allowCritical: !allowCritical })}
                  label={allowCritical ? 'Disallow direct-merge to critical paths' : 'Allow direct-merge to critical paths'}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-2 text-xs">
          {loading ? (
            <span className="inline-flex items-center gap-1 text-slate-500"><Loader2 className="h-3 w-3 animate-spin" /> loading…</span>
          ) : saving ? (
            <span className="inline-flex items-center gap-1 text-slate-500"><Loader2 className="h-3 w-3 animate-spin" /> saving…</span>
          ) : (
            <Badge variant="outline" className={enabled ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300' : 'border-slate-300 text-slate-600 dark:text-slate-300'}>
              {enabled ? `repair ON · ${landMode === 'direct' ? 'direct-merge' : 'PR'}` : 'repair OFF'}
            </Badge>
          )}
          {error ? <span className="text-rose-600 dark:text-rose-400">{error}</span> : null}
        </div>
      </CardContent>
    </Card>
  )
}
