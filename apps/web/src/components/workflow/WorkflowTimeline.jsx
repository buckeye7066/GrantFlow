import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatDateSafe, parseDateSafe } from '@/components/shared/dateUtils';
import { differenceInDays } from 'date-fns';
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertTriangle,
  PlayCircle,
  Plus,
  User,
  Calendar,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

const getStatusIcon = (status) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-5 h-5 text-green-600" />;
    case 'in_progress':
      return <PlayCircle className="w-5 h-5 text-blue-600" />;
    case 'blocked':
      return <AlertTriangle className="w-5 h-5 text-red-600" />;
    case 'skipped':
      return <Circle className="w-5 h-5 text-gray-400" />;
    default:
      return <Circle className="w-5 h-5 text-slate-300" />;
  }
};

const getStatusColor = (status) => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800 border-green-300';
    case 'in_progress':
      return 'bg-blue-100 text-blue-800 border-blue-300';
    case 'blocked':
      return 'bg-red-100 text-red-800 border-red-300';
    case 'skipped':
      return 'bg-gray-100 text-gray-800 border-gray-300';
    default:
      return 'bg-slate-100 text-slate-800 border-slate-300';
  }
};

const getDueDateColor = (dueDate, status) => {
  if (status === 'completed') return 'text-green-600';
  if (!dueDate) return 'text-slate-500';
  
  const date = parseDateSafe(dueDate);
  if (!date) return 'text-slate-500';
  
  const daysLeft = differenceInDays(date, new Date());
  
  if (daysLeft < 0) return 'text-red-600 font-semibold';
  if (daysLeft <= 3) return 'text-red-600';
  if (daysLeft <= 7) return 'text-amber-600';
  return 'text-slate-600';
};

