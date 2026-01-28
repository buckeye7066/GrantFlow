import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, Clock, Server, RefreshCw, CheckCircle2, AlertCircle, HardDrive } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function AdminSystemHealth() {
  const [health, setHealth] = useState(null);
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHealth = async () => {
    try {
      setRefreshing(true);
      const [healthData, storageData] = await Promise.all([
        apiFetch('/api/admin/system-health'),
        apiFetch('/api/health/storage').catch((err) => ({ ok: false, status: 'error', error: err?.message || String(err) })),
      ]);
      setHealth(healthData);
      setStorage(storageData);
    } catch (err) {
      console.error('Failed to fetch system health', err);
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
                <div><span className="font-semibold">uploadsDir:</span> {storage?.uploadsDir || storage?.uploads_dir || 'unknown'}</div>
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
                      {formatDistanceToNow(new Date(item.last_success), { addSuffix: true })}
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
