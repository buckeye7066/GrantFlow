import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow, isValid, parseISO } from 'date-fns'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Database,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAdmin } from '../../contexts/AdminContext'
import type { AnyaLogEntry } from '../../api/anya'

type StatusState = 'idle' | 'running' | 'error'

type StatusMeta = {
  label: string
  description: string
  badgeClass: string
  icon: LucideIcon
}

const STATUS_META: Record<StatusState, StatusMeta> = {
  idle: {
    label: 'Idle',
    description: 'Anya is standing by for the next task.',
    badgeClass: 'bg-emerald-100 text-emerald-700',
    icon: CheckCircle2,
  },
  running: {
    label: 'Running',
    description: 'Anya is currently processing a task.',
    badgeClass: 'bg-blue-100 text-blue-700',
    icon: Activity,
  },
  error: {
    label: 'Attention',
    description: 'The last task ended with an error. Review and retry.',
    badgeClass: 'bg-rose-100 text-rose-700',
    icon: AlertTriangle,
  },
}

const LOG_STATUS_META: Record<AnyaLogEntry['status'], { label: string; badgeClass: string }> = {
  started: {
    label: 'Started',
    badgeClass: 'bg-blue-100 text-blue-700',
  },
  completed: {
    label: 'Completed',
    badgeClass: 'bg-emerald-100 text-emerald-700',
  },
  failed: {
    label: 'Failed',
    badgeClass: 'bg-rose-100 text-rose-700',
  },
}

type ScanOptions = {
  target: string
  autoFix: boolean
  approve: boolean
}

type CrawlOptions = {
  scope: string
  depth: number
}

type ExplainOptions = {
  context: string
}

function formatRelativeTime(timestamp?: string | null) {
  if (!timestamp) return null
  try {
    const parsed = parseISO(timestamp)
    if (!isValid(parsed)) return null
    return formatDistanceToNow(parsed, { addSuffix: true })
  } catch {
    return null
  }
}

