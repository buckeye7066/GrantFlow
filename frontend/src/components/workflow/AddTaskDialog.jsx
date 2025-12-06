import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function AddTaskDialog({ open, onClose, stage, grantId }) {
  const [formData, setFormData] = useState({
    task_name: '',
    description: '',
    assigned_to: '',
    priority: 'medium',
    due_date: '',
    estimated_hours: '',
  });
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createTaskMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.WorkflowTask.create({
        ...data,
        stage_id: stage.id,
        grant_id: grantId,
        status: 'not_started'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflowTasks', grantId] });
      toast({
        title: '✅ Task Created',
        description: 'Task has been added to the workflow',
      });
      handleClose();
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Failed to Create Task',
        description: error?.message || 'An error occurred',
      });
    }
  });

  const handleClose = () => {
    setFormData({
      task_name: '',
      description: '',
      assigned_to: '',
      priority: 'medium',
      due_date: '',
      estimated_hours: '',
    });
    onClose();
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!formData.task_name.trim()) {
      toast({
        variant: 'destructive',
        title: 'Validation Error',
        description: 'Task name is required',
      });
      return;
    }
    
    const submitData = {
      ...formData,
      estimated_hours: formData.estimated_hours ? parseFloat(formData.estimated_hours) : undefined
    };
    
    createTaskMutation.mutate(submitData);
  };

  if (!stage) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Task to "{stage.stage_name}"</DialogTitle>
          <DialogDescription>
            Create a specific task within this workflow stage
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="task_name">Task Name *</Label>
              <Input
                id="task_name"
                value={formData.task_name}
                onChange={(e) => setFormData({ ...formData, task_name: e.target.value })}
                placeholder="e.g., Review budget calculations"
              />
            </div>

            <div>
              <Label htmlFor="priority">Priority</Label>
              <Select
                value={formData.priority}
                onValueChange={(value) => setFormData({ ...formData, priority: value })}
              >
                <SelectTrigger id="priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="due_date">Due Date</Label>
              <Input
                id="due_date"
                type="date"
                value={formData.due_date}
                onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
              />
            </div>

            <div>
              <Label htmlFor="assigned_to">Assigned To (Email)</Label>
              <Input
                id="assigned_to"
                type="email"
                value={formData.assigned_to}
                onChange={(e) => setFormData({ ...formData, assigned_to: e.target.value })}
                placeholder="user@example.com"
              />
            </div>

            <div>
              <Label htmlFor="estimated_hours">Estimated Hours</Label>
              <Input
                id="estimated_hours"
                type="number"
                step="0.5"
                min="0"
                value={formData.estimated_hours}
                onChange={(e) => setFormData({ ...formData, estimated_hours: e.target.value })}
                placeholder="e.g., 2"
              />
            </div>

            <div className="col-span-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="What needs to be done?"
                className="h-24"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={createTaskMutation.isPending}>
              {createTaskMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Task'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}