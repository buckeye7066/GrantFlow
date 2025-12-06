import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import {
  Phone,
  Mail,
  Calendar,
  MessageSquare,
  FileText,
  CheckCircle2,
  Clock,
  AlertCircle
} from "lucide-react";
import { format } from "date-fns";

const ACTIVITY_ICONS = {
  call: Phone,
  email: Mail,
  meeting: Calendar,
  note: MessageSquare,
  task: CheckCircle2,
  proposal: FileText,
  follow_up: Clock,
};

const ACTIVITY_COLORS = {
  call: "text-blue-600 bg-blue-50",
  email: "text-purple-600 bg-purple-50",
  meeting: "text-green-600 bg-green-50",
  note: "text-slate-600 bg-slate-50",
  task: "text-orange-600 bg-orange-50",
  proposal: "text-indigo-600 bg-indigo-50",
  follow_up: "text-amber-600 bg-amber-50",
};

export default function ActivityTimeline({ activities, leadId }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const toggleCompleteMutation = useMutation({
    mutationFn: ({ id, completed }) => 
      base44.entities.Activity.update(id, { 
        completed,
        completed_date: completed ? new Date().toISOString() : null
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activities', leadId] });
      toast({
        title: "Activity Updated",
        description: "Status has been changed.",
      });
    },
  });

  if (activities.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        <AlertCircle className="w-12 h-12 mx-auto mb-3 text-slate-300" />
        <p>No activities yet. Add your first activity to start tracking interactions.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {activities.map((activity, index) => {
        const Icon = ACTIVITY_ICONS[activity.activity_type] || MessageSquare;
        const colorClass = ACTIVITY_COLORS[activity.activity_type] || ACTIVITY_COLORS.note;
        const isOverdue = !activity.completed && 
          activity.scheduled_date && 
          new Date(activity.scheduled_date) < new Date();

        return (
          <div key={activity.id} className="flex gap-4">
            {/* Timeline Line */}
            <div className="flex flex-col items-center">
              <div className={`w-10 h-10 rounded-full ${colorClass} flex items-center justify-center`}>
                <Icon className="w-5 h-5" />
              </div>
              {index < activities.length - 1 && (
                <div className="w-0.5 h-full bg-slate-200 mt-2" />
              )}
            </div>

            {/* Activity Content */}
            <div className="flex-1 pb-8">
              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h4 className="font-semibold text-slate-900">{activity.subject}</h4>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="outline" className="text-xs">
                        {activity.activity_type}
                      </Badge>
                      {activity.completed ? (
                        <Badge className="bg-green-100 text-green-800 text-xs">
                          Completed
                        </Badge>
                      ) : isOverdue ? (
                        <Badge className="bg-red-100 text-red-800 text-xs">
                          Overdue
                        </Badge>
                      ) : (
                        <Badge className="bg-blue-100 text-blue-800 text-xs">
                          Pending
                        </Badge>
                      )}
                    </div>
                  </div>

                  {!activity.completed && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggleCompleteMutation.mutate({ 
                        id: activity.id, 
                        completed: true 
                      })}
                      disabled={toggleCompleteMutation.isPending}
                    >
                      Mark Complete
                    </Button>
                  )}
                </div>

                {activity.description && (
                  <p className="text-sm text-slate-600 mb-2">{activity.description}</p>
                )}

                <div className="flex items-center gap-4 text-xs text-slate-500 mt-3">
                  {activity.scheduled_date && (
                    <span>
                      Scheduled: {format(new Date(activity.scheduled_date), 'MMM d, yyyy h:mm a')}
                    </span>
                  )}
                  {activity.completed_date && (
                    <span>
                      Completed: {format(new Date(activity.completed_date), 'MMM d, yyyy h:mm a')}
                    </span>
                  )}
                  {activity.assigned_to && (
                    <span>Assigned to: {activity.assigned_to}</span>
                  )}
                </div>

                {activity.outcome && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <p className="text-sm text-slate-700">
                      <span className="font-semibold">Outcome:</span> {activity.outcome}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}