
import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import {
  CheckCircle2,
  FileText,
  AlertCircle,
  Calendar,
  FileQuestion,
  ClipboardCheck,
  Edit,
} from "lucide-react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import client from '@/api/client';

export default function Checklist({ grantId, organizationId }) {
  const queryClient = useQueryClient();

  // The data can be `undefined` during the initial fetch.
  const { data: checklistItems } = useQuery({
    queryKey: ['checklistItems', grantId],
    queryFn: () => client.entities.ChecklistItem.filter({ grant_id: grantId }),
    enabled: !!grantId
  });

  const updateItemMutation = useMutation({
    mutationFn: ({ id, data }) => client.entities.ChecklistItem.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['checklistItems', grantId] });
      queryClient.invalidateQueries({ queryKey: ['checklistItems'] }); // Invalidate general list for progress
    },
  });

  // FIX: Use an empty array as a fallback BEFORE trying to call .filter or .reduce
  const items = checklistItems || [];
  const completed = items.filter(r => r.status === 'done').length;
  const total = items.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  const groupedItems = items.reduce((acc, req) => {
    const type = req.type || 'task';
    if (!acc[type]) acc[type] = [];
    acc[type].push(req);
    return acc;
  }, {});

  const getTypeIcon = (type) => {
    switch(type) {
      case 'doc': return FileText;
      case 'question': return FileQuestion;
      case 'task':
      default: return ClipboardCheck;
    }
  };

  const handleToggle = (item) => {
    updateItemMutation.mutate({
      id: item.id,
      data: { status: item.status === 'done' ? 'open' : 'done' }
    });
  };

  const hasQuestions = (groupedItems['question'] || []).length > 0;

  return (
    <Card className="border-0 shadow-lg">
      <CardHeader className="border-b border-slate-100">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            Application Checklist
          </CardTitle>
          <Badge variant="outline" className="text-lg px-3 py-1">
            {completed}/{total} Complete
          </Badge>
        </div>
        <Progress value={progress} className="h-2 mt-3" />
      </CardHeader>
      <CardContent className="p-6">
        {total === 0 ? (
          <div className="text-center py-8 text-slate-500">
            <ClipboardCheck className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>No checklist items yet.</p>
            <p className="text-sm mt-1">Move the card to Interested / Assessing to generate a checklist with AI.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {hasQuestions && organizationId && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-start md:items-center justify-between gap-4">
                  <div className="flex-1">
                    <h4 className="font-semibold text-blue-900 flex items-center gap-2">
                      <FileQuestion className="w-5 h-5" />
                      Action Required
                    </h4>
                    <p className="text-sm text-blue-800 mt-1">The AI needs more information. Please answer the questions below or update the applicant's profile.</p>
                  </div>
                  <Link to={createPageUrl("Organizations", { view: organizationId, grant_id: grantId })}>
                    <Button>
                      <Edit className="w-4 h-4 mr-2" />
                      Update Profile
                    </Button>
                  </Link>
                </div>
              </div>
            )}
            {Object.entries(groupedItems).map(([type, groupItems]) => {
              const Icon = getTypeIcon(type);
              const typeLabel = type.charAt(0).toUpperCase() + type.slice(1) + 's';
              return (
                <div key={type}>
                  <h4 className="font-semibold text-slate-900 flex items-center gap-2 mb-3">
                    <Icon className={`w-4 h-4 ${type === 'question' ? 'text-amber-600' : 'text-blue-600'}`} />
                    {typeLabel} ({groupItems.length})
                  </h4>
                  <div className="space-y-2">
                    {[...groupItems].sort((a, b) => (a.order || 0) - (b.order || 0)).map((item) => (
                      <div
                        key={item.id}
                        className={`p-4 rounded-lg border transition-all ${
                          item.status === 'done'
                            ? 'bg-emerald-50 border-emerald-200'
                            : type === 'question'
                            ? 'bg-amber-50 border-amber-200'
                            : 'bg-white border-slate-200 hover:border-blue-300'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={item.status === 'done'}
                            onCheckedChange={() => handleToggle(item)}
                            className="mt-1"
                          />
                          <div className="flex-1 min-w-0">
                              <h5 className={`font-medium ${item.status === 'done' ? 'text-emerald-900 line-through' : type === 'question' ? 'text-amber-900' : 'text-slate-900'}`}>
                                {item.title}
                              </h5>
                            {item.notes && (
                              <p className="text-sm text-slate-600 mt-1">{item.notes}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
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
