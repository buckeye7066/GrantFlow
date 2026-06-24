import React, { useState, useRef, useEffect, useCallback } from 'react';
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import GrantCard from "./GrantCard";
import { Award, Eye, FileEdit, Layers, Send, Archive, XCircle, HardHat, FileBarChart, Bookmark, FolderOpen } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { useToast } from "@/components/ui/use-toast";
import { canonicalStage } from '../../../shared/pipelineStages.js';

// Shared column width constant so the slider math matches the rendered layout.
// Columns render as w-72 (288px) + gap-4 (16px) = 304px.
const COLUMN_WIDTH = 304;

// RC-13: one canonical 11-stage pipeline. Legacy stage names that come back
// from the API (e.g. `auto_applied`, `pending_review`, `under_review`,
// `closed`, `app_prep`, etc.) are mapped to canonical buckets via
// `canonicalStage()` from the shared module. Anything that doesn't map
// cleanly lands in the synthetic "other" column so users always see 100%
// of the rows the backend returned (no silent drops).
const STATUSES = [
  { value: "discovered", label: "Discovered", icon: Layers },
  { value: "saved", label: "Saved", icon: Bookmark },
  { value: "interested", label: "Interested", icon: Eye },
  { value: "gathering_documents", label: "Gathering Documents", icon: FolderOpen },
  { value: "drafting", label: "Drafting", icon: FileEdit },
  { value: "ready_to_submit", label: "Ready to Submit", icon: HardHat },
  { value: "submitted", label: "Submitted", icon: Send },
  { value: "follow_up", label: "Follow Up", icon: FileBarChart },
  { value: "awarded", label: "Awarded", icon: Award },
  { value: "declined", label: "Declined", icon: XCircle },
  { value: "archived", label: "Archived", icon: Archive },
  // Synthetic fallback. Hidden when empty, never accepts drops (read-only).
  { value: "other", label: "Other / Unknown", icon: Archive },
];

// Funding Current status language for the column headers.
const statusColors = {
  discovered: "bg-current-emeraldSoft text-current-emerald",
  saved: "bg-current-emeraldSoft text-current-emerald",
  interested: "bg-current-emeraldSoft text-current-emerald",
  gathering_documents: "bg-current-emeraldSoft text-current-emerald",
  drafting: "bg-current-emeraldSoft text-current-emerald",
  ready_to_submit: "bg-current-emeraldSoft text-current-emerald",
  submitted: "bg-current-paper text-current-ink",
  follow_up: "bg-current-paper text-current-ink",
  awarded: "bg-current-amberSoft text-[#a76a16]",
  declined: "bg-current-coralSoft text-[#9a3320]",
  archived: "bg-current-paper text-current-ink/70",
  other: "bg-current-paper text-current-ink/70",
};

function PipelineSlider({ scrollRef }) {
  const [sliderValue, setSliderValue] = useState(0);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 3 });

  const updateVisibleRange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const colWidth = COLUMN_WIDTH;
    const startCol = Math.floor(el.scrollLeft / colWidth);
    const visibleCols = Math.floor(el.clientWidth / colWidth);
    setVisibleRange({
      start: startCol,
      end: Math.min(startCol + visibleCols, STATUSES.length - 1),
    });
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let rafId = null;
    const handleScroll = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        // Read DOM dimensions once inside the rAF callback to avoid layout
        // thrashing on every scroll tick.
        const scrollWidth = el.scrollWidth;
        const clientWidth = el.clientWidth;
        const maxScroll = scrollWidth - clientWidth;
        if (maxScroll > 0) {
          setSliderValue((el.scrollLeft / maxScroll) * 100);
        }
        updateVisibleRange();
      });
    };
    el.addEventListener('scroll', handleScroll);
    updateVisibleRange();
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [scrollRef, updateVisibleRange]);

  const handleSliderChange = (e) => {
    const val = Number(e.target.value);
    setSliderValue(val);
    const el = scrollRef.current;
    if (el) {
      const maxScroll = el.scrollWidth - el.clientWidth;
      el.scrollLeft = (val / 100) * maxScroll;
    }
  };

  const startLabel = STATUSES[visibleRange.start]?.label || '';
  const endLabel = STATUSES[visibleRange.end]?.label || '';

  return (
    <div className="mb-3 flex items-center gap-3 rounded-xl border border-current-line bg-current-card px-3 py-2">
      <span className="money whitespace-nowrap text-xs font-bold uppercase tracking-[0.1em] text-current-ink/55">Pipeline Slider</span>
      <input
        type="range"
        min="0"
        max="100"
        value={sliderValue}
        onChange={handleSliderChange}
        className="h-2 flex-1 cursor-pointer accent-current-emerald"
      />
      <span className="money min-w-[160px] whitespace-nowrap text-right text-xs text-current-ink/55">
        Showing: {startLabel} &rarr; {endLabel}
      </span>
    </div>
  );
}

