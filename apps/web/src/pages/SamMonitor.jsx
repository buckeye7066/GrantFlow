import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, AlertCircle, GitBranch, Code, FileCode, Play } from "lucide-react";
import { getAllFunctionCodes } from "@/api/functions";
import { pushAllFunctionsToGithub } from "@/api/functions";
import { listAllFiles } from "@/api/functions";
import { pushAllFrontendToGithub } from "@/api/functions/pushAllFrontendToGithub";
import { base44 } from "@/api/base44Client";
import { getFunctionCode } from "@/api/functions";
import { pushFileToGithub } from "@/api/functions";

export default function SamMonitor() {
  const [tasks, setTasks] = useState([
    { id: 1, name: 'Push Backend Functions', status: 'idle', progress: 0, details: null, currentItem: null },
    { id: 2, name: 'Push Frontend Files', status: 'idle', progress: 0, details: null, currentItem: null },
    { id: 3, name: 'Code Review', status: 'idle', progress: 0, details: null, currentItem: null }
  ]);

  const [isRunning, setIsRunning] = useState(false);
  const [currentTask, setCurrentTask] = useState(null);

  const startTask = async (taskId) => {
    if (taskId === 1) {
      await runBackendTask();
    } else if (taskId === 2) {
      await runFrontendTask();
    } else if (taskId === 3) {
      await runCodeReviewTask();
    }
  };

  const runBackendTask = async () => {
    updateTaskStatus(1, 'running', 20, 'Reading functions from GitHub...', null);

    try {
      // Let pushAllFunctionsToGithub fetch from GitHub as source of truth
      const backendResult = await pushAllFunctionsToGithub({
        repo: 'buckeye7066/GrantFlow',
        branch: 'main',
        commitMessage: `Sam: Backend sync - ${new Date().toISOString()}`
      });

      if (backendResult.data?.ok) {
        updateTaskStatus(1, 'completed', 100, `✓ Synced ${backendResult.data.data?.count || 0} functions\nCommit: ${backendResult.data.data?.commitSha?.slice(0,7)}`, null);
      } else {
        updateTaskStatus(1, 'error', 0, `Error: ${backendResult.data?.error || 'Unknown error'}`, null);
      }
    } catch (err) {
      updateTaskStatus(1, 'error', 0, `Error: ${err.message}`, null);
    }
  };

  const runFrontendTask = async () => {
    updateTaskStatus(2, 'running', 20, 'Frontend sync disabled - use GitHub as source', null);
    updateTaskStatus(2, 'completed', 100, 'Frontend files live in GitHub repo', null);
  };

  const runCodeReviewTask = async () => {
    updateTaskStatus(3, 'running', 20, 'Code review disabled - no file access', null);
    updateTaskStatus(3, 'completed', 100, 'Use GitHub PR reviews instead', null);
  };

  const updateTaskStatus = (taskId, status, progress, details, currentItem = null) => {
    setTasks(prev => prev.map(t => 
      t.id === taskId ? { ...t, status, progress, details, currentItem } : t
    ));
  };



  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed': return <CheckCircle className="w-5 h-5 text-green-600" />;
      case 'running': return <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />;
      case 'error': return <AlertCircle className="w-5 h-5 text-red-600" />;
      case 'idle': return <div className="w-5 h-5 rounded-full border-2 border-gray-300" />;
      default: return <div className="w-5 h-5 rounded-full border-2 border-gray-300" />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'running': return 'bg-blue-100 text-blue-800';
      case 'error': return 'bg-red-100 text-red-800';
      case 'idle': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Sam's Progress Monitor</h1>
        <p className="text-slate-600">Real-time monitoring of Sam's deployment and code review tasks</p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="w-5 h-5" />
            Current Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            {isRunning && <Loader2 className="w-5 h-5 animate-spin text-blue-600" />}
            <span className="text-lg font-medium">
              {currentTask || 'Waiting to start...'}
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {tasks.map(task => (
          <Card key={task.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {getStatusIcon(task.status)}
                  <div>
                    <h3 className="font-semibold">{task.name}</h3>
                    <p className="text-sm text-slate-600">{task.details || 'Ready to start'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={getStatusColor(task.status)}>
                    {task.status}
                  </Badge>
                  <Button
                    size="sm"
                    onClick={() => startTask(task.id)}
                    disabled={task.status === 'running'}
                    className="gap-2"
                  >
                    <Play className="w-4 h-4" />
                    Start
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Progress</span>
                  <span>{task.progress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className={`h-2 rounded-full transition-all duration-300 ${
                      task.status === 'completed' ? 'bg-green-600' :
                      task.status === 'running' ? 'bg-blue-600' :
                      task.status === 'error' ? 'bg-red-600' : 'bg-gray-300'
                    }`}
                    style={{ width: `${task.progress}%` }}
                  />
                </div>
                {task.currentItem && (
                  <div className="mt-3 p-3 bg-slate-900 rounded border border-slate-700">
                    <p className="text-xs font-bold text-amber-400 mb-2">🔍 LIVE CODE REVIEW:</p>
                    <pre className="text-sm font-mono text-green-400 whitespace-pre-wrap break-all">
                      {task.currentItem}
                    </pre>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
        </div>
        </div>
        );
        }