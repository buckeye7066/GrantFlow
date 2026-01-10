import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  Check,
  Key
} from 'lucide-react';

export default function AdminDiagnostics() {
  const [diagnostics, setDiagnostics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);

  const loadDiagnostics = async () => {
    try {
      setLoading(true);
      setError(null);
      // Use apiFetch as required
      const data = await apiFetch('/api/admin/diagnostics');
      setDiagnostics(data);
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
      <Card className={`border-2 ${
        systemStatus === 'ok' ? 'border-green-500 bg-green-50' : 
        systemStatus === 'error' ? 'border-red-500 bg-red-50' : 
        'border-amber-500 bg-amber-50'
      }`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <Server className="w-5 h-5" />
            <span>System Status</span>
            <StatusIcon className={`w-6 h-6 ${
              systemStatus === 'ok' ? 'text-green-600' :
              systemStatus === 'error' ? 'text-red-600' :
              'text-amber-600'
            }`} />
            <Badge className={`${
              systemStatus === 'ok' ? 'bg-green-600' :
              systemStatus === 'error' ? 'bg-red-600' :
              'bg-amber-600'
            } text-white`}>
              {systemStatus.toUpperCase()}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <p className="text-sm">
              <strong>Environment:</strong> {diagnostics.app?.env || 'unknown'}
            </p>
            <p className="text-sm">
              <strong>Version:</strong> {diagnostics.app?.version || 'unknown'}
            </p>
            <p className="text-sm">
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
              <Alert className="mt-3 border-amber-300 bg-amber-50">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-800">
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
              <div className="bg-slate-50 p-3 rounded">
                <p className="text-xs text-slate-600">funding_opportunities</p>
                <p className={`text-2xl font-bold ${diagnostics.db.tables.funding_opportunities === 0 ? 'text-amber-600' : 'text-slate-900'}`}>
                  {diagnostics.db.tables.funding_opportunities || 0}
                </p>
              </div>
              <div className="bg-slate-50 p-3 rounded">
                <p className="text-xs text-slate-600">profiles</p>
                <p className="text-2xl font-bold text-slate-900">
                  {diagnostics.db.tables.profiles || 0}
                </p>
              </div>
              <div className="bg-slate-50 p-3 rounded">
                <p className="text-xs text-slate-600">grants</p>
                <p className="text-2xl font-bold text-slate-900">
                  {diagnostics.db.tables.grants || 0}
                </p>
              </div>
              <div className="bg-slate-50 p-3 rounded">
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
              {Object.entries(diagnostics.db.schema_checks).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {Object.entries(diagnostics.env_flags).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between p-3 bg-slate-50 rounded">
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
                <Alert key={index} variant="destructive" className="border-l-4">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <div className="space-y-1">
                      <p className="font-medium">
                        {error.scope === 'crawler_job' ? `Crawler: ${error.crawler_type}` : 
                         error.source || error.scope}
                      </p>
                      <p className="text-sm">{error.message}</p>
                      <p className="text-xs text-slate-600">
                        {new Date(error.time).toLocaleString()}
                      </p>
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
                  <div key={index} className="border-l-4 border-blue-500 pl-4 py-2 bg-slate-50 rounded">
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
    </div>
  );
}
