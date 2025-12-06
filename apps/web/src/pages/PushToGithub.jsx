import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import { callFunction } from '@/components/shared/functionClient';
import { 
  Upload, 
  Loader2, 
  CheckCircle, 
  XCircle, 
  FileCode,
  GitPullRequest,
  Github
} from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function PushToGithub() {
  const { toast } = useToast();
  const [isPushing, setIsPushing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [prTitle, setPrTitle] = useState('allcode');
  const [prBody, setPrBody] = useState('Complete code sync from Base44');

  const getAllCode = async () => {
    const files = [];
    
    try {
      // Get all functions via getAllFunctionCodes
      const functionsResult = await callFunction('getAllFunctionCodes', {});
      if (functionsResult.ok && functionsResult.data?.files) {
        functionsResult.data.files.forEach(f => {
          files.push({
            path: f.path,
            content: f.content
          });
        });
      }

      setProgress(30);

      // Get Layout.js via file read
      // Note: Base44 doesn't have an API to list all pages/components
      // This is a limitation - would need to implement a discovery endpoint
      
      toast({
        title: 'Note',
        description: 'Currently only backend functions can be pushed. Pages/components require manual export.',
        variant: 'default',
      });

      return files;
    } catch (error) {
      throw new Error(`Failed to gather code: ${error.message}`);
    }
  };

  const handlePush = async () => {
    setIsPushing(true);
    setProgress(0);
    setResult(null);

    try {
      // Step 1: Gather all code
      setProgress(10);
      const files = await getAllCode();

      if (files.length === 0) {
        throw new Error('No files found to push');
      }

      setProgress(50);

      // Step 2: Push to GitHub
      const pushResult = await callFunction('pushAllCodeToGithub', {
        repo: 'buckeye7066/GrantFlow',
        baseBranch: 'main',
        prTitle,
        prBody,
        files
      });

      setProgress(100);

      if (!pushResult.ok) {
        throw new Error(pushResult.error || 'Failed to push to GitHub');
      }

      setResult({
        success: true,
        ...pushResult.data
      });

      toast({
        title: '✅ Code Pushed to GitHub',
        description: `PR #${pushResult.data.prNumber} created with ${pushResult.data.count} files`,
      });

    } catch (error) {
      console.error('[PushToGithub] Error:', error);
      setResult({
        success: false,
        error: error.message
      });
      toast({
        variant: 'destructive',
        title: 'Push Failed',
        description: error.message,
      });
    } finally {
      setIsPushing(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Github className="w-8 h-8 text-slate-700" />
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Push Code to GitHub</h1>
          <p className="text-slate-600">Export all application code as a Pull Request</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitPullRequest className="w-5 h-5" />
            Pull Request Details
          </CardTitle>
          <CardDescription>
            Configure the PR title and description
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="prTitle">PR Title</Label>
            <Input
              id="prTitle"
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              placeholder="allcode"
              disabled={isPushing}
            />
          </div>
          
          <div>
            <Label htmlFor="prBody">PR Description</Label>
            <Textarea
              id="prBody"
              value={prBody}
              onChange={(e) => setPrBody(e.target.value)}
              placeholder="Complete code sync from Base44"
              rows={4}
              disabled={isPushing}
            />
          </div>

          <Alert>
            <FileCode className="h-4 w-4" />
            <AlertDescription>
              This will create a new branch and PR with all backend functions. 
              Target repo: <strong>buckeye7066/GrantFlow</strong> on branch <strong>main</strong>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {isPushing && (
        <Card>
          <CardContent className="p-6">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                <span className="font-medium">Pushing to GitHub...</span>
              </div>
              <Progress value={progress} className="h-2" />
              <p className="text-sm text-slate-600">
                {progress < 30 ? 'Gathering function files...' :
                 progress < 60 ? 'Creating GitHub blobs...' :
                 progress < 90 ? 'Creating commit and PR...' :
                 'Finalizing...'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className={result.success ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'}>
          <CardContent className="p-6">
            {result.success ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-6 h-6 text-green-600" />
                  <div>
                    <h3 className="font-semibold text-green-900">Successfully Pushed to GitHub!</h3>
                    <p className="text-sm text-green-700">
                      PR #{result.prNumber} created with {result.count} files
                    </p>
                  </div>
                </div>
                
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-green-800 font-medium">Branch: </span>
                    <code className="bg-white px-2 py-1 rounded">{result.branch}</code>
                  </div>
                  <div>
                    <span className="text-green-800 font-medium">Commit: </span>
                    <code className="bg-white px-2 py-1 rounded text-xs">{result.commitSha?.slice(0, 7)}</code>
                  </div>
                  <div>
                    <a 
                      href={result.prUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-700 underline"
                    >
                      View Pull Request →
                    </a>
                  </div>
                </div>

                {result.errors && result.errors.length > 0 && (
                  <Alert className="bg-amber-50 border-amber-300">
                    <AlertDescription className="text-amber-900">
                      <strong>Warnings:</strong> {result.errors.length} files had issues
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <XCircle className="w-6 h-6 text-red-600 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-red-900">Push Failed</h3>
                  <p className="text-sm text-red-700 mt-1">{result.error}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button
          onClick={handlePush}
          disabled={isPushing || !prTitle.trim()}
          size="lg"
          className="bg-blue-600 hover:bg-blue-700"
        >
          {isPushing ? (
            <>
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              Pushing...
            </>
          ) : (
            <>
              <Upload className="w-5 h-5 mr-2" />
              Push to GitHub
            </>
          )}
        </Button>
      </div>
    </div>
  );
}