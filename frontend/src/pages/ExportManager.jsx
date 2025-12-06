import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Github, Upload, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { listAllFiles } from "@/api/functions";
import { pushFileToGithub } from "@/api/functions";
import { base44 } from "@/api/base44Client";

export default function ExportManager() {
  const [repo] = useState('buckeye7066/GrantFlow');
  const [branch] = useState('main');
  const [isExporting, setIsExporting] = useState(false);
  const [exportLog, setExportLog] = useState([]);
  const [batchNumber, setBatchNumber] = useState(0);

  const readAndPushFile = async (filePath) => {
    try {
      // Use base44 internal read (won't work) - need AI to read file
      // This is a placeholder - AI assistant will manually read and push files
      setExportLog(prev => [...prev, { path: filePath, status: 'pending', message: 'AI needs to read this file' }]);
    } catch (err) {
      setExportLog(prev => [...prev, { path: filePath, status: 'error', message: err.message }]);
    }
  };

  const handleExportBatch = async (files) => {
    setIsExporting(true);
    setExportLog([]);
    setBatchNumber(prev => prev + 1);

    // AI will handle reading files and pushing them
    setExportLog([{ 
      status: 'info', 
      message: `Ready to export ${files.length} files. AI assistant will read and push each file.` 
    }]);

    setIsExporting(false);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Github className="w-8 h-8" />
        <div>
          <h1 className="text-2xl font-bold">Export Manager</h1>
          <p className="text-slate-600">Export all code to GitHub in batches</p>
        </div>
      </div>

      <Alert className="mb-6">
        <AlertCircle className="w-4 h-4" />
        <AlertDescription>
          <strong>How this works:</strong> Ask the AI assistant to export files in batches.
          Example: "Export batch 1: Layout, Dashboard, Organizations, Pipeline"
        </AlertDescription>
      </Alert>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Quick Export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-600">
            Tell me which batch to export and I'll push all files to GitHub.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Badge variant="outline" className="justify-center py-2">Batch 1: Core</Badge>
            <Badge variant="outline" className="justify-center py-2">Batch 2: Pages A</Badge>
            <Badge variant="outline" className="justify-center py-2">Batch 3: Pages B</Badge>
            <Badge variant="outline" className="justify-center py-2">Batch 4+: Components</Badge>
          </div>
          <Button 
            className="w-full" 
            onClick={() => setExportLog([{ status: 'info', message: 'Type "Export batch 1" in the chat to start!' }])}
          >
            <Upload className="w-4 h-4 mr-2" />
            Ask AI to Export (use chat)
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export Log</CardTitle>
        </CardHeader>
        <CardContent>
          {exportLog.length === 0 ? (
            <p className="text-slate-500 text-sm text-center py-8">
              No exports yet. Ask the AI to start exporting files.
            </p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {exportLog.map((log, i) => (
                <div key={i} className="flex items-start gap-2 text-sm p-2 bg-slate-50 rounded">
                  {log.status === 'pending' && <Loader2 className="w-4 h-4 animate-spin text-blue-600 flex-shrink-0" />}
                  {log.status === 'success' && <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />}
                  {log.status === 'error' && <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />}
                  {log.status === 'info' && <AlertCircle className="w-4 h-4 text-blue-600 flex-shrink-0" />}
                  <div className="flex-1">
                    {log.path && <code className="text-xs">{log.path}</code>}
                    {log.message && <p className="text-xs text-slate-600 mt-1">{log.message}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200 text-sm">
        <p className="font-semibold text-blue-900 mb-2">Instructions for AI Assistant:</p>
        <ol className="list-decimal list-inside space-y-1 text-blue-800">
          <li>Read the file content using read_file tool</li>
          <li>Call pushFileToGithub with repo="{repo}", branch="{branch}", filePath, and content</li>
          <li>Repeat for all files in the batch</li>
        </ol>
      </div>
    </div>
  );
}