export default function WorkflowTimeline({ stages, tasks, grant, onAddStage, onEditStage, onAddTask }) {
  const [expandedStages, setExpandedStages] = useState(new Set());
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateStageMutation = useMutation({
    mutationFn: ({ stageId, data }) => base44.entities.WorkflowStage.update(stageId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflowStages', grant.id] });
      toast({
        title: '✅ Stage Updated',
        description: 'Workflow stage has been updated',
      });
    },
  });

  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, data }) => base44.entities.WorkflowTask.update(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflowTasks', grant.id] });
      toast({
        title: '✅ Task Updated',
        description: 'Task has been updated',
      });
    },
  });

  const toggleStageExpanded = (stageId) => {
    const newExpanded = new Set(expandedStages);
    if (newExpanded.has(stageId)) {
      newExpanded.delete(stageId);
    } else {
      newExpanded.add(stageId);
    }
    setExpandedStages(newExpanded);
  };

  const handleStageStatusChange = (stage, newStatus) => {
    const updates = { status: newStatus };
    
    if (newStatus === 'in_progress' && !stage.start_date) {
      updates.start_date = new Date().toISOString().split('T')[0];
    }
    
    if (newStatus === 'completed' && !stage.completed_date) {
      updates.completed_date = new Date().toISOString().split('T')[0];
    }
    
    updateStageMutation.mutate({ stageId: stage.id, data: updates });
  };

  const handleTaskStatusChange = (task, newStatus) => {
    const updates = { status: newStatus };
    
    if (newStatus === 'completed' && !task.completed_date) {
      updates.completed_date = new Date().toISOString().split('T')[0];
    }
    
    updateTaskMutation.mutate({ taskId: task.id, data: updates });
  };

  // Calculate progress
  const completedStages = stages.filter(s => s.status === 'completed').length;
  const totalStages = stages.length;
  const progressPercent = totalStages > 0 ? (completedStages / totalStages) * 100 : 0;

  // Group tasks by stage
  const tasksByStage = tasks.reduce((acc, task) => {
    if (!acc[task.stage_id]) acc[task.stage_id] = [];
    acc[task.stage_id].push(task);
    return acc;
  }, {});

  return (
    <Card className="shadow-lg border-0">
      <CardHeader className="border-b border-slate-100">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-600" />
            Application Workflow
          </CardTitle>
          <Button onClick={onAddStage} size="sm" variant="outline">
            <Plus className="w-4 h-4 mr-2" />
            Add Stage
          </Button>
        </div>
        
        {/* Overall Progress */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-sm text-slate-600 mb-2">
            <span>Overall Progress</span>
            <span className="font-semibold">{completedStages} of {totalStages} stages completed</span>
          </div>
          <Progress value={progressPercent} className="h-2" />
        </div>
      </CardHeader>

      <CardContent className="p-6">
        {stages.length === 0 ? (
          <div className="text-center py-12">
            <Clock className="w-12 h-12 mx-auto text-slate-300 mb-4" />
            <h3 className="text-lg font-semibold text-slate-900 mb-2">No Workflow Stages</h3>
            <p className="text-slate-600 mb-4">Create custom stages to track your grant application process</p>
            <Button onClick={onAddStage}>
              <Plus className="w-4 h-4 mr-2" />
              Add First Stage
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {stages.map((stage, index) => {
              const stageTasks = tasksByStage[stage.id] || [];
              const completedTasks = stageTasks.filter(t => t.status === 'completed').length;
              const isExpanded = expandedStages.has(stage.id);
              
              return (
                <div
                  key={stage.id}
                  className={`border-l-4 rounded-lg ${
                    stage.status === 'completed' ? 'border-l-green-500 bg-green-50' :
                    stage.status === 'in_progress' ? 'border-l-blue-500 bg-blue-50' :
                    stage.status === 'blocked' ? 'border-l-red-500 bg-red-50' :
                    'border-l-slate-300 bg-white'
                  } transition-all`}
                >
                  <div className="p-4">
                    {/* Stage Header */}
                    <div className="flex items-start gap-3">
                      <div className="mt-1">
                        {getStatusIcon(stage.status)}
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-4 mb-2">
                          <div className="flex-1">
                            <h4 className="font-semibold text-slate-900 text-lg">
                              {index + 1}. {stage.stage_name}
                            </h4>
                            {stage.description && (
                              <p className="text-sm text-slate-600 mt-1">{stage.description}</p>
                            )}
                          </div>
                          
                          <Badge className={getStatusColor(stage.status)}>
                            {stage.status.replace('_', ' ')}
                          </Badge>
                        </div>

                        {/* Stage Metadata */}
                        <div className="flex flex-wrap gap-4 text-sm text-slate-600 mb-3">
                          {stage.assigned_to && (
                            <span className="flex items-center gap-1">
                              <User className="w-4 h-4" />
                              {stage.assigned_to}
                            </span>
                          )}
                          
                          {stage.due_date && (
                            <span className={`flex items-center gap-1 ${getDueDateColor(stage.due_date, stage.status)}`}>
                              <Calendar className="w-4 h-4" />
                              Due: {formatDateSafe(stage.due_date, 'MMM d, yyyy')}
                              {stage.status !== 'completed' && parseDateSafe(stage.due_date) && (
                                <span className="ml-1">
                                  ({differenceInDays(parseDateSafe(stage.due_date), new Date())} days)
                                </span>
                              )}
                            </span>
                          )}
                          
                          {stageTasks.length > 0 && (
                            <span>
                              {completedTasks}/{stageTasks.length} tasks completed
                            </span>
                          )}
                        </div>

                        {/* Stage Actions */}
                        <div className="flex gap-2">
                          {stage.status === 'not_started' && (
                            <Button
                              size="sm"
                              onClick={() => handleStageStatusChange(stage, 'in_progress')}
                            >
                              Start Stage
                            </Button>
                          )}
                          
                          {stage.status === 'in_progress' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleStageStatusChange(stage, 'completed')}
                            >
                              Mark Complete
                            </Button>
                          )}
                          
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleStageExpanded(stage.id)}
                          >
                            {isExpanded ? (
                              <>
                                <ChevronDown className="w-4 h-4 mr-1" />
                                Hide Tasks
                              </>
                            ) : (
                              <>
                                <ChevronRight className="w-4 h-4 mr-1" />
                                View Tasks ({stageTasks.length})
                              </>
                            )}
                          </Button>
                          
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onAddTask(stage)}
                          >
                            <Plus className="w-4 h-4 mr-1" />
                            Add Task
                          </Button>
                        </div>

                        {/* Tasks List */}
                        {isExpanded && stageTasks.length > 0 && (
                          <div className="mt-4 space-y-2 pl-4 border-l-2 border-slate-200">
                            {stageTasks.map(task => (
                              <div
                                key={task.id}
                                className="flex items-start gap-3 p-3 bg-white rounded-lg border border-slate-200"
                              >
                                <input
                                  type="checkbox"
                                  checked={task.status === 'completed'}
                                  onChange={(e) => handleTaskStatusChange(
                                    task,
                                    e.target.checked ? 'completed' : 'not_started'
                                  )}
                                  className="mt-1 h-4 w-4 rounded border-slate-300"
                                />
                                
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className={`font-medium ${
                                      task.status === 'completed' ? 'line-through text-slate-500' : 'text-slate-900'
                                    }`}>
                                      {task.task_name}
                                    </span>
                                    
                                    {task.priority !== 'medium' && (
                                      <Badge
                                        variant="outline"
                                        className={
                                          task.priority === 'critical' ? 'border-red-300 text-red-700' :
                                          task.priority === 'high' ? 'border-orange-300 text-orange-700' :
                                          'border-blue-300 text-blue-700'
                                        }
                                      >
                                        {task.priority}
                                      </Badge>
                                    )}
                                  </div>
                                  
                                  <div className="flex gap-3 text-xs text-slate-500">
                                    {task.assigned_to && <span>Assigned to: {task.assigned_to}</span>}
                                    {task.due_date && (
                                      <span className={getDueDateColor(task.due_date, task.status)}>
                                        Due: {formatDateSafe(task.due_date, 'MMM d')}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}