const runAIAssessment = async (grant, organization) => {
  if (!grant || !organization) {
    throw new Error('Missing grant or organization data for AI assessment.');
  }

  const analysisPrompt = `Analyze this opportunity for the applicant. Return a JSON object with keys: 'eligibility_score' (0-10), 'mission_alignment_score' (0-10), 'your_advantages' (array), 'potential_weaknesses' (array), and a 'recommendation' ('highly_recommend' or 'recommend' or 'consider' or 'not_recommended').
  APPLICANT: ${JSON.stringify(organization)}
  OPPORTUNITY: ${JSON.stringify(grant)}`;

  const analysisResult = await client.integrations.Core.InvokeLLM({
    prompt: analysisPrompt,
    response_json_schema: {
      type: "object",
      properties: {
        eligibility_score: { type: "number" },
        mission_alignment_score: { type: "number" },
        your_advantages: { type: "array", items: { type: "string" } },
        potential_weaknesses: { type: "array", items: { type: "string" } },
        recommendation: { type: "string" },
      },
    },
  });

  // Validate the LLM actually returned a usable object before persisting it.
  if (!analysisResult || typeof analysisResult !== 'object' || Array.isArray(analysisResult)) {
    throw new Error('AI assessment returned an unexpected response.');
  }

  await client.entities.AiArtifact.create({
    grant_id: grant.id,
    kind: 'analysis',
    content: JSON.stringify(analysisResult),
  });

  const urlToParse = grant.nofo_url || grant.url;
  if (urlToParse) {
    const parsingPrompt = `Extract all proposal sections and required attachments from this URL: ${urlToParse}. Return a JSON object with 'proposal_sections' (array of strings) and 'required_attachments' (array of strings).`;
    const extracted = await client.integrations.Core.InvokeLLM({
      prompt: parsingPrompt,
      add_context_from_internet: true,
      response_json_schema: {
        type: "object",
        properties: {
          proposal_sections: { type: "array", items: { type: "string" } },
          required_attachments: { type: "array", items: { type: "string" } },
        },
      },
    });

    const safeExtracted = (extracted && typeof extracted === 'object' && !Array.isArray(extracted))
      ? extracted
      : {};
    const proposalSections = Array.isArray(safeExtracted.proposal_sections) ? safeExtracted.proposal_sections : [];
    const requiredAttachments = Array.isArray(safeExtracted.required_attachments) ? safeExtracted.required_attachments : [];

    const checklistItems = [
      ...proposalSections.map(title => ({ grant_id: grant.id, title, type: 'task' })),
      ...requiredAttachments.map(title => ({ grant_id: grant.id, title, type: 'doc' })),
    ];
    if (checklistItems.length > 0) {
      await client.entities.ChecklistItem.bulkCreate(checklistItems);
    }
  }
};

