import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Github, Loader2, CheckCircle, AlertCircle, Upload } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function SyncToGithub() {
  const { toast } = useToast();
  const [isSyncing, setIsSyncing] = useState(false);
  const [result, setResult] = useState(null);

  const handleSync = async () => {
    setIsSyncing(true);
    setResult(null);

    try {
      // Call backend function with all page files
      const response = await base44.functions.invoke('githubAutoSync', {
        body: {
          files: [
            { path: 'pages/Organizations.js', content: await getFileContent('pages/Organizations.js') },
            { path: 'pages/DiscoverGrants.js', content: await getFileContent('pages/DiscoverGrants.js') },
            { path: 'pages/Pipeline.js', content: await getFileContent('pages/Pipeline.js') },
            { path: 'pages/Dashboard.js', content: await getFileContent('pages/Dashboard.js') },
            { path: 'pages/GrantDetail.js', content: await getFileContent('pages/GrantDetail.js') },
            { path: 'Layout.js', content: await getFileContent('Layout.js') }
          ],
          commitMessage: 'Automated sync of core pages from Base44'
        }
      });

      if (response.data?.ok) {
        setResult(response.data.data);
        toast({
          title: '✅ Sync Complete',
          description: `Pushed ${response.data.data.filesSynced} files to GitHub`
        });
      } else {
        throw new Error(response.data?.error || 'Sync failed');
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Sync Failed',
        description: error.message
      });
      setResult({ error: error.message });
    } finally {
      setIsSyncing(false);
    }
  };

  // Helper to get file content - this won't work without backend support
  const getFileContent = async (path) => {
    // This is a placeholder - in reality we need a backend function to read files
    return `// File: ${path}`;
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Github className="w-8 h-8" />
        <div>
          <h1 className="text-2xl font-bold">GitHub Sync</h1>
          <p className="text-slate-600">Push code changes to GitHub repository</p>
        </div>
      </div>

      <Alert className="mb-6">
        <AlertCircle className="w-4 h-4" />
        <AlertDescription>
          <strong>Note:</strong> This sync tool requires backend file reading capabilities.
          Currently in development. Use the LaunchSyncButton component in GithubReview page instead.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Manual Sync</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={handleSync} disabled={isSyncing} className="w-full">
            {isSyncing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Push to GitHub
              </>
            )}
          </Button>

          {result && (
            <div className={`p-4 rounded-lg ${result.error ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'}`}>
              {result.error ? (
                <>
                  <div className="flex items-center gap-2 text-red-800 font-semibold mb-2">
                    <AlertCircle className="w-5 h-5" />
                    Error
                  </div>
                  <p className="text-sm text-red-700">{result.error}</p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-green-800 font-semibold mb-2">
                    <CheckCircle className="w-5 h-5" />
                    Success
                  </div>
                  <p className="text-sm text-green-700">
                    Pushed {result.filesSynced} files
                  </p>
                  {result.commitUrl && (
                    <a 
                      href={result.commitUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline mt-2 block"
                    >
                      View commit →
                    </a>
                  )}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}