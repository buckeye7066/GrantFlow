import React, { useState } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { Loader2 } from "lucide-react";

export default function AddActivityDialog({ open, onOpenChange, leadId }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [formData, setFormData] = useState({
    activity_type: "call",
    subject: "",
    description: "",
    scheduled_date: "",
    assigned_to: "",
    priority: "medium"
  });

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const createActivityMutation = useMutation({
    mutationFn: (data) => base44.entities.Activity.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activities', leadId] });
      toast({
        title: "Activity Created",
        description: "The activity has been added to the timeline.",
      });
      onOpenChange(false);
      setFormData({
        activity_type: "call",
        subject: "",
        description: "",
        scheduled_date: "",
        assigned_to: "",
        priority: "medium"
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Creation Failed",
        description: error.message || "Failed to create activity.",
      });
    }
  });

  const handleSubmit = () => {
    if (!formData.subject) {
      toast({
        variant: "destructive",
        title: "Subject Required",
        description: "Please enter a subject for the activity.",
      });
      return;
    }

    const activityData = {
      ...formData,
      lead_id: leadId,
      assigned_to: formData.assigned_to || user?.email || "",
    };

    createActivityMutation.mutate(activityData);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Schedule Activity</DialogTitle>
          <DialogDescription>
            Add a new activity or follow-up for this lead
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div>
            <Label>Activity Type</Label>
            <Select 
              value={formData.activity_type}
              onValueChange={(value) => setFormData(prev => ({ ...prev, activity_type: value }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="call">Phone Call</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="meeting">Meeting</SelectItem>
                <SelectItem value="note">Note</SelectItem>
                <SelectItem value="task">Task</SelectItem>
                <SelectItem value="proposal">Proposal</SelectItem>
                <SelectItem value="follow_up">Follow-up</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Subject *</Label>
            <Input
              value={formData.subject}
              onChange={(e) => setFormData(prev => ({ ...prev, subject: e.target.value }))}
              placeholder="e.g., Initial discovery call"
            />
          </div>

          <div>
            <Label>Description</Label>
            <Textarea
              value={formData.description}
              onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Details about the activity..."
              rows={4}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Scheduled Date/Time</Label>
              <Input
                type="datetime-local"
                value={formData.scheduled_date}
                onChange={(e) => setFormData(prev => ({ ...prev, scheduled_date: e.target.value }))}
              />
            </div>

            <div>
              <Label>Priority</Label>
              <Select 
                value={formData.priority}
                onValueChange={(value) => setFormData(prev => ({ ...prev, priority: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Assigned To</Label>
            <Input
              value={formData.assigned_to}
              onChange={(e) => setFormData(prev => ({ ...prev, assigned_to: e.target.value }))}
              placeholder={user?.email || "email@example.com"}
            />
          </div>
        </div>

        <DialogFooter>
          <Button 
            variant="outline" 
            onClick={() => onOpenChange(false)}
            disabled={createActivityMutation.isPending}
          >
            Cancel
          </Button>
          <Button 
            onClick={handleSubmit}
            disabled={createActivityMutation.isPending}
          >
            {createActivityMutation.isPending && (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            )}
            Create Activity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}