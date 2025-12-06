import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar, Plus, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { toast } from 'sonner';

export default function ReportRequirements({ grant }) {
  const queryClient = useQueryClient();

  const { data: requirements } = useQuery({
    queryKey: ['requirements', grant.id],
    queryFn: () => base44.entities.ReportRequirement.filter({ grant_id: grant.id }, 'due_date')
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status }) => base44.entities.ReportRequirement.update(id, { 
      status,
      submitted_date: status === 'submitted' ? new Date().toISOString().split('T')[0] : null
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requirements'] });
      queryClient.invalidateQueries({ queryKey: ['allRequirements'] });
      toast.success('Status updated');
    }
  });

  const getDaysUntilDue = (dueDate) => {
    const due = new Date(dueDate);
    const now = new Date();
    const diffTime = due - now;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };

  const getStatusBadge = (req) => {
    if (req.status === 'submitted') {
      return <Badge className="bg-green-600"><CheckCircle2 className="w-3 h-3 mr-1" />Submitted</Badge>;
    }

    const daysUntil = getDaysUntilDue(req.due_date);
    
    if (daysUntil < 0) {
      return <Badge className="bg-red-600"><AlertCircle className="w-3 h-3 mr-1" />Overdue</Badge>;
    } else if (daysUntil <= 7) {
      return <Badge className="bg-orange-600"><Clock className="w-3 h-3 mr-1" />Due Soon</Badge>;
    } else if (daysUntil <= 30) {
      return <Badge className="bg-yellow-600"><Clock className="w-3 h-3 mr-1" />Upcoming</Badge>;
    }
    
    return <Badge variant="outline">Pending</Badge>;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="w-5 h-5 text-blue-600" />
          Report Requirements & Deadlines
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {requirements && requirements.length > 0 ? (
            requirements.map((req) => {
              const daysUntil = getDaysUntilDue(req.due_date);
              return (
                <div key={req.id} className="p-4 border border-slate-200 rounded-lg bg-white">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <h4 className="font-semibold text-slate-900">{req.report_title}</h4>
                      <p className="text-sm text-slate-600 capitalize">{req.report_type} Report</p>
                    </div>
                    {getStatusBadge(req)}
                  </div>

                  <div className="grid md:grid-cols-3 gap-4 mt-3 text-sm">
                    <div>
                      <p className="text-xs text-slate-600">Due Date</p>
                      <p className="font-semibold">{new Date(req.due_date).toLocaleDateString()}</p>
                      {daysUntil >= 0 && req.status !== 'submitted' && (
                        <p className="text-xs text-slate-500">{daysUntil} days remaining</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-slate-600">Frequency</p>
                      <p className="font-semibold capitalize">{req.frequency}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-600">Submission</p>
                      <p className="font-semibold capitalize">{req.submission_method}</p>
                    </div>
                  </div>

                  {req.required_sections && req.required_sections.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs text-slate-600 mb-1">Required Sections:</p>
                      <div className="flex flex-wrap gap-1">
                        {req.required_sections.map((section, idx) => (
                          <Badge key={idx} variant="outline" className="text-xs">{section}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {req.status !== 'submitted' && (
                    <div className="flex gap-2 mt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => updateStatusMutation.mutate({ id: req.id, status: 'in_progress' })}
                      >
                        Mark In Progress
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => updateStatusMutation.mutate({ id: req.id, status: 'submitted' })}
                      >
                        Mark Submitted
                      </Button>
                    </div>
                  )}

                  {req.submitted_date && (
                    <p className="text-xs text-green-600 mt-2">
                      Submitted on {new Date(req.submitted_date).toLocaleDateString()}
                    </p>
                  )}
                </div>
              );
            })
          ) : (
            <div className="text-center py-8 text-slate-500">
              <Calendar className="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p>No report requirements defined</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}