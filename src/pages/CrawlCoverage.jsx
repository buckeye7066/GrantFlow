import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCrawlCoverage, runCrawlCoverageSource } from '@/api/adminDiagnostics';
import { buildProfileSectionLink } from '@/config/missingInfoTargets';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';

/**
 * CrawlCoverage — ADMIN read-only crawl coverage & health dashboard
 * (architecture point #13). Renders the GET /api/admin/crawl-coverage report:
 *   - per-run / per-source coverage table (planned / queried / failed / found /
 *     accepted), color-coded green (queried+found) / red (failed) / amber (stale)
 *   - a "stale sources" list (past freshness window per sourceRegistry)
 *   - a "profiles needing data" list (missing state/zip/type/etc.)
 *
 * It answers the operator question: "did the crawler know where to look, did it
 * query, what failed, what was found vs accepted vs rejected?"
 */
export default function CrawlCoverage() {
  const [profileIdInput, setProfileIdInput] = useState('');
  const [profileId, setProfileId] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'crawl-coverage', profileId],
    queryFn: () => fetchCrawlCoverage({ profileId: profileId || undefined, limit: 25 }),
    refetchOnWindowFocus: false,
  });

  const applyFilter = (e) => {
    e?.preventDefault?.();
    setProfileId(profileIdInput.trim());
  };

  // Per-source outcome of the "Run now" action, keyed by source_id, so a
  // result (success/error) sticks around next to the row it belongs to even
  // after the mutation moves on to another row.
  const [runResults, setRunResults] = useState({});
  const runSourceMutation = useMutation({
    mutationFn: (sourceId) => runCrawlCoverageSource({ sourceId, profileId: profileId || undefined }),
    onSuccess: (res, sourceId) => {
      setRunResults((prev) => ({
        ...prev,
        [sourceId]: res?.partial
          ? { status: 'pending', message: res.message || 'Still running in the background.' }
          : { status: 'success', message: `Ran — found ${res?.found ?? 0}, rejected ${res?.rejected ?? 0}.` },
      }));
      queryClient.invalidateQueries({ queryKey: ['admin', 'crawl-coverage'] });
    },
    onError: (err, sourceId) => {
      setRunResults((prev) => ({
        ...prev,
        [sourceId]: { status: 'error', message: err?.message || 'Run failed.' },
      }));
    },
  });

  const totals = data?.totals ?? {};
  const failureRatePct = Math.round((Number(totals.source_failure_rate) || 0) * 100);
  const failureRateTone =
    failureRatePct >= 25 ? 'text-red-600' : failureRatePct >= 10 ? 'text-amber-600' : 'text-emerald-600';

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900">
            <Activity className="h-6 w-6 text-indigo-600" />
            Crawl Coverage &amp; Health
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Did the crawler know where to look, did it query, what failed, and what was found vs
            accepted vs rejected.
          </p>
          <p className="mt-1 text-sm">
            <Link
              to={`/CoverageEvidence${profileId ? `?profile_id=${encodeURIComponent(profileId)}` : ''}`}
              className="font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
            >
              Per-profile coverage &amp; evidence dashboard →
            </Link>
          </p>
        </div>
        <form onSubmit={applyFilter} className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              value={profileIdInput}
              onChange={(e) => setProfileIdInput(e.target.value)}
              placeholder="Filter by profileId (optional)"
              className="w-64 pl-8"
            />
          </div>
          <Button type="submit" variant="outline">
            Apply
          </Button>
          <Button type="button" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </form>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading coverage report…
        </div>
      ) : isError ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-2 py-6 text-red-700">
            <XCircle className="h-5 w-5" />
            Failed to load crawl coverage: {error?.message || 'unknown error'} (admin access
            required)
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <SummaryTile label="Recent runs" value={totals.runs ?? 0} />
            <SummaryTile
              label="Sources failed"
              value={totals.sources_failed_recent ?? 0}
              tone={Number(totals.sources_failed_recent) > 0 ? 'text-red-600' : 'text-emerald-600'}
            />
            <SummaryTile label="Failure rate" value={`${failureRatePct}%`} tone={failureRateTone} />
            <SummaryTile
              label="Stale sources"
              value={totals.stale_sources ?? 0}
              tone={Number(totals.stale_sources) > 0 ? 'text-amber-600' : 'text-emerald-600'}
            />
            <SummaryTile
              label="Weak-data profiles"
              value={totals.weak_data_profiles ?? 0}
              tone={Number(totals.weak_data_profiles) > 0 ? 'text-amber-600' : 'text-emerald-600'}
            />
          </div>

          {/* Per-run coverage table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Per-run coverage</CardTitle>
              <CardDescription>
                Planned vs queried vs failed sources, and results found vs accepted vs rejected, for
                each recent crawl run.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {(data?.runs?.length ?? 0) === 0 ? (
                <EmptyRow text="No crawl runs recorded yet (crawler_source_runs is empty)." />
              ) : (
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="py-2 pr-3">Run / Profile</th>
                      <th className="py-2 pr-3">When</th>
                      <th className="py-2 pr-3 text-right">Planned</th>
                      <th className="py-2 pr-3 text-right">Queried</th>
                      <th className="py-2 pr-3 text-right">Failed</th>
                      <th className="py-2 pr-3 text-right">Found</th>
                      <th className="py-2 pr-3 text-right">Accepted</th>
                      <th className="py-2 pr-3 text-right">Rejected</th>
                      <th className="py-2 pr-3 text-right">Avg trust</th>
                      <th className="py-2 pr-3 text-right">Avg match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((run) => (
                      <RunRow key={run.crawler_run_id} run={run} />
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Stale sources */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="h-4 w-4 text-amber-500" /> Stale sources
                </CardTitle>
                <CardDescription>
                  Sources whose last successful crawl is older than their freshness window (or that
                  have never run).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {(data?.stale_sources?.length ?? 0) === 0 ? (
                  <EmptyRow text="All sources are within their freshness window." ok />
                ) : (
                  data.stale_sources.map((s) => {
                    const running = runSourceMutation.isPending && runSourceMutation.variables === s.source_id;
                    const result = runResults[s.source_id];
                    return (
                      <div
                        key={s.source_id}
                        className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium text-slate-800">{s.label}</div>
                            <div className="text-xs text-slate-500">{s.source_id}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <div className="text-right text-xs">
                              {s.failure_status === 'never_run' ? (
                                <span className="font-medium text-amber-700">never run</span>
                              ) : (
                                <span className="font-medium text-amber-700">
                                  {s.days_since}d old (limit {s.freshness_days}d)
                                </span>
                              )}
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={running}
                              onClick={() => runSourceMutation.mutate(s.source_id)}
                            >
                              {running ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <PlayCircle className="h-3.5 w-3.5" />
                              )}
                              <span className="ml-1">Run now</span>
                            </Button>
                          </div>
                        </div>
                        {result && (
                          <div
                            className={`mt-1.5 flex items-center gap-1.5 text-xs ${
                              result.status === 'error'
                                ? 'text-red-600'
                                : result.status === 'pending'
                                  ? 'text-amber-700'
                                  : 'text-emerald-700'
                            }`}
                          >
                            {result.status === 'error' ? (
                              <XCircle className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            )}
                            {result.message}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>

            {/* Profiles needing data */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4 text-amber-500" /> Profiles needing data
                </CardTitle>
                <CardDescription>
                  Profiles missing high-value crawl-targeting fields (type, location, or intent
                  signals) that limit what the crawler can find.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {(data?.weak_data_profiles?.length ?? 0) === 0 ? (
                  <EmptyRow text="No weak-data profiles detected." ok />
                ) : (
                  data.weak_data_profiles.map((p) => {
                    // Deep-link to the first missing field's own section/tab when
                    // resolvable (same MISSING_INFO_TARGETS convention used by
                    // MissingInfoChecklist); otherwise fall back to the bare
                    // profile edit page — always somewhere actionable, never a
                    // dead end.
                    const primaryHref =
                      p.missing.map((m) => buildProfileSectionLink(p.profile_id, m)).find(Boolean) ||
                      `/ProfileDetail?id=${encodeURIComponent(p.profile_id)}`;
                    return (
                      <div
                        key={p.profile_id}
                        className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-800">{p.display_name}</span>
                          <span className="shrink-0 text-xs text-slate-500">readiness {p.score}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {p.missing.map((m) => {
                            const href = buildProfileSectionLink(p.profile_id, m);
                            return href ? (
                              <Link
                                key={m}
                                to={href}
                                className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-200"
                              >
                                {m}
                              </Link>
                            ) : (
                              <span
                                key={m}
                                className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800"
                              >
                                {m}
                              </span>
                            );
                          })}
                        </div>
                        <Link
                          to={primaryHref}
                          className="group mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                        >
                          Complete profile
                          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                        </Link>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>

          {!data?.optional_tables?.rejection_log && (
            <p className="text-xs text-slate-400">
              Note: the optional rejection_log table is not present — rejected counts are derived
              from found minus accepted where available.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, tone = 'text-slate-900' }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className={`text-2xl font-semibold ${tone}`}>{value}</div>
        <div className="mt-1 text-xs uppercase tracking-wide text-slate-400">{label}</div>
      </CardContent>
    </Card>
  );
}

function EmptyRow({ text, ok = false }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      ) : (
        <Activity className="h-4 w-4 text-slate-400" />
      )}
      {text}
    </div>
  );
}

function RunRow({ run }) {
  const failed = Number(run.sources_failed) > 0;
  const queriedNoFound = Number(run.sources_queried) > 0 && Number(run.results_found) === 0;
  const rowTone = failed
    ? 'bg-red-50/60'
    : queriedNoFound
      ? 'bg-amber-50/50'
      : Number(run.results_found) > 0
        ? 'bg-emerald-50/40'
        : '';
  return (
    <>
      <tr className={`border-b border-slate-100 ${rowTone}`}>
        <td className="py-2 pr-3">
          <div className="font-mono text-xs text-slate-600">
            {String(run.crawler_run_id).slice(0, 8)}
          </div>
          <div className="text-xs text-slate-400">
            {run.profile_id ? `${String(run.profile_id).slice(0, 8)} · ` : ''}
            {run.crawler_type || 'crawl'}
          </div>
        </td>
        <td className="py-2 pr-3 text-xs text-slate-500">{formatWhen(run.started_at)}</td>
        <td className="py-2 pr-3 text-right">{run.sources_planned}</td>
        <td className="py-2 pr-3 text-right font-medium text-emerald-700">{run.sources_queried}</td>
        <td className={`py-2 pr-3 text-right font-medium ${failed ? 'text-red-600' : 'text-slate-400'}`}>
          {run.sources_failed}
        </td>
        <td className="py-2 pr-3 text-right">{run.results_found}</td>
        <td className="py-2 pr-3 text-right">{run.results_accepted ?? '—'}</td>
        <td className="py-2 pr-3 text-right">{run.results_rejected ?? '—'}</td>
        <td className="py-2 pr-3 text-right">{run.avg_trust ?? '—'}</td>
        <td className="py-2 pr-3 text-right">{run.avg_match ?? '—'}</td>
      </tr>
      {failed && run.failed_sources?.length > 0 && (
        <tr className="border-b border-slate-100 bg-red-50/40">
          <td colSpan={10} className="px-3 py-1.5">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="font-medium text-red-700">Failed:</span>
              {run.failed_sources.map((f) => (
                <span
                  key={f.source_id}
                  className="rounded bg-red-100 px-1.5 py-0.5 text-red-800"
                  title={f.error}
                >
                  {f.label}
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}
