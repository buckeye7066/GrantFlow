import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { createPageUrl } from '@/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { 
  AlertCircle, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle,
  Database,
  Server,
  Activity,
  Clock,
  RefreshCw,
  Copy,
  Check,
  Key,
  ExternalLink
} from 'lucide-react';

export default function AdminDiagnostics() {
  const navigate = useNavigate();
  const [diagnostics, setDiagnostics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState(null);
  const [inspectData, setInspectData] = useState(null);
  const [inspectMeta, setInspectMeta] = useState({ title: 'Details', description: null });
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiKeyLoading, setOpenaiKeyLoading] = useState(false);
  const [openaiKeyResult, setOpenaiKeyResult] = useState(null);
  const [openaiKeyError, setOpenaiKeyError] = useState(null);
  const [envEditOpen, setEnvEditOpen] = useState(false);
  const [envEditKey, setEnvEditKey] = useState('');
  const [envEditValue, setEnvEditValue] = useState('');
  const [envEditPersist, setEnvEditPersist] = useState(false);
  const [envEditLoading, setEnvEditLoading] = useState(false);
  const [envEditError, setEnvEditError] = useState(null);
  const [envEditResult, setEnvEditResult] = useState(null);
  const [crawlerAuditLoading, setCrawlerAuditLoading] = useState(false);
  const [crawlerAuditError, setCrawlerAuditError] = useState(null);
  const [crawlerAuditResult, setCrawlerAuditResult] = useState(null);
  const [crawlerAuditLimit, setCrawlerAuditLimit] = useState(25);
  const [crawlerAuditProfileId, setCrawlerAuditProfileId] = useState('');
  const [crawlerAuditProfiles, setCrawlerAuditProfiles] = useState([]);
  const [crawlerAuditProfilesError, setCrawlerAuditProfilesError] = useState(null);
  const [crawlerAuditTimeout, setCrawlerAuditTimeout] = useState(20000);
  const [crawlerAuditMinScore, setCrawlerAuditMinScore] = useState(50);
  const [crawlerAuditItemRequest, setCrawlerAuditItemRequest] = useState('');
  const [fundingSources, setFundingSources] = useState([]);
  const [fundingSourcesError, setFundingSourcesError] = useState(null);

  const loadDiagnostics = async () => {
    try {
      setLoading(true);
      setError(null);
      // Use apiFetch as required
      const data = await apiFetch('/api/admin/diagnostics');
      setDiagnostics(data);

      try {
        const fsRes = await apiFetch('/api/admin/funding-sources');
        setFundingSources(Array.isArray(fsRes?.sources) ? fsRes.sources : []);
        setFundingSourcesError(null);
      } catch (e) {
        setFundingSources([]);
        setFundingSourcesError(e?.message || 'Failed to load funding provider status');
      }

      try {
        const profiles = await apiFetch('/api/profiles?limit=200&offset=0')
        const active = Array.isArray(profiles) ? profiles.filter((p) => (p?.status ?? 'active') === 'active') : []
        setCrawlerAuditProfiles(active)
        setCrawlerAuditProfilesError(null)
      } catch (e) {
        setCrawlerAuditProfiles([])
        setCrawlerAuditProfilesError(e?.message || 'Failed to load profiles')
      }
    } catch (err) {
      // Build comprehensive error information
      const errorInfo = {
        status: err.status || err.response?.status || 500,
        message: err.message || 'Failed to load diagnostics',
        rawResponse: err.toString()
      };
      
      // Try to get more details from response
      if (err.response) {
        try {
          errorInfo.details = await err.response.text();
        } catch (e) {
          errorInfo.details = 'Unable to read error response';
        }
      }
      
      setError(errorInfo);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadDiagnostics();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    loadDiagnostics();
  };

  const handleCopyError = () => {
    if (error) {
      const errorText = `Status: ${error.status}\nMessage: ${error.message}\nRaw Response: ${error.rawResponse}\nDetails: ${error.details || 'N/A'}`;
      navigator.clipboard.writeText(errorText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopyDiagnostics = () => {
    if (diagnostics) {
      const jsonText = JSON.stringify(diagnostics, null, 2);
      navigator.clipboard.writeText(jsonText);
      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 2000);
    }
  };

  const handleInspectError = async (entry) => {
    setInspectOpen(true);
    setInspectError(null);
    setInspectData(null);
    setInspectMeta({
      title: 'Error details',
      description: 'Inspect the underlying crawler job payload so you can fix the real root cause.',
    });

    if (!entry || entry.scope !== 'crawler_job' || !entry.job_id) {
      setInspectData(entry || null);
      return;
    }

    try {
      setInspectLoading(true);
      const job = await apiFetch(`/api/crawlers/jobs/${entry.job_id}`);
      setInspectData({ entry, job });
    } catch (err) {
      setInspectError(err?.message || 'Failed to load job details');
      setInspectData({ entry });
    } finally {
      setInspectLoading(false);
    }
  };

  const runCrawlerAudit = async () => {
    try {
      setCrawlerAuditLoading(true);
      setCrawlerAuditError(null);
      setCrawlerAuditResult(null);

      const payload = {
        profile_ids: crawlerAuditProfileId ? [crawlerAuditProfileId] : undefined,
        limit_profiles: Number(crawlerAuditLimit) || 25,
        timeout_ms: Number(crawlerAuditTimeout) || 20000,
        min_match_score: Number(crawlerAuditMinScore) || 50,
        item_request: crawlerAuditItemRequest?.trim() || null,
      };

      const data = await apiFetch('/api/admin/crawlers/audit-live', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setCrawlerAuditResult(data);
    } catch (err) {
      setCrawlerAuditError(err?.message || 'Crawler audit failed');
    } finally {
      setCrawlerAuditLoading(false);
    }
  };

  // Loading state - mandatory
  if (loading && !refreshing) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
        <span className="text-slate-600 font-medium">Fetching system diagnostics…</span>
      </div>
    );
  }

  // Error state - mandatory, never silent, fail loudly
  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert variant="destructive" className="border-red-600 bg-red-50">
          <AlertCircle className="h-5 w-5 text-red-600" />
          <AlertTitle className="text-lg font-semibold text-red-900">
            Diagnostics unavailable
          </AlertTitle>
          <AlertDescription className="mt-3 text-red-800">
            <div className="space-y-3">
              <p className="font-medium">
                Admin authorization or backend failure detected.
              </p>
              <div className="bg-red-100 p-3 rounded border border-red-200 space-y-2">
                <p><strong>Status Code:</strong> {error.status}</p>
                <p><strong>Error Message:</strong> {error.message}</p>
                {error.details && (
                  <p className="text-sm mt-2"><strong>Raw Response:</strong> {error.details}</p>
                )}
              </div>
              {error.status === 403 && (
                <p className="mt-3 text-sm font-medium">
                  ⚠️ This endpoint is restricted to administrators only. If you believe you should have access, contact the system administrator.
                </p>
              )}
              {error.status === 401 && (
                <p className="mt-3 text-sm font-medium">
                  ⚠️ Authentication failed. Please sign in again.
                </p>
              )}
              <div className="mt-4 flex gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleCopyError}
                  className="border-red-300 hover:bg-red-100"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 mr-1" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-1" />
                      Copy Details
                    </>
                  )}
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="border-red-300 hover:bg-red-100"
                >
                  <RefreshCw className={`w-4 h-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
                  Retry
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // No data state - should not happen but handle it
  if (!diagnostics) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            No diagnostics data available. Try refreshing the page.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Success state - render organized sections
  // Determine system status based on diagnostics data
  const hasRecentErrors = diagnostics.errors && diagnostics.errors.length > 0;
  const hasEmptyOpportunities = diagnostics.db?.tables?.funding_opportunities === 0;
  const dbNotOk = !diagnostics.db?.ok;
  
  // Truth rules: only show "OK" if truly ok
  let systemStatus = 'ok';
  let statusColor = 'green';
  let StatusIcon = CheckCircle2;
  
  if (dbNotOk || hasRecentErrors) {
    systemStatus = 'error';
    statusColor = 'red';
    StatusIcon = XCircle;
  } else if (hasEmptyOpportunities) {
    systemStatus = 'degraded';
    statusColor = 'amber';
    StatusIcon = AlertTriangle;
  }

  const getStatusBadge = (status) => {
    const statusMap = {
      'success': <Badge className="bg-green-100 text-green-800 border-green-300">Success</Badge>,
      'completed': <Badge className="bg-green-100 text-green-800 border-green-300">Completed</Badge>,
      'error': <Badge variant="destructive">Error</Badge>,
      'failed': <Badge variant="destructive">Failed</Badge>,
      'running': <Badge className="bg-blue-100 text-blue-800 border-blue-300">Running</Badge>,
      'partial': <Badge className="bg-amber-100 text-amber-800 border-amber-300">Partial</Badge>,
    };
    return statusMap[status] || <Badge variant="secondary">{status}</Badge>;
  };

  const getFundingStatusBadge = (source) => {
    const configured = Boolean(source?.configured)
    const required = Boolean(source?.key_required)
    const label = configured ? 'configured' : required ? 'API KEY NEEDED' : 'optional'
    const cls = configured
      ? 'bg-green-100 text-green-800 border-green-300'
      : required
        ? 'bg-red-100 text-red-800 border-red-300'
        : 'bg-slate-100 text-slate-800 border-slate-300'
    return <Badge className={cls}>{label}</Badge>
  }

  // "How do I get this key?" — surfaces the per-source setup guidance (signup
  // link + numbered steps + caveats) that the backend already returns. Shown
  // prominently when a key is missing so the owner can go get it in one click.
  const renderFundingSetup = (source) => {
    const setup = source?.setup || {}
    const configured = Boolean(source?.configured)
    const needsKey = !configured && Boolean(source?.key_required)
    const signup = setup.signup_url || source?.docs_url || null
    const steps = Array.isArray(setup.steps) ? setup.steps : []

    if (configured) {
      return <span className="text-xs text-slate-400">—</span>
    }

    // Keyless/optional sources: nothing to obtain, just note it.
    if (!needsKey && (source?.env_vars || []).length === 0) {
      return <span className="text-xs text-slate-500">No key needed</span>
    }

    return (
      <div className="space-y-2">
        {signup ? (
          <a
            href={signup}
            target="_blank"
            rel="noreferrer"
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold ${
              needsKey
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-slate-700 text-white hover:bg-slate-800'
            }`}
          >
            Get API key <ExternalLink className="w-3.5 h-3.5" />
          </a>
        ) : null}
        {Number(setup.est_minutes) > 0 ? (
          <span className="ml-2 text-xs text-slate-500">~{setup.est_minutes} min</span>
        ) : null}
        {steps.length > 0 ? (
          <details className="text-xs text-slate-700">
            <summary className="cursor-pointer text-blue-600 hover:underline">How to get it</summary>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-700">
              {steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </details>
        ) : null}
        {setup.caveats ? (
          <p className="text-xs text-amber-700">⚠ {setup.caveats}</p>
        ) : null}
      </div>
    )
  }

  const handleNavigate = (url) => {
    if (!url) return;
    navigate(url);
  };

  const tileProps = (url) => ({
    role: 'button',
    tabIndex: 0,
    onClick: () => handleNavigate(url),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleNavigate(url);
      }
    },
  });

  const openInspect = ({ title, description, data }) => {
    setInspectOpen(true);
    setInspectLoading(false);
    setInspectError(null);
    setInspectData(data ?? null);
    setInspectMeta({
      title: title || 'Details',
      description: description || null,
    });
  };

  const flagToEnvTarget = (flagKey) => {
    const k = String(flagKey || '').trim();
    if (!k) return { ok: false, reason: 'missing_key' };

    // Known multi-var flags
    if (k === 'TWILIO_configured') {
      return {
        ok: false,
        reason: 'multi_var',
        message: 'TWILIO requires both TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
      };
    }

    // Prefer canonical env keys where diagnostics supports legacy fallbacks.
    const explicitMap = {
      AUTH_PUBLIC_URL_set: 'AUTH_PUBLIC_URL',
      AUTH_FRONTEND_URL_set: 'AUTH_FRONTEND_URL',
      FROM_EMAIL_set: 'FROM_EMAIL',
      AUTH_NOTIFY_ON_LOGIN_enabled: 'AUTH_NOTIFY_ON_LOGIN',
      AUTH_NOTIFY_EMAIL_set: 'AUTH_NOTIFY_EMAIL',
      ANYA_ADMIN_TOKEN_present: 'ANYA_ADMIN_TOKEN',
      SAM_GOV_PUBLIC_API_KEY_present: 'SAM_GOV_PUBLIC_API_KEY',
    };

    const mapped = explicitMap[k];
    if (mapped) return { ok: true, envKey: mapped };

    // Generic suffix stripping.
    const suffixes = ['_present', '_set', '_enabled'];
    for (const suffix of suffixes) {
      if (k.endsWith(suffix)) {
        return { ok: true, envKey: k.slice(0, -suffix.length) };
      }
    }

    // Allow direct env var names (used by Funding provider keys table).
    // Safety is enforced by ENV_EDIT_ALLOWLIST in openEnvEditor/applyEnvVar.
    if (/^[A-Z0-9_]+$/.test(k)) {
      return { ok: true, envKey: k };
    }

    // Non-flag keys (e.g. arbitrary) - not editable here.
    return { ok: false, reason: 'not_editable', message: 'This flag is not editable from the UI.' };
  };

  const ENV_EDIT_ALLOWLIST = new Set([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'RESEND_API_KEY',
    'FROM_EMAIL',
    'AUTH_NOTIFY_ON_LOGIN',
    'AUTH_NOTIFY_EMAIL',
    'ANYA_ADMIN_TOKEN',
    'SAM_GOV_PUBLIC_API_KEY',
    'GRANTS_GOV_API_KEY',
    'SIMPLER_GRANTS_API_KEY',
    'API_DATA_GOV_KEY',
    'AUTH_PUBLIC_URL',
    'AUTH_FRONTEND_URL',
  ]);

  const ENV_SECRET_KEYS = new Set([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'RESEND_API_KEY',
    'ANYA_ADMIN_TOKEN',
    // Funding provider keys should be treated as secrets too.
    'SAM_GOV_PUBLIC_API_KEY',
    'GRANTS_GOV_API_KEY',
    'SIMPLER_GRANTS_API_KEY',
    'API_DATA_GOV_KEY',
  ]);

  const openEnvEditor = (flagKey) => {
    const target = flagToEnvTarget(flagKey);
    if (!target.ok) {
      openInspect({
        title: `Env flag: ${flagKey}`,
        description: target?.message || 'This flag cannot be edited directly. Showing details instead.',
        data: { flagKey, target },
      });
      return;
    }

    setEnvEditOpen(true);
    setEnvEditError(null);
    setEnvEditResult(null);
    setEnvEditKey(target.envKey);
    setEnvEditValue('');
    setEnvEditPersist(ENV_SECRET_KEYS.has(target.envKey));
  };

  const applyEnvVar = async () => {
    try {
      setEnvEditLoading(true);
      setEnvEditError(null);
      setEnvEditResult(null);

      const key = String(envEditKey || '').trim();
      const value = String(envEditValue ?? '');

      if (!ENV_EDIT_ALLOWLIST.has(key)) {
        throw new Error(`Editing ${key} is not allowed from the UI (safety allowlist).`);
      }

      const data = await apiFetch('/api/admin/env/apply', {
        method: 'POST',
        body: JSON.stringify({
          key,
          value,
          persist: Boolean(envEditPersist && ENV_SECRET_KEYS.has(key)),
        }),
      });
      setEnvEditResult(data);
      await loadDiagnostics();
    } catch (err) {
      setEnvEditError(err?.message || 'Failed to apply env var');
    } finally {
      setEnvEditLoading(false);
    }
  };

  const verifyProvidedOpenAIKey = async () => {
    try {
      setOpenaiKeyLoading(true);
      setOpenaiKeyError(null);
      setOpenaiKeyResult(null);
      const data = await apiFetch('/api/admin/openai/verify-key', {
        method: 'POST',
        body: JSON.stringify({ apiKey: openaiKey }),
      });
      setOpenaiKeyResult({ mode: 'verify', data });
    } catch (err) {
      setOpenaiKeyError(err?.message || 'Failed to verify key');
    } finally {
      setOpenaiKeyLoading(false);
    }
  };

  const applyProvidedOpenAIKey = async () => {
    try {
      setOpenaiKeyLoading(true);
      setOpenaiKeyError(null);
      setOpenaiKeyResult(null);
      const data = await apiFetch('/api/admin/openai/apply-key', {
        method: 'POST',
        body: JSON.stringify({ apiKey: openaiKey }),
      });
      setOpenaiKeyResult({ mode: 'apply', data });
      // Refresh diagnostics snapshot so env flags reflect the new config state.
      await loadDiagnostics();
    } catch (err) {
      setOpenaiKeyError(err?.message || 'Failed to apply key');
    } finally {
      setOpenaiKeyLoading(false);
    }
  };

  const persistCurrentOpenAIKey = async () => {
    try {
      setOpenaiKeyLoading(true);
      setOpenaiKeyError(null);
      setOpenaiKeyResult(null);
      const data = await apiFetch('/api/admin/openai/persist-current', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setOpenaiKeyResult({ mode: 'persist-current', data });
      await loadDiagnostics();
    } catch (err) {
      setOpenaiKeyError(err?.message || 'Failed to persist key');
    } finally {
      setOpenaiKeyLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">System Diagnostics</h2>
          <p className="text-sm text-slate-600 mt-1">
            Last updated: {new Date(diagnostics.timestamp).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleCopyDiagnostics}
            disabled={jsonCopied}
            variant="outline"
            size="sm"
          >
            {jsonCopied ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-2" />
                Copy Diagnostics JSON
              </>
            )}
          </Button>
          <Button
            onClick={handleRefresh}
            disabled={refreshing}
            variant="outline"
            size="sm"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* System Status - Truth-based */}
      <Card
        className={`border-2 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-300 ${
        systemStatus === 'ok'
          ? 'border-emerald-500/70 bg-emerald-50 text-slate-900 dark:border-emerald-400/50 dark:bg-emerald-950/35 dark:text-slate-50'
          : systemStatus === 'error'
            ? 'border-red-500/70 bg-red-50 text-slate-900 dark:border-red-400/50 dark:bg-red-950/35 dark:text-slate-50'
            : 'border-amber-500/70 bg-amber-50 text-slate-900 dark:border-amber-400/50 dark:bg-amber-950/35 dark:text-slate-50'
      }`}
        role="button"
        tabIndex={0}
        onClick={() =>
          openInspect({
            title: 'System diagnostics snapshot',
            description: 'Raw diagnostics payload returned by /api/admin/diagnostics.',
            data: diagnostics,
          })
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openInspect({
              title: 'System diagnostics snapshot',
              description: 'Raw diagnostics payload returned by /api/admin/diagnostics.',
              data: diagnostics,
            });
          }
        }}
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-slate-900 dark:text-slate-50">
            <Server className="w-5 h-5 text-slate-700 dark:text-slate-200" />
            <span>System Status</span>
            <StatusIcon className={`w-6 h-6 ${
              systemStatus === 'ok' ? 'text-emerald-600 dark:text-emerald-300' :
              systemStatus === 'error' ? 'text-red-600' :
              'text-amber-700 dark:text-amber-300'
            }`} />
            <Badge className={`${
              systemStatus === 'ok' ? 'bg-emerald-600' :
              systemStatus === 'error' ? 'bg-red-600' :
              'bg-amber-600'
            } text-white`}>
              {systemStatus.toUpperCase()}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-slate-900 dark:text-slate-50">
          <div className="space-y-2">
            <p className="text-sm text-slate-900 dark:text-slate-50">
              <strong>Environment:</strong> {diagnostics.app?.env || 'unknown'}
            </p>
            <p className="text-sm text-slate-900 dark:text-slate-50">
              <strong>Version:</strong> {diagnostics.app?.version || 'unknown'}
            </p>
            <p className="text-sm text-slate-900 dark:text-slate-50">
              <strong>Uptime:</strong> {Math.floor((diagnostics.app?.uptime_seconds || 0) / 60)} minutes
            </p>
            {/* Truth warnings */}
            {dbNotOk && (
              <Alert variant="destructive" className="mt-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>Database connection failed</AlertDescription>
              </Alert>
            )}
            {hasEmptyOpportunities && !dbNotOk && (
              <Alert className="mt-3 border-amber-300 bg-amber-50 dark:border-amber-400/40 dark:bg-amber-950/35">
                <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-300" />
                <AlertDescription className="text-amber-900 dark:text-amber-100">
                  <strong>Warning:</strong> No funding opportunities in database
                </AlertDescription>
              </Alert>
            )}
            {hasRecentErrors && (
              <Alert variant="destructive" className="mt-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {diagnostics.errors.length} crawler error(s) detected
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Database Counts */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            Database Counts
            {diagnostics.db?.ok ? (
              <CheckCircle2 className="w-5 h-5 text-green-600" />
            ) : (
              <XCircle className="w-5 h-5 text-red-600" />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {diagnostics.db?.ok ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              <div
                className="bg-slate-50 p-3 rounded cursor-pointer hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                {...tileProps(createPageUrl('FundingOpportunities'))}
                aria-label="View funding opportunities"
              >
                <p className="text-xs text-slate-600">funding_opportunities</p>
                <p className={`text-2xl font-bold ${diagnostics.db.tables.funding_opportunities === 0 ? 'text-amber-600' : 'text-slate-900'}`}>
                  {diagnostics.db.tables.funding_opportunities || 0}
                </p>
              </div>
              <div
                className="bg-slate-50 p-3 rounded cursor-pointer hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                {...tileProps(createPageUrl('MyProfiles'))}
                aria-label="View profiles"
              >
                <p className="text-xs text-slate-600">profiles</p>
                <p className="text-2xl font-bold text-slate-900">
                  {diagnostics.db.tables.profiles || 0}
                </p>
              </div>
              <div
                className="bg-slate-50 p-3 rounded cursor-pointer hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                {...tileProps(createPageUrl('Pipeline'))}
                aria-label="View grant pipeline"
              >
                <p className="text-xs text-slate-600">grants</p>
                <p className="text-2xl font-bold text-slate-900">
                  {diagnostics.db.tables.grants || 0}
                </p>
              </div>
              <div
                className="bg-slate-50 p-3 rounded cursor-pointer hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                {...tileProps(createPageUrl('Diagnostics'))}
                aria-label="View crawl logs diagnostics"
              >
                <p className="text-xs text-slate-600">crawl_logs</p>
                <p className="text-2xl font-bold text-slate-900">
                  {diagnostics.db.tables.crawl_logs || 0}
                </p>
              </div>
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{diagnostics.db?.error || 'Database connection failed'}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Schema Health */}
      {diagnostics.db?.schema_checks && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5" />
              Schema Health
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(diagnostics.db.schema_checks)
                .filter(([, value]) => typeof value === 'boolean')
                .map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-center gap-2 rounded px-2 py-1 cursor-pointer hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-300"
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    openInspect({
                      title: `Schema check: ${key}`,
                      description: 'Schema health checks verify expected tables/columns/constraints exist.',
                      data: {
                        key,
                        ok: value,
                        all_checks: diagnostics.db.schema_checks,
                      },
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openInspect({
                        title: `Schema check: ${key}`,
                        description: 'Schema health checks verify expected tables/columns/constraints exist.',
                        data: {
                          key,
                          ok: value,
                          all_checks: diagnostics.db.schema_checks,
                        },
                      });
                    }
                  }}
                >
                  {value ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                  )}
                  <span className="text-sm">{key}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Environment Health */}
      {diagnostics.env_flags && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="w-5 h-5" />
              Environment Health
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 rounded border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Crawler Audit (live)</p>
                  <p className="text-xs text-slate-600">
                    Runs each crawler against recent profiles and explains why results are empty (missing ZIP, not student, timeouts, etc.).
                  </p>
                </div>
                <Button size="sm" onClick={runCrawlerAudit} disabled={crawlerAuditLoading}>
                  {crawlerAuditLoading ? 'Running…' : 'Run audit'}
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Profile (optional)</p>
                  <select
                    value={crawlerAuditProfileId}
                    onChange={(e) => setCrawlerAuditProfileId(e.target.value)}
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-900 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <option value="">Recent profiles (auto)</option>
                    {(crawlerAuditProfiles || []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name || p.id}
                      </option>
                    ))}
                  </select>
                  {crawlerAuditProfilesError ? (
                    <p className="text-[11px] text-amber-700">{crawlerAuditProfilesError}</p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Timeout (ms)</p>
                  <Input
                    type="number"
                    min={1000}
                    value={crawlerAuditTimeout}
                    onChange={(e) => setCrawlerAuditTimeout(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Min score</p>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={crawlerAuditMinScore}
                    onChange={(e) => setCrawlerAuditMinScore(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {crawlerAuditProfileId ? 'Limit (ignored)' : 'Limit profiles'}
                  </p>
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    value={crawlerAuditLimit}
                    onChange={(e) => setCrawlerAuditLimit(e.target.value)}
                    disabled={Boolean(crawlerAuditProfileId)}
                  />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="space-y-1 md:col-span-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Item request (optional)</p>
                  <Input
                    placeholder="e.g., 15 passenger van"
                    value={crawlerAuditItemRequest}
                    onChange={(e) => setCrawlerAuditItemRequest(e.target.value)}
                  />
                </div>
              </div>

              {crawlerAuditError ? (
                <Alert variant="destructive" className="mt-3">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{crawlerAuditError}</AlertDescription>
                </Alert>
              ) : null}

              {crawlerAuditResult?.results ? (
                <div className="mt-3 space-y-2">
                  <div className="text-xs text-slate-600">
                    Ran {crawlerAuditResult.profiles} profile(s) • {crawlerAuditResult.crawler_types?.length || 0} crawler(s) • {crawlerAuditResult.duration_ms}ms
                  </div>
                  <div className="max-h-[260px] overflow-auto rounded bg-white border border-slate-200">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-50 border-b">
                        <tr>
                          <th className="text-left p-2">Profile</th>
                          <th className="text-left p-2">Crawler</th>
                          <th className="text-left p-2">Count</th>
                          <th className="text-left p-2">Hints</th>
                          <th className="text-left p-2">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {crawlerAuditResult.results.flatMap((row) =>
                          (row.crawlers || []).map((c) => (
                            <tr key={`${row.profile_id}-${c.crawler_type}`} className="border-b last:border-b-0">
                              <td className="p-2">
                                <div className="font-medium text-slate-900">{row.display_name}</div>
                                <div className="text-slate-500">{String(row.primary_type || '').replace(/_/g, ' ')}</div>
                              </td>
                              <td className="p-2">{c.crawler_type}</td>
                              <td className="p-2">
                                {c.count > 0 ? (
                                  <Badge className="bg-green-100 text-green-800 border-green-300">{c.count}</Badge>
                                ) : (
                                  <Badge variant="secondary">0</Badge>
                                )}
                              </td>
                              <td className="p-2 text-slate-600">{(c.hints || []).join(', ') || '—'}</td>
                              <td className="p-2 text-slate-600">{c.error || '—'}</td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mb-4 rounded border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">OpenAI Key Verifier</p>
                  <p className="text-xs text-slate-600">
                    Paste a key to verify (one-off) or apply it to the running server (no restart; not persisted).
                  </p>
                </div>
              </div>

              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  verifyProvidedOpenAIKey()
                }}
              >
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  autoComplete="off"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    type="submit"
                    disabled={openaiKeyLoading || !openaiKey.trim()}
                  >
                    {openaiKeyLoading ? 'Working…' : 'Verify key'}
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    onClick={applyProvidedOpenAIKey}
                    disabled={openaiKeyLoading || !openaiKey.trim()}
                  >
                    {openaiKeyLoading ? 'Working…' : 'Apply to server (in-memory)'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={persistCurrentOpenAIKey}
                    disabled={openaiKeyLoading}
                  >
                    {openaiKeyLoading ? 'Working…' : 'Persist current key (tonight)'}
                  </Button>
                </div>

                {openaiKeyError ? (
                  <Alert variant="destructive" className="mt-2">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{openaiKeyError}</AlertDescription>
                  </Alert>
                ) : null}

                {openaiKeyResult?.data ? (
                  <pre className="mt-2 max-h-[240px] overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">
                    {JSON.stringify(openaiKeyResult, null, 2)}
                  </pre>
                ) : null}
              </form>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {Object.entries(diagnostics.env_flags).map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-center justify-between p-3 bg-slate-50 rounded cursor-pointer hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    if (e?.shiftKey) {
                      openInspect({
                        title: `Env flag: ${key}`,
                        description:
                          'These flags indicate whether key environment variables are configured (values are not exposed).',
                        data: { key, value },
                      });
                      return;
                    }
                    openEnvEditor(key);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openEnvEditor(key);
                    }
                  }}
                >
                  <span className="text-sm font-medium truncate mr-2">{key}</span>
                  {typeof value === 'boolean' ? (
                    value ? (
                      <Badge className="bg-green-100 text-green-800 border-green-300 flex-shrink-0">Present</Badge>
                    ) : (
                      <Badge variant="secondary" className="flex-shrink-0">Not Set</Badge>
                    )
                  ) : (
                    <Badge variant="outline" className="flex-shrink-0">{value}</Badge>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Funding provider key status (safe presence only) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="w-5 h-5" />
            Funding provider keys
          </CardTitle>
        </CardHeader>
        <CardContent>
          {fundingSourcesError ? (
            <Alert className="border-amber-300 bg-amber-50 mb-4">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertTitle className="text-amber-900">Unable to load provider status</AlertTitle>
              <AlertDescription className="text-amber-800">{fundingSourcesError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Env vars</TableHead>
                  <TableHead>Get the key</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(fundingSources || []).map((src) => (
                  <TableRow key={src.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <span>{src.name}</span>
                        {src.docs_url ? (
                          <a
                            href={src.docs_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-blue-600 hover:underline"
                          >
                            docs
                          </a>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>{getFundingStatusBadge(src)}</TableCell>
                    <TableCell className="text-sm text-slate-700">
                      {(src.env_vars || []).length === 0 ? (
                        <span className="text-slate-500">none</span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {(src.env_vars || []).map((envKey) => (
                            <button
                              key={envKey}
                              type="button"
                              onClick={() => openEnvEditor(envKey)}
                              className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                              title={`Click to edit ${envKey}`}
                            >
                              {envKey}
                            </button>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="align-top">{renderFundingSetup(src)}</TableCell>
                  </TableRow>
                ))}
                {(!fundingSources || fundingSources.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-sm text-slate-600">
                      No funding providers returned.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Recent Errors */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Recent Errors
            {hasRecentErrors && (
              <Badge variant="destructive" className="ml-2">
                {diagnostics.errors.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {diagnostics.errors && diagnostics.errors.length > 0 ? (
            <div className="space-y-3">
              {diagnostics.errors.slice(0, 10).map((error, index) => (
                <Alert
                  key={index}
                  variant="destructive"
                  className={`border-l-4 ${error?.scope === 'crawler_job' && error?.job_id ? 'cursor-pointer' : ''}`}
                  onClick={() => {
                    if (error?.scope === 'crawler_job' && error?.job_id) {
                      handleInspectError(error);
                    }
                  }}
                >
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="font-medium">
                          {error.scope === 'crawler_job' ? `Crawler: ${error.crawler_type}` : 
                          error.source || error.scope}
                        </p>
                        <p className="text-sm">{error.message}</p>
                        <p className="text-xs text-slate-600">
                          {new Date(error.time).toLocaleString()}
                          {error.job_id ? ` • job ${String(error.job_id).slice(0, 8)}…` : ''}
                        </p>
                      </div>
                      {error.scope === 'crawler_job' && error.job_id && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleInspectError(error);
                          }}
                        >
                          Inspect
                        </Button>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 text-slate-600">
              <CheckCircle2 className="w-12 h-12 mx-auto mb-2 text-green-600" />
              <p className="font-medium">No recent crawl errors</p>
              <p className="text-sm">System is operating normally</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Last 10 Crawl Logs */}
      {diagnostics.last_activity?.last_10_crawl_logs && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5" />
              Last 10 Crawl Logs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {diagnostics.last_activity.last_10_crawl_logs.length > 0 ? (
              <div className="space-y-2">
                {diagnostics.last_activity.last_10_crawl_logs.map((log, index) => (
                  <div
                    key={index}
                    className="border-l-4 border-blue-500 pl-4 py-2 bg-slate-50 rounded cursor-pointer hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      openInspect({
                        title: 'Crawl log',
                        description: 'Raw crawl log row (most recent activity).',
                        data: log,
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openInspect({
                          title: 'Crawl log',
                          description: 'Raw crawl log row (most recent activity).',
                          data: log,
                        });
                      }
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-medium">{log.source}</p>
                      {getStatusBadge(log.status)}
                    </div>
                    <p className="text-xs text-slate-600">
                      {new Date(log.created_at).toLocaleString()}
                    </p>
                    <p className="text-xs text-slate-600">
                      Found: {log.records_found} | Imported: {log.records_imported}
                    </p>
                    {log.error_message && (
                      <p className="text-xs text-red-600 mt-1">Error: {log.error_message}</p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-slate-600 py-4">No crawl logs available</p>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={inspectOpen} onOpenChange={setInspectOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{inspectMeta.title}</DialogTitle>
            {inspectMeta.description ? (
              <DialogDescription>{inspectMeta.description}</DialogDescription>
            ) : null}
          </DialogHeader>

          {inspectLoading ? (
            <div className="text-sm text-slate-600">Loading…</div>
          ) : inspectError ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{inspectError}</AlertDescription>
            </Alert>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">
              {JSON.stringify(inspectData, null, 2)}
            </pre>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (inspectData) {
                  navigator.clipboard.writeText(JSON.stringify(inspectData, null, 2));
                }
              }}
              disabled={!inspectData}
            >
              Copy JSON
            </Button>
            <Button onClick={() => setInspectOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={envEditOpen} onOpenChange={setEnvEditOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Set environment variable (in-memory)</DialogTitle>
            <DialogDescription>
              Applies to the running backend process immediately. It will reset on restart unless persisted (secrets only).
              Hold <strong>Shift</strong> while clicking a flag to view details instead.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Variable</div>
              <Input value={envEditKey} readOnly />
              {!ENV_EDIT_ALLOWLIST.has(envEditKey) ? (
                <div className="text-xs text-amber-700">
                  This variable isn’t on the editable allowlist. Add it in code if you really need it.
                </div>
              ) : null}
            </div>

            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Value</div>
              <Input
                type={ENV_SECRET_KEYS.has(envEditKey) ? 'password' : 'text'}
                value={envEditValue}
                onChange={(e) => setEnvEditValue(e.target.value)}
                placeholder={ENV_SECRET_KEYS.has(envEditKey) ? '••••••••' : 'value'}
                autoComplete="off"
              />
              <div className="text-xs text-slate-600">
                Tip: use an empty value to clear the variable.
              </div>
            </div>

            {ENV_SECRET_KEYS.has(envEditKey) ? (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={Boolean(envEditPersist)}
                  onChange={(e) => setEnvEditPersist(e.target.checked)}
                />
                Persist encrypted to DB (emergency; survives restart if runtime-secret restore is enabled)
              </label>
            ) : null}

            {envEditError ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{envEditError}</AlertDescription>
              </Alert>
            ) : null}

            {envEditResult ? (
              <pre className="max-h-[240px] overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">
                {JSON.stringify(envEditResult, null, 2)}
              </pre>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEnvEditOpen(false)} disabled={envEditLoading}>
              Close
            </Button>
            <Button
              onClick={applyEnvVar}
              disabled={envEditLoading || !ENV_EDIT_ALLOWLIST.has(envEditKey)}
            >
              {envEditLoading ? 'Applying…' : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
