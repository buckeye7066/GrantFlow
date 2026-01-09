import React, { useState, useEffect } from 'react';
import { fetchDiagnostics } from '@/api/adminDiagnostics';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  Check
} from 'lucide-react';

export default function AdminDiagnostics() {
  const [diagnostics, setDiagnostics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadDiagnostics = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchDiagnostics();
      setDiagnostics(data);
    } catch (err) {
      console.error('Failed to load diagnostics:', err);
      setError({
        status: err.response?.status || 500,
        message: err.response?.data?.message || err.message || 'Failed to load diagnostics',
        details: err.response?.data || err.toString(),
      });
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
      const errorText = `Status: ${error.status}\nMessage: ${error.message}\nDetails: ${JSON.stringify(error.details, null, 2)}`;
      navigator.clipboard.writeText(errorText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
        <span className="ml-3 text-slate-600">Loading diagnostics...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to Load Diagnostics</AlertTitle>
          <AlertDescription className="mt-2">
            <div className="space-y-2">
              <p><strong>Status Code:</strong> {error.status}</p>
              <p><strong>Message:</strong> {error.message}</p>
              {error.status === 403 && (
                <p className="mt-2 text-sm">
                  This endpoint is restricted to administrators only. Please contact the system administrator.
                </p>
              )}
              <div className="mt-4 flex gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleCopyError}
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
                >
                  <RefreshCw className="w-4 h-4 mr-1" />
                  Retry
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!diagnostics) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            No diagnostics data available.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const getStatusIcon = (ok) => {
    if (ok) {
      return <CheckCircle2 className="w-5 h-5 text-green-600" />;
    }
    return <XCircle className="w-5 h-5 text-red-600" />;
  };

  const getStatusBadge = (status) => {
    if (status === 'success' || status === 'completed' || status === 'up') {
      return <Badge variant="success" className="bg-green-100 text-green-800">Success</Badge>;
    }
    if (status === 'error' || status === 'failed' || status === 'down') {
      return <Badge variant="destructive">Failed</Badge>;
    }
    if (status === 'partial' || status === 'running' || status === 'degraded') {
      return <Badge variant="warning" className="bg-yellow-100 text-yellow-800">Warning</Badge>;
    }
    return <Badge variant="secondary">{status}</Badge>;
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

      {/* Application Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="w-5 h-5" />
            Application
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-slate-600">Environment</p>
              <p className="font-medium">{diagnostics.app.env}</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Version</p>
              <p className="font-medium">{diagnostics.app.version}</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Node Version</p>
              <p className="font-medium">{diagnostics.app.node_version}</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Uptime</p>
              <p className="font-medium">{Math.floor(diagnostics.app.uptime_seconds / 60)} min</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Database Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            Database
            {getStatusIcon(diagnostics.db.ok)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {diagnostics.db.ok ? (
            <>
              <div>
                <p className="text-sm text-slate-600 mb-2">Database Path</p>
                <code className="text-xs bg-slate-100 p-2 rounded block">{diagnostics.db.path}</code>
              </div>
              
              <div>
                <p className="text-sm text-slate-600 mb-2">Table Counts</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {Object.entries(diagnostics.db.tables).map(([table, count]) => (
                    <div key={table} className="bg-slate-50 p-3 rounded">
                      <p className="text-xs text-slate-600">{table}</p>
                      <p className="text-lg font-semibold">{count.toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm text-slate-600 mb-2">Schema Checks</p>
                <div className="space-y-2">
                  {Object.entries(diagnostics.db.schema_checks).map(([check, passed]) => (
                    <div key={check} className="flex items-center gap-2">
                      {passed ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-600" />
                      )}
                      <span className="text-sm">{check}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {diagnostics.db.error || 'Database connection failed'}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Environment Variables */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Environment Configuration
          </CardTitle>
          <CardDescription>
            API keys and configuration status (values hidden for security)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.entries(diagnostics.env_flags).map(([flag, present]) => (
              <div key={flag} className="flex items-center justify-between p-3 bg-slate-50 rounded">
                <span className="text-sm font-medium">{flag}</span>
                {typeof present === 'boolean' ? (
                  present ? (
                    <Badge variant="success" className="bg-green-100 text-green-800">Present</Badge>
                  ) : (
                    <Badge variant="secondary">Not Set</Badge>
                  )
                ) : (
                  <Badge variant="outline">{present}</Badge>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Last Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Last Activity
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {diagnostics.last_activity.last_crawl_log ? (
            <div className="border-l-4 border-blue-500 pl-4">
              <p className="text-sm font-medium mb-2">Last Crawl Log</p>
              <div className="space-y-1 text-sm">
                <p><span className="text-slate-600">Source:</span> {diagnostics.last_activity.last_crawl_log.source}</p>
                <p><span className="text-slate-600">Status:</span> {getStatusBadge(diagnostics.last_activity.last_crawl_log.status)}</p>
                <p><span className="text-slate-600">Time:</span> {new Date(diagnostics.last_activity.last_crawl_log.ended_at).toLocaleString()}</p>
                <p><span className="text-slate-600">Records Found:</span> {diagnostics.last_activity.last_crawl_log.records_found}</p>
                <p><span className="text-slate-600">Records Imported:</span> {diagnostics.last_activity.last_crawl_log.records_imported}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-600">No crawl logs available</p>
          )}

          {diagnostics.last_activity.last_crawler_job && (
            <div className="border-l-4 border-purple-500 pl-4">
              <p className="text-sm font-medium mb-2">Last Crawler Job</p>
              <div className="space-y-1 text-sm">
                <p><span className="text-slate-600">Type:</span> {diagnostics.last_activity.last_crawler_job.type}</p>
                <p><span className="text-slate-600">Status:</span> {getStatusBadge(diagnostics.last_activity.last_crawler_job.status)}</p>
                {diagnostics.last_activity.last_crawler_job.ended_at && (
                  <p><span className="text-slate-600">Completed:</span> {new Date(diagnostics.last_activity.last_crawler_job.ended_at).toLocaleString()}</p>
                )}
                <p><span className="text-slate-600">Result Count:</span> {diagnostics.last_activity.last_crawler_job.result_count}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Errors */}
      {diagnostics.errors && diagnostics.errors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-600" />
              Recent Errors ({diagnostics.errors.length})
            </CardTitle>
            <CardDescription>
              Errors from the last 7 days
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {diagnostics.errors.slice(0, 10).map((error, index) => (
                <Alert key={index} variant="destructive" className="border-l-4">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <div className="space-y-1">
                      <p className="font-medium">
                        {error.scope === 'crawler_job' ? `Crawler: ${error.crawler_type}` : error.source || error.scope}
                      </p>
                      <p className="text-sm">{error.message}</p>
                      <p className="text-xs text-slate-600">{new Date(error.time).toLocaleString()}</p>
                    </div>
                  </AlertDescription>
                </Alert>
              ))}
              {diagnostics.errors.length > 10 && (
                <p className="text-sm text-slate-600 text-center">
                  ... and {diagnostics.errors.length - 10} more errors
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
