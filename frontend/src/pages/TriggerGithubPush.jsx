import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Github, CheckCircle, AlertCircle, ExternalLink } from "lucide-react";
import { pushAllFunctionsToGithub } from "@/api/functions";

export default function TriggerGithubPush() {
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handlePush = async () => {
    setStatus('loading');
    setError(null);
    setResult(null);

    try {
      const response = await pushAllFunctionsToGithub({
        repo: 'buckeye7066/GrantFlow',
        branch: 'main',
        commitMessage: `Full backup - ${new Date().toISOString()}`,
        dryRun: false
      });

      if (response.data?.ok) {
        setStatus('success');
        setResult(response.data.data);
      } else {
        setStatus('error');
        setError(response.data?.error || 'Push failed');
      }
    } catch (err) {
      setStatus('error');
      setError(err.message);
    }
  };

  // Auto-trigger on mount
  useEffect(() => {
    handlePush();
  }, []);

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Github className="w-6 h-6" />
            GitHub Push
          </CardTitle>
        </CardHeader>
        <CardContent>
          {status === 'loading' && (
            <div className="flex items-center gap-3 py-8 justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              <span className="text-lg">Pushing all backend functions to GitHub...</span>
            </div>
          )}

          {status === 'success' && result && (
            <Alert className="bg-green-50 border-green-200">
              <CheckCircle className="w-5 h-5 text-green-600" />
              <AlertDescription className="text-green-800">
                <p className="font-bold text-lg mb-2">Successfully pushed to GitHub!</p>
                <p><strong>Files:</strong> {result.count || result.filesUpdated?.length || 0}</p>
                <p><strong>Branch:</strong> {result.branch}</p>
                <p><strong>Commit:</strong> <code>{result.commitSha?.slice(0, 7)}</code></p>
                {result.commitUrl && (
                  <a 
                    href={result.commitUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline mt-2"
                  >
                    View Commit <ExternalLink className="w-4 h-4" />
                  </a>
                )}
              </AlertDescription>
            </Alert>
          )}

          {status === 'error' && (
            <Alert variant="destructive">
              <AlertCircle className="w-5 h-5" />
              <AlertDescription>
                <p className="font-bold">Push Failed</p>
                <p>{error}</p>
              </AlertDescription>
            </Alert>
          )}

          {status !== 'loading' && (
            <Button onClick={handlePush} className="mt-4 w-full" disabled={status === 'loading'}>
              {status === 'success' ? 'Push Again' : 'Retry Push'}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}