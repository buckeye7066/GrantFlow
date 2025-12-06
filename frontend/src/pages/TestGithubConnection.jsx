import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, XCircle, Loader2, Github } from "lucide-react";
import { testGithubConnection } from "@/api/functions";

export default function TestGithubConnection() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const runTest = async () => {
    setLoading(true);
    setResult(null);
    try {
      const response = await testGithubConnection();
      setResult(response.data);
    } catch (err) {
      setResult({ ok: false, error: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Github className="w-6 h-6" />
            GitHub Connection Test
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={runTest} disabled={loading} className="w-full">
            {loading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Testing...</>
            ) : (
              'Test GitHub Connection'
            )}
          </Button>

          {result && (
            <Alert className={result.ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}>
              {result.ok ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <XCircle className="w-4 h-4 text-red-600" />
              )}
              <AlertDescription>
                {result.ok ? (
                  <div className="text-green-800">
                    <p className="font-semibold">{result.message}</p>
                    <p className="text-sm mt-1">GitHub User: <strong>{result.githubUser}</strong></p>
                    <p className="text-xs mt-1">Token Type: {result.tokenType}</p>
                  </div>
                ) : (
                  <div className="text-red-800">
                    <p className="font-semibold">Connection Failed</p>
                    <p className="text-sm mt-1">{result.error}</p>
                    {result.tokenPreview && (
                      <p className="text-xs mt-2">Token Preview: <code>{result.tokenPreview}</code></p>
                    )}
                    {result.tokenType && (
                      <p className="text-xs">Token Type: <strong>{result.tokenType}</strong></p>
                    )}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}