export default function KanbanBoard({ grants, organizations, onGrantUpdate, onGrantDelete }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const scrollRef = useRef(null);

  const { data: checklistItems = [] } = useQuery({
    queryKey: ['checklistItems'],
    queryFn: () => client.entities.ChecklistItem.list(),
  });

  const onDragEnd = async (result) => {
    const { destination, source, draggableId } = result;
    if (!destination || (destination.droppableId === source.droppableId && destination.index === source.index)) {
      return;
    }
    const newStatus = destination.droppableId;
    if (newStatus === 'other') {
      // The "Other / Unknown" column is a UI fallback for legacy/unknown
      // statuses; it is not a writable stage. Reject the drop so the user
      // doesn't accidentally persist an invalid status.
      toast({
        variant: 'destructive',
        title: 'Cannot drop here',
        description: '"Other / Unknown" is a read-only column for legacy grants. Drag the card into a real stage instead.',
      });
      return;
    }

    // Capture the grant/organization references up front so the async AI flow
    // doesn't operate on a stale array after a refetch.
    const grant = Array.isArray(grants) ? grants.find(g => g.id === draggableId) : undefined;
    const organization = grant && Array.isArray(organizations)
      ? organizations.find(o => o.id === grant.organization_id)
      : undefined;

    // Await/handle the status update so failures surface instead of being
    // silently ignored.
    try {
      await onGrantUpdate(draggableId, { status: newStatus });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Update Failed', description: e?.message || 'Could not update grant status.' });
      return;
    }

    // Trigger AI assessment when a grant enters the "interested" stage \of the legacy "Assess" / "Discovery" column.
    if (newStatus === 'interested') {
      if (!grant) return;
      if (grant && organization) {
        toast({ title: "AI Assessment Started", description: `Analyzing ${grant.title}...` });
        try {
          await runAIAssessment(grant, organization);
          queryClient.invalidateQueries({ queryKey: ['aiArtifact'] });
          queryClient.invalidateQueries({ queryKey: ['aiArtifact', grant.id] });
          queryClient.invalidateQueries({ queryKey: ['checklistItems'] });
          queryClient.invalidateQueries({ queryKey: ['checklistItems', grant.id] });
          toast({ title: "AI Assessment Complete", description: "Checklists and analysis have been generated." });
        } catch (e) {
          toast({ variant: "destructive", title: "AI Assessment Failed", description: e?.message });
        }
      }
    }
  };

  const grantsByStatus = React.useMemo(() => {
    // Bucket grants by canonical stage, mapping legacy / unknown values via
    // shared/pipelineStages.canonicalStage(). Anything that maps to null
    // lands in the "other" bucket so the column count always equals the
    // number of grants the API returned.
    const acc = {};
    for (const s of STATUSES) acc[s.value] = [];
    if (!Array.isArray(grants)) return acc;
    for (const g of grants) {
      const canon = canonicalStage(g?.status);
      const bucket = canon && acc[canon] ? canon : 'other';
      acc[bucket].push(g);
    }
    for (const key of Object.keys(acc)) {
      acc[key].sort((a, b) => {
        const as = !!a.starred;
        const bs = !!b.starred;
        return as === bs ? 0 : as ? -1 : 1;
      });
    }
    return acc;
  }, [grants]);

  const handleStarToggle = (grant) => {
    onGrantUpdate(grant.id, { starred: !grant.starred });
  };

  const checklistProgress = React.useMemo(() => {
    const progressMap = {};
    (Array.isArray(grants) ? grants : []).forEach(grant => {
      const items = checklistItems.filter(item => item.grant_id === grant.id);
      if (items.length === 0) { progressMap[grant.id] = null; return; }
      const completed = items.filter(item => item.status === 'done').length;
      progressMap[grant.id] = Math.round((completed / items.length) * 100);
    });
    return progressMap;
  }, [grants, checklistItems]);

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <PipelineSlider scrollRef={scrollRef} />
      <div className="overflow-x-auto pb-4" ref={scrollRef}>
        <div className="flex gap-4" style={{ minWidth: STATUSES.length * COLUMN_WIDTH }}>
          {STATUSES.map((status) => {
            const statusGrants = grantsByStatus[status.value] || [];
            // Hide the "other" column when there's nothing in it so the UI
            // stays clean for users who never had legacy data.
            if (status.value === 'other' && statusGrants.length === 0) return null;
            const StatusIcon = status.icon;
            return (
              <div key={status.value} className="w-72 flex-shrink-0">
                <Card className="flex h-full flex-col border border-current-line bg-current-card shadow-sm">
                  <CardHeader className={`${statusColors[status.value]} rounded-t-xl p-3`}>
                    <CardTitle className="flex items-center gap-2 font-display text-sm font-bold">
                      <StatusIcon className="w-4 h-4" />
                      {status.label}
                      <Badge variant="secondary" className="money ml-auto bg-white/60 text-current-ink">{statusGrants.length}</Badge>
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
                          const organization = Array.isArray(organizations)
                            ? organizations.find(o => o.id === grant.organization_id)
                            : undefined;
                          return (
                            <Draggable key={grant.id} draggableId={grant.id} index={index}>
                              {(provided, snapshot) => (
                                <div className="block focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-lg">
                                  <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>
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
                                </div>
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