export function AnyaStatusPanel() {
  const { status, logs, execute, refreshStatus, refreshLogs, loading, error, token } = useAdmin()

  const [scanOptions, setScanOptions] = useState<ScanOptions>({
    target: 'repository',
    autoFix: false,
    approve: false,
  })
  const [crawlOptions, setCrawlOptions] = useState<CrawlOptions>({
    scope: 'default-datasets',
    depth: 1,
  })
  const [explainOptions, setExplainOptions] = useState<ExplainOptions>({
    context: 'latest-scan',
  })
  const [localError, setLocalError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)

  const latestLogs = useMemo(() => logs.slice(0, 8), [logs])

  const statusState: StatusState = status?.status ?? 'idle'
  const statusMeta = STATUS_META[statusState]

  const handleRefresh = useCallback(async () => {
    if (!token) return
    setIsRefreshing(true)
    setLocalError(null)
    try {
      await Promise.all([refreshStatus(), refreshLogs(25)])
      setLastRefreshedAt(new Date())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to refresh Anya status'
      setLocalError(message)
    } finally {
      setIsRefreshing(false)
    }
  }, [refreshLogs, refreshStatus, token])

  const runAction = useCallback(
    async (action: 'scan' | 'crawl' | 'explain', payload: Record<string, unknown>) => {
      setLocalError(null)
      try {
        await execute(action, payload)
        setLastRefreshedAt(new Date())
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Action failed'
        setLocalError(message)
      }
    },
    [execute],
  )

  useEffect(() => {
    void handleRefresh()
  }, [handleRefresh])

  const currentAction = status?.currentAction
  const lastAction = status?.lastAction
  const lastError = status?.lastError

  const lastRefreshedLabel = lastRefreshedAt ? formatDistanceToNow(lastRefreshedAt, { addSuffix: true }) : null

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Anya automation</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Monitor assistant activity, review the latest run, and launch new tasks.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={loading || isRefreshing}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              Refresh
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${statusMeta.badgeClass}`}
            >
              <statusMeta.icon className="h-4 w-4" aria-hidden />
              {statusMeta.label}
            </span>
            <span className="text-sm text-slate-600 dark:text-slate-400">{statusMeta.description}</span>
          </div>

          {currentAction && (
            <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800/60 dark:bg-blue-950/40 dark:text-blue-200">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">Executing {currentAction.action}</p>
                  <p className="text-xs opacity-80">
                    Started {formatRelativeTime(currentAction.startedAt) ?? 'just now'}
                  </p>
                </div>
                <span className="inline-flex items-center gap-2 text-xs font-semibold">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  In progress
                </span>
              </div>
            </div>
          )}

          {lastAction && !currentAction && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">Last action: {lastAction.action}</p>
                  <p className="text-xs opacity-80">
                    {lastAction.message} • {formatRelativeTime(lastAction.timestamp) ?? 'recently'}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${LOG_STATUS_META[lastAction.status].badgeClass}`}
                >
                  {LOG_STATUS_META[lastAction.status].label}
                </span>
              </div>
            </div>
          )}

          {lastError && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800/40 dark:bg-rose-950/40 dark:text-rose-200">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden />
                <div>
                  <p className="font-semibold">Latest error</p>
                  <p>{lastError.message}</p>
                  <p className="mt-1 text-xs opacity-70">
                    Occurred {formatRelativeTime(lastError.occurredAt) ?? 'recently'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {(localError || error) && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-100">
              {localError ?? error}
            </div>
          )}

          {lastRefreshedLabel && (
            <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">Last updated {lastRefreshedLabel}</p>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Repository scan</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Audit the latest changes and detect potential risks.
                </p>
              </div>
              <div className="rounded-full bg-blue-100 p-2 text-blue-600 dark:bg-blue-900/40 dark:text-blue-200">
                <ShieldCheck className="h-5 w-5" aria-hidden />
              </div>
            </div>
            <form
              className="mt-4 space-y-3 text-sm"
              onSubmit={(event) => {
                event.preventDefault()
                void runAction('scan', {
                  target: scanOptions.target.trim() || 'repository',
                  autoFix: scanOptions.autoFix,
                  approve: scanOptions.approve,
                })
              }}
            >
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Target
                <input
                  type="text"
                  value={scanOptions.target}
                  onChange={(event) =>
                    setScanOptions((prev) => ({ ...prev, target: event.target.value }))
                  }
                  placeholder="repository"
                  className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/40"
                />
              </label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={scanOptions.approve}
                    onChange={(event) => {
                      const nextApprove = event.target.checked
                      setScanOptions((prev) => ({
                        ...prev,
                        approve: nextApprove,
                        autoFix: nextApprove ? prev.autoFix : false,
                      }))
                    }}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800"
                  />
                  Approve automated remediations
                </label>
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={scanOptions.autoFix}
                    onChange={(event) => {
                      const nextAutoFix = event.target.checked
                      setScanOptions((prev) => ({
                        ...prev,
                        autoFix: nextAutoFix,
                        approve: nextAutoFix ? true : prev.approve,
                      }))
                    }}
                    disabled={!scanOptions.approve}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800"
                  />
                  Auto-fix approved issues
                </label>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Auto-fix requires explicit approval. Anya will pause if issues need review.
                </p>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Bot className="h-4 w-4" aria-hidden />}
                Run scan
              </button>
            </form>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Dataset crawl</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Discover fresh opportunities across connected datasets.
                </p>
              </div>
              <div className="rounded-full bg-emerald-100 p-2 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-200">
                <Database className="h-5 w-5" aria-hidden />
              </div>
            </div>
            <form
              className="mt-4 space-y-3 text-sm"
              onSubmit={(event) => {
                event.preventDefault()
                const depth = Number.isFinite(crawlOptions.depth) ? Math.max(1, Math.round(crawlOptions.depth)) : 1
                void runAction('crawl', {
                  scope: crawlOptions.scope.trim() || 'default-datasets',
                  depth,
                })
              }}
            >
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Scope
                <input
                  type="text"
                  value={crawlOptions.scope}
                  onChange={(event) => setCrawlOptions((prev) => ({ ...prev, scope: event.target.value }))}
                  placeholder="default-datasets"
                  className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/40"
                />
              </label>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Depth
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={crawlOptions.depth}
                  onChange={(event) =>
                    setCrawlOptions((prev) => ({
                      ...prev,
                      depth: Number(event.target.value) || 1,
                    }))
                  }
                  className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/40"
                />
              </label>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-emerald-400 dark:text-emerald-900 dark:hover:bg-emerald-300"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Activity className="h-4 w-4" aria-hidden />
                )}
                Run crawl
              </button>
            </form>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 md:col-span-2 xl:col-span-1">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Explain findings</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Ask Anya for a human-readable summary of recent work.
                </p>
              </div>
              <div className="rounded-full bg-violet-100 p-2 text-violet-600 dark:bg-violet-900/40 dark:text-violet-200">
                <FileText className="h-5 w-5" aria-hidden />
              </div>
            </div>
            <form
              className="mt-4 space-y-3 text-sm"
              onSubmit={(event) => {
                event.preventDefault()
                void runAction('explain', {
                  context: explainOptions.context.trim() || 'latest-scan',
                })
              }}
            >
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Context
                <input
                  type="text"
                  value={explainOptions.context}
                  onChange={(event) =>
                    setExplainOptions((prev) => ({ ...prev, context: event.target.value }))
                  }
                  placeholder="latest-scan"
                  className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/40"
                />
              </label>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Bot className="h-4 w-4" aria-hidden />
                )}
                Request summary
              </button>
            </form>
          </div>
        </div>
      </div>

      <aside className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Recent activity</h3>
            <span className="text-xs text-slate-400 dark:text-slate-500">{logs.length} entries</span>
          </div>
          {latestLogs.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">No automation activity recorded yet.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {latestLogs.map((entry) => {
                const logMeta = LOG_STATUS_META[entry.status]
                const relative = formatRelativeTime(entry.timestamp)
                return (
                  <li
                    key={entry.id}
                    className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${logMeta.badgeClass}`}
                          >
                            {logMeta.label}
                          </span>
                          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 capitalize">
                            {entry.action}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{entry.message}</p>
                        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                          Triggered by {entry.actor}
                        </p>
                      </div>
                      <span className="text-xs text-slate-400 dark:text-slate-500">{relative ?? '—'}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>
    </section>
  )
}


