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

const STAGE_TYPES = [
  { value: 'pre_application', label: 'Pre-Application Research' },
  { value: 'internal_review', label: 'Internal Review' },
  { value: 'external_review', label: 'External Review' },
  { value: 'drafting', label: 'Drafting' },
  { value: 'compliance_check', label: 'Compliance Check' },
  { value: 'approval', label: 'Approval' },
  { value: 'submission', label: 'Submission' },
  { value: 'post_submission', label: 'Post-Submission' },
  { value: 'custom', label: 'Custom Stage' }
];

export default function AddStageDialog({ open, onClose, grantId, existingStages = [] }) {
  const [formData, setFormData] = useState({
    stage_name: '',
    stage_type: 'custom',
    description: '',
    assigned_to: '',
    due_date: '',
    estimated_hours: '',
  });
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createStageMutation = useMutation({
    mutationFn: async (data) => {
      // Calculate order based on existing stages
      const maxOrder = existingStages.length > 0 
        ? Math.max(...existingStages.map(s => s.order || 0))
        : -1;
      
      return await base44.entities.WorkflowStage.create({
        ...data,
        grant_id: grantId,
        order: maxOrder + 1,
        status: 'not_started'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflowStages', grantId] });
      toast({
        title: '✅ Stage Created',
        description: 'Workflow stage has been added successfully',
      });
      handleClose();
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Failed to Create Stage',
        description: error?.message || 'An error occurred',
      });
    }
  });

  const handleClose = () => {
    setFormData({
      stage_name: '',
      stage_type: 'custom',
      description: '',
      assigned_to: '',
      due_date: '',
      estimated_hours: '',
    });
    onClose();
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!formData.stage_name.trim()) {
      toast({
        variant: 'destructive',
        title: 'Validation Error',
        description: 'Stage name is required',
      });
      return;
    }
    
    const submitData = {
      ...formData,
      estimated_hours: formData.estimated_hours ? parseFloat(formData.estimated_hours) : undefined
    };
    
    createStageMutation.mutate(submitData);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Workflow Stage</DialogTitle>
          <DialogDescription>
            Create a custom stage to track a specific phase of your grant application process
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="stage_name">Stage Name *</Label>
              <Input
                id="stage_name"
                value={formData.stage_name}
                onChange={(e) => setFormData({ ...formData, stage_name: e.target.value })}
                placeholder="e.g., Budget Development"
              />
            </div>

            <div>
              <Label htmlFor="stage_type">Stage Type</Label>
              <Select
                value={formData.stage_type}
                onValueChange={(value) => setFormData({ ...formData, stage_type: value })}
              >
                <SelectTrigger id="stage_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAGE_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
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
                placeholder="e.g., 8"
              />
            </div>

            <div className="col-span-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="What needs to be accomplished in this stage?"
                className="h-24"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={createStageMutation.isPending}>
              {createStageMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Stage'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}