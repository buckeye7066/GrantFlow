import React, { useState, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Shield, Activity, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import AdminDocumentUpload from '@/components/admin/AdminDocumentUpload';
import AdminDiagnostics from '@/components/admin/AdminDiagnostics';
import { useAuthStore } from '@/stores/authStore';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/api/client';

export default function Admin() {
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.is_admin === true;
  const [diagnostics, setDiagnostics] = useState(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState(null);

  const loadDiagnostics = async () => {
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const data = await apiFetch('/api/admin/diagnostics');
      setDiagnostics(data);
    } catch (error) {
      console.error('Failed to load diagnostics:', error);
      setDiagnosticsError(error.message || 'Failed to load system diagnostics');
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      loadDiagnostics();
    }
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-2xl mx-auto">
          <Alert variant="destructive">
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              Access Denied - This area is restricted to administrators only.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Shield className="w-8 h-8 text-blue-600" />
            Admin Panel
          </h1>
          <p className="text-slate-600 mt-2">
            Administrative tools and features
          </p>
        </div>

        <Tabs defaultValue="diagnostics" className="w-full">
          <TabsList>
            <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
            <TabsTrigger value="upload">Upload Profile Document</TabsTrigger>
            <TabsTrigger value="diagnostics">
              <Activity className="w-4 h-4 mr-2" />
              Diagnostics
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="diagnostics" className="mt-6">
            <AdminDiagnostics />
          </TabsContent>
          
          <TabsContent value="upload" className="mt-6">
            <AdminDocumentUpload />
          </TabsContent>
          
          <TabsContent value="diagnostics" className="mt-6">
            {diagnosticsError ? (
              <Alert variant="destructive">
                <AlertCircle className="w-4 h-4" />
                <AlertDescription>
                  <strong>Error loading diagnostics:</strong> {diagnosticsError}
                </AlertDescription>
              </Alert>
            ) : diagnosticsLoading ? (
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-center p-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                    <span className="ml-3 text-slate-600">Loading diagnostics...</span>
                  </div>
                </CardContent>
              </Card>
            ) : diagnostics ? (
              <div className="space-y-6">
                {/* Health Status Card */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      {diagnostics.health?.status === 'healthy' ? (
                        <CheckCircle className="w-5 h-5 text-green-600" />
                      ) : diagnostics.health?.status === 'degraded' ? (
                        <AlertCircle className="w-5 h-5 text-yellow-600" />
                      ) : (
                        <XCircle className="w-5 h-5 text-red-600" />
                      )}
                      System Health: {diagnostics.health?.status?.toUpperCase() || 'UNKNOWN'}
                    </CardTitle>
                    <CardDescription>Last updated: {new Date(diagnostics.timestamp).toLocaleString()}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {diagnostics.health?.issues && diagnostics.health.issues.length > 0 ? (
                      <div className="space-y-2">
                        <p className="font-medium text-slate-700">Issues Detected:</p>
                        <ul className="list-disc list-inside space-y-1">
                          {diagnostics.health.issues.map((issue, idx) => (
                            <li key={idx} className="text-sm text-slate-600">{issue}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-green-700">✓ All systems operational</p>
                    )}
                  </CardContent>
                </Card>

                {/* Database Statistics */}
                <Card>
                  <CardHeader>
                    <CardTitle>Database Statistics</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      <div className="p-4 bg-slate-50 rounded-lg">
                        <div className="text-2xl font-bold text-blue-600">{diagnostics.counts?.funding_opportunities || 0}</div>
                        <div className="text-sm text-slate-600">Total Opportunities</div>
                      </div>
                      <div className="p-4 bg-slate-50 rounded-lg">
                        <div className="text-2xl font-bold text-green-600">{diagnostics.counts?.active_opportunities || 0}</div>
                        <div className="text-sm text-slate-600">Active Opportunities</div>
                      </div>
                      <div className="p-4 bg-slate-50 rounded-lg">
                        <div className="text-2xl font-bold text-purple-600">{diagnostics.counts?.profiles || 0}</div>
                        <div className="text-sm text-slate-600">Profiles</div>
                      </div>
                      <div className="p-4 bg-slate-50 rounded-lg">
                        <div className="text-2xl font-bold text-orange-600">{diagnostics.counts?.grants || 0}</div>
                        <div className="text-sm text-slate-600">Grants</div>
                      </div>
                      <div className="p-4 bg-slate-50 rounded-lg">
                        <div className="text-2xl font-bold text-indigo-600">{diagnostics.counts?.users || 0}</div>
                        <div className="text-sm text-slate-600">Users</div>
                      </div>
                      <div className="p-4 bg-slate-50 rounded-lg">
                        <div className="text-2xl font-bold text-slate-600">{diagnostics.counts?.crawl_logs || 0}</div>
                        <div className="text-sm text-slate-600">Crawl Logs</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Environment Configuration */}
                <Card>
                  <CardHeader>
                    <CardTitle>Environment Configuration</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between p-2 bg-slate-50 rounded">
                        <span className="text-sm font-medium">OpenAI API Key</span>
                        <span className={`text-sm ${diagnostics.environment?.hasOpenAIKey ? 'text-green-600' : 'text-red-600'}`}>
                          {diagnostics.environment?.hasOpenAIKey ? '✓ Configured' : '✗ Missing'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between p-2 bg-slate-50 rounded">
                        <span className="text-sm font-medium">Anthropic API Key</span>
                        <span className={`text-sm ${diagnostics.environment?.hasAnthropicKey ? 'text-green-600' : 'text-red-600'}`}>
                          {diagnostics.environment?.hasAnthropicKey ? '✓ Configured' : '✗ Missing'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between p-2 bg-slate-50 rounded">
                        <span className="text-sm font-medium">SAM.gov API Key</span>
                        <span className={`text-sm ${diagnostics.environment?.hasSamGovKey ? 'text-green-600' : 'text-red-600'}`}>
                          {diagnostics.environment?.hasSamGovKey ? '✓ Configured' : '✗ Missing'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between p-2 bg-slate-50 rounded">
                        <span className="text-sm font-medium">Node Environment</span>
                        <span className="text-sm text-slate-700">{diagnostics.environment?.nodeEnv || 'unknown'}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Recent Crawler Errors */}
                {diagnostics.crawlers?.recentErrors && diagnostics.crawlers.recentErrors.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <AlertCircle className="w-5 h-5 text-red-600" />
                        Recent Crawler Errors
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {diagnostics.crawlers.recentErrors.map((error, idx) => (
                          <div key={idx} className="p-3 bg-red-50 border border-red-200 rounded">
                            <div className="font-medium text-red-900">{error.crawler_type}</div>
                            <div className="text-sm text-red-700 mt-1">{error.error_message}</div>
                            <div className="text-xs text-red-600 mt-1">{new Date(error.started_at).toLocaleString()}</div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Last Crawler Runs */}
                {diagnostics.crawlers?.lastRuns && diagnostics.crawlers.lastRuns.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Recent Crawler Runs</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {diagnostics.crawlers.lastRuns.map((run, idx) => (
                          <div key={idx} className="flex items-center justify-between p-2 bg-slate-50 rounded text-sm">
                            <div>
                              <span className="font-medium">{run.crawler_type}</span>
                              <span className={`ml-2 px-2 py-1 rounded text-xs ${
                                run.status === 'completed' ? 'bg-green-100 text-green-800' :
                                run.status === 'failed' ? 'bg-red-100 text-red-800' :
                                'bg-yellow-100 text-yellow-800'
                              }`}>
                                {run.status}
                              </span>
                            </div>
                            <div className="text-slate-600">
                              {run.records_found || 0} found, {run.records_saved || 0} saved
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Server Info */}
                <Card>
                  <CardHeader>
                    <CardTitle>Server Information</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-slate-600">Uptime:</span>
                        <span className="ml-2 font-medium">{Math.floor(diagnostics.server?.uptime / 60)} minutes</span>
                      </div>
                      <div>
                        <span className="text-slate-600">Node Version:</span>
                        <span className="ml-2 font-medium">{diagnostics.server?.nodeVersion}</span>
                      </div>
                      <div>
                        <span className="text-slate-600">Memory Used:</span>
                        <span className="ml-2 font-medium">{diagnostics.server?.memory?.used} / {diagnostics.server?.memory?.total} MB</span>
                      </div>
                      <div>
                        <span className="text-slate-600">Platform:</span>
                        <span className="ml-2 font-medium">{diagnostics.server?.platform}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
