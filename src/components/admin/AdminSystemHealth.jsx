import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, Clock, Server, RefreshCw, CheckCircle2, AlertCircle, HardDrive, ShieldCheck, Target } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function AdminSystemHealth() {
  const [health, setHealth] = useState(null);
  const [storage, setStorage] = useState(null);
  const [mission, setMission] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  const fetchHealth = async () => {
    try {
      setRefreshing(true);
      setFetchError(null);
      const [healthData, storageData, missionData] = await Promise.all([
        apiFetch('/api/admin/system-health'),
        apiFetch('/api/health/storage').catch((err) => ({ ok: false, status: 'error', error: err?.message || String(err) })),
        apiFetch('/api/health/mission').catch((err) => ({ ok: false, error: err?.message || String(err) })),
      ]);
      setHealth(healthData);
      setStorage(storageData);
      setMission(missionData);
    } catch (err) {
      console.error('Failed to fetch system health', err);
      setFetchError(err?.message || String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  if (loading) {
    return <div className="flex justify-center p-12"><Loader2 className="animate-spin h-8 w-8 text-blue-600" /></div>;
  }

  const storageDegraded =
    storage &&
    (storage.ok === false ||
      storage.status === 'degraded' ||
      storage.writable === false ||
      storage.likely_persistent === false ||
      storage.missing_uploads_dir_env === true);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-900">System Health</h2>
        <Button variant="outline" size="sm" onClick={fetchHealth} disabled={refreshing}>
          <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {storageDegraded ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-amber-700" />
            <div className="flex-1">
              <p className="font-semibold">Upload storage is degraded</p>
              <p className="mt-1 text-sm text-amber-900">
                Avatars and uploaded documents may disappear after restart if the uploads directory is not on a persistent, writable volume.
              </p>
              <div className="mt-2 text-xs text-amber-900 space-y-1">
                <div><span className="font-semibold">uploadsDir:</span> {storage?.details_redacted ? 'redacted in health response' : (storage?.uploadsDir || storage?.uploads_dir || 'unknown')}</div>
                <div><span className="font-semibold">writable:</span> {String(storage?.writable ?? 'unknown')}</div>
                <div><span className="font-semibold">likely persistent:</span> {String(storage?.likely_persistent ?? 'unknown')}</div>
                {storage?.last_error ? <div><span className="font-semibold">last error:</span> {String(storage.last_error)}</div> : null}
              </div>
              <p className="mt-3 text-sm">
                Fix on Railway: mount a persistent volume and set <span className="font-mono">UPLOADS_DIR=/data/uploads</span>.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <MissionHealthPanel mission={mission} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500 flex items-center gap-2">
              <Server className="w-4 h-4" /> API Uptime
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {health?.api_uptime ? Math.floor(health.api_uptime / 3600) + 'h ' + Math.floor((health.api_uptime % 3600) / 60) + 'm' : 'Unknown'}
            </div>
            <p className="text-xs text-slate-500 mt-1">Process running continuously</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500 flex items-center gap-2">
              <Activity className="w-4 h-4" /> Worker Queue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div>
                <div className="text-2xl font-bold text-slate-900">{health?.queue?.queued || 0}</div>
                <p className="text-xs text-slate-500">Queued</p>
              </div>
              <div className="h-8 w-px bg-slate-200" />
              <div>
                <div className="text-2xl font-bold text-blue-600">{health?.queue?.running || 0}</div>
                <p className="text-xs text-slate-500">Running</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-500 flex items-center gap-2">
              <HardDrive className="w-4 h-4" /> Storage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-2xl font-bold text-slate-900">{health?.uploads_count || 0}</div>
                <p className="text-xs text-slate-500 mt-1">Uploaded profile documents</p>
              </div>
              <Badge variant={storageDegraded ? 'destructive' : 'outline'} className={storageDegraded ? '' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}>
                {storageDegraded ? 'Degraded' : 'OK'}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="w-5 h-5" /> Crawler Success Matrix
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {health?.last_success_by_type?.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {health.last_success_by_type.map((item) => (
                  <div key={item.type} className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{item.type}</p>
                    <p className="text-sm font-medium text-slate-900 mt-2 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      {item.last_success && !isNaN(new Date(item.last_success).getTime())
  ? formatDistanceToNow(new Date(item.last_success), { addSuffix: true })
  : 'Never'}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500 text-center py-8">No successful crawler jobs recorded yet.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MissionHealthPanel({ mission }) {
  if (!mission) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="w-5 h-5" /> Mission Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">Loading mission metrics…</p>
        </CardContent>
      </Card>
    );
  }

  if (mission.error) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="w-5 h-5" /> Mission Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-rose-600">Failed to load mission metrics: {String(mission.error)}</p>
        </CardContent>
      </Card>
    );
  }

  const counts = mission.counts || {};
  const rates = mission.rates || {};
  const targets = mission.targets || {};
  const alerts = mission.alerts || [];
  const verifiedPct = Number(rates.verified_pct ?? 0);
  const brokenPct = Number(rates.broken_pct ?? 0);
  const placeholders = Number(counts.placeholder_opportunities ?? 0);
  const verifiedHealthy = verifiedPct >= (targets.verified_pct_min ?? 95);
  const brokenHealthy = brokenPct <= (targets.broken_pct_max ?? 5);
  const placeholderHealthy = placeholders <= (targets.placeholder_max ?? 0);

  return (
    <Card className={mission.ok === false ? 'border-rose-300' : 'border-emerald-200'}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Target className="w-5 h-5" /> Mission Health
          </span>
          <Badge variant={mission.ok === false ? 'destructive' : 'outline'} className={mission.ok === false ? '' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}>
            {mission.ok === false ? 'Action required' : 'On target'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MissionStat
            label="Verified direct opps"
            value={`${verifiedPct}%`}
            sub={`${counts.direct_opportunities_verified ?? 0} of ${counts.direct_opportunities_total ?? 0} (target ≥ ${targets.verified_pct_min ?? 95}%)`}
            healthy={verifiedHealthy}
            icon={<ShieldCheck className="w-4 h-4" />}
          />
          <MissionStat
            label="Broken direct links"
            value={`${brokenPct}%`}
            sub={`${counts.direct_opportunities_broken ?? 0} broken (target ≤ ${targets.broken_pct_max ?? 5}%)`}
            healthy={brokenHealthy}
            icon={<AlertCircle className="w-4 h-4" />}
          />
          <MissionStat
            label="Placeholder rows"
            value={String(placeholders)}
            sub={`Mission rule: must equal ${targets.placeholder_max ?? 0}`}
            healthy={placeholderHealthy}
            icon={<AlertCircle className="w-4 h-4" />}
          />
          <MissionStat
            label="Directories tracked"
            value={String(counts.directory_opportunities_total ?? 0)}
            sub="Always-on fallback supply"
            healthy={true}
            icon={<Activity className="w-4 h-4" />}
          />
        </div>

        {alerts.length > 0 ? (
          <div className="mt-4 space-y-2">
            {alerts.map((a) => (
              <div
                key={a.code}
                className={`text-xs rounded border px-3 py-2 ${
                  a.level === 'error'
                    ? 'border-rose-300 bg-rose-50 text-rose-900'
                    : 'border-amber-300 bg-amber-50 text-amber-900'
                }`}
              >
                <span className="font-semibold uppercase mr-2">{a.level}</span>
                {a.detail}
              </div>
            ))}
          </div>
        ) : null}

        {mission.integration && (
          <div className="mt-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Mission service integration
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {Object.entries(mission.integration).map(([key, info]) => {
                const ok = info?.consumed
                return (
                  <div
                    key={key}
                    className={`text-xs rounded border px-2 py-1.5 ${
                      ok
                        ? 'border-emerald-200 bg-emerald-50/50 text-emerald-900'
                        : 'border-amber-300 bg-amber-50 text-amber-900'
                    }`}
                  >
                    <div className="font-medium capitalize">{key.replace(/_/g, ' ')}</div>
                    <div className="text-[11px] opacity-80">{ok ? 'wired into all expected routes/pages' : 'NOT yet integrated everywhere'}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {Array.isArray(mission.coverage_by_source) && mission.coverage_by_source.length > 0 ? (
          <div className="mt-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Coverage by source (top {mission.coverage_by_source.length})
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {mission.coverage_by_source.map((s) => (
                <div key={s.source} className="text-xs bg-slate-50 border border-slate-100 rounded px-2 py-1.5">
                  <div className="font-medium text-slate-800 truncate" title={s.source}>{s.source}</div>
                  <div className="text-slate-500">{s.n}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <p className="mt-4 text-[10px] text-slate-400">
          Matcher v{mission.matcher_version || 'unknown'} • Generated {mission.generated_at ? new Date(mission.generated_at).toLocaleString() : 'just now'}
        </p>
      </CardContent>
    </Card>
  );
}

function MissionStat({ label, value, sub, healthy, icon }) {
  return (
    <div className={`p-4 rounded-xl border ${healthy ? 'border-emerald-200 bg-emerald-50/50' : 'border-rose-200 bg-rose-50/50'}`}>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className={`text-2xl font-bold mt-1 ${healthy ? 'text-emerald-800' : 'text-rose-800'}`}>{value}</p>
      <p className="text-xs text-slate-500 mt-1">{sub}</p>
    </div>
  );
}

function Loader2(props) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
