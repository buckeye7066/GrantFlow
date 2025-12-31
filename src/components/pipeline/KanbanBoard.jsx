import React, { useState } from 'react';
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import GrantCard from "./GrantCard";
import { Award, Eye, FileEdit, Layers, Send, Archive, XCircle, HardHat, FileBarChart, CheckCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from "@/components/ui/use-toast";


const STATUSES = [
  { value: "discovery", label: "Discovery", icon: Layers },
  { value: "discovered", label: "Discovered", icon: Layers },
  { value: "interested", label: "Assess", icon: Eye },
  { value: "auto_applied", label: "Auto-Applied", icon: CheckCircle },
  { value: "drafting", label: "Drafting", icon: FileEdit },
  { value: "application_prep", label: "Application Prep", icon: FileEdit },
  { value: "revision", label: "Revision", icon: HardHat },
  { value: "portal", label: "Portal", icon: HardHat },
  { value: "submitted", label: "Submitted", icon: Send },
  { value: "pending_review", label: "Pending Review", icon: Eye },
  { value: "follow_up", label: "Follow Up", icon: Send },
  { value: "awarded", label: "Awarded", icon: Award },
  { value: "report", label: "Reporting", icon: FileBarChart },
  { value: "declined_no_review", label: "Declined (No Review)", icon: XCircle },
  { value: "declined", label: "Declined", icon: XCircle },
  { value: "closed", label: "Closed", icon: Archive },
];

const statusColors = {
  discovery: "bg-gray-200 text-gray-800",
  discovered: "bg-slate-100 text-slate-700",
  interested: "bg-blue-100 text-blue-700",
  auto_applied: "bg-green-100 text-green-700",
  drafting: "bg-purple-100 text-purple-700",
  application_prep: "bg-yellow-100 text-yellow-700",
  revision: "bg-orange-200 text-orange-800",
  portal: "bg-orange-100 text-orange-700",
  submitted: "bg-amber-100 text-amber-700",
  pending_review: "bg-indigo-100 text-indigo-700",
  follow_up: "bg-green-100 text-green-700",
  awarded: "bg-emerald-100 text-emerald-700",
  report: "bg-teal-100 text-teal-700",
  declined_no_review: "bg-red-200 text-red-800",
  declined: "bg-red-100 text-red-700",
  closed: "bg-gray-100 text-gray-700",
};

// New function to run AI analysis and requirement extraction
const runAIAssessment = async (grant, organization) => {
    // AI Analysis
    const analysisPrompt = `Analyze this opportunity for the applicant. Return a JSON object with keys: 'eligibility_score' (0-10), 'mission_alignment_score' (0-10), 'your_advantages' (array), 'potential_weaknesses' (array), and a 'recommendation' ('highly_recommend' or 'recommend' or 'consider' or 'not_recommended').
    APPLICANT: ${JSON.stringify(organization)}
    OPPORTUNITY: ${JSON.stringify(grant)}`;
    const analysisResult = await base44.integrations.Core.InvokeLLM({
        prompt: analysisPrompt,
        response_json_schema: { type: "object", properties: { eligibility_score: {type: "number"}, mission_alignment_score: {type: "number"}, your_advantages: {type: "array", items: {type: "string"}}, potential_weaknesses: {type: "array", items: {type: "string"}}, recommendation: {type: "string"} } }
    });
    await base44.entities.AiArtifact.create({
        grant_id: grant.id,
        kind: 'analysis',
        content: JSON.stringify(analysisResult)
    });

    // Requirements Checklist
    const urlToParse = grant.nofo_url || grant.url;
    if (urlToParse) {
        const parsingPrompt = `Extract all proposal sections and required attachments from this URL: ${urlToParse}. Return a JSON object with 'proposal_sections' (array of strings) and 'required_attachments' (array of strings).`;
        const extracted = await base44.integrations.Core.InvokeLLM({
            prompt: parsingPrompt, add_context_from_internet: true,
            response_json_schema: { type: "object", properties: { proposal_sections: { type: "array", items: { type: "string" } }, required_attachments: { type: "array", items: { type: "string" } } } }
        });

        const checklistItems = [
            ...(extracted.proposal_sections || []).map(title => ({ grant_id: grant.id, title, type: 'task' })),
            ...(extracted.required_attachments || []).map(title => ({ grant_id: grant.id, title, type: 'doc' }))
        ];
        if (checklistItems.length > 0) {
            await base44.entities.ChecklistItem.bulkCreate(checklistItems);
        }
    }
};

export default function KanbanBoard({ grants, organizations, onGrantUpdate, onGrantDelete }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: checklistItems = [] } = useQuery({
    queryKey: ['checklistItems'],
    queryFn: () => base44.entities.ChecklistItem.list()
  });

  const onDragEnd = async (result) => {
    const { destination, source, draggableId } = result;
    if (!destination || (destination.droppableId === source.droppableId && destination.index === source.index)) {
      return;
    }
    const newStatus = destination.droppableId;
    onGrantUpdate(draggableId, { status: newStatus });
    
    // B5. Workflow transitions: assess.start → creates Analysis + Requirements checklist
    if (newStatus === 'discovery') {
        const grant = grants.find(g => g.id === draggableId);
        const organization = organizations.find(o => o.id === grant.organization_id);
        if (grant && organization) {
            toast({
                title: "🤖 AI Assessment Started",
                description: `Analyzing ${grant.title}...`,
            });
            try {
                await runAIAssessment(grant, organization);
                queryClient.invalidateQueries({ queryKey: ['aiArtifact', grant.id] });
                queryClient.invalidateQueries({ queryKey: ['checklistItems', grant.id] });
                queryClient.invalidateQueries({ queryKey: ['checklistItems'] });
                toast({
                    title: "✅ AI Assessment Complete",
                    description: "Checklists and analysis have been generated.",
                });
            } catch (e) {
                toast({
                    variant: "destructive",
                    title: "❌ AI Assessment Failed",
                    description: e.message,
                });
            }
        }
    }
  };

  const grantsByStatus = React.useMemo(() => {
    return STATUSES.reduce((acc, statusObj) => {
      const statusGrants = Array.isArray(grants) ? grants.filter(g => g.status === statusObj.value) : [];
      acc[statusObj.value] = statusGrants.sort((a, b) => (a.starred === b.starred) ? 0 : a.starred ? -1 : 1);
      return acc;
    }, {});
  }, [grants]);

  const handleStarToggle = (grant) => {
    onGrantUpdate(grant.id, { starred: !grant.starred });
  };
  
  const checklistProgress = React.useMemo(() => {
    const progressMap = {};
    grants.forEach(grant => {
        const items = checklistItems.filter(item => item.grant_id === grant.id);
        if (items.length === 0) {
            progressMap[grant.id] = null;
            return;
        }
        const completed = items.filter(item => item.status === 'done').length;
        progressMap[grant.id] = Math.round((completed / items.length) * 100);
    });
    return progressMap;
  }, [grants, checklistItems]);

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="overflow-x-auto pb-4">
        <div className="flex gap-4" style={{ minWidth: STATUSES.length * 300 }}>
          {STATUSES.map((status) => {
            const statusGrants = grantsByStatus[status.value] || [];
            const StatusIcon = status.icon;

            return (
              <div key={status.value} className="w-72 flex-shrink-0">
                <Card className="shadow-lg border-0 bg-slate-50/50 h-full flex flex-col">
                  <CardHeader className={`${statusColors[status.value]} p-3`}>
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <StatusIcon className="w-4 h-4" />
                      {status.label}
                      <Badge variant="secondary" className="ml-auto">
                        {statusGrants.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <Droppable droppableId={status.value}>
                    {(provided, snapshot) => (
                      <CardContent
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={`p-2 space-y-2 flex-grow min-h-[200px] transition-colors ${snapshot.isDraggingOver ? 'bg-slate-100' : ''}`}
                      >
                        {statusGrants.map((grant, index) => {
                          const organization = organizations.find(o => o.id === grant.organization_id);
                          return (
                            <Draggable key={grant.id} draggableId={grant.id} index={index}>
                              {(provided, snapshot) => (
                                <Link to={createPageUrl("GrantDetail", { id: grant.id })} className="block focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-lg">
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.draggableProps}
                                    {...provided.dragHandleProps}
                                  >
                                    <GrantCard
                                      grant={grant}
                                      organization={organization}
                                      onStatusChange={onGrantUpdate}
                                      onStarToggle={() => handleStarToggle(grant)}
                                      onDelete={() => onGrantDelete(grant)}
                                      isDragging={snapshot.isDragging}
                                      checklistProgress={checklistProgress[grant.id]}
                                    />
                                  </div>
                                </Link>
                              )}
                            </Draggable>
                          );
                        })}
                        {provided.placeholder}
                      </CardContent>
                    )}
                  </Droppable>
                </Card>
              </div>
            );
          })}
        </div>
      </div>
    </DragDropContext>
  );
}