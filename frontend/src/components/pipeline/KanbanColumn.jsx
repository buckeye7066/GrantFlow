import React from 'react';
import { Droppable, Draggable } from '@hello-pangea/dnd';
import { Badge } from '@/components/ui/badge';
import KanbanCard from './KanbanCard';

/**
 * KanbanColumn - Single column in the Kanban board
 */
export default function KanbanColumn({ 
  status, 
  grants, 
  organizations,
  onUpdateGrant,
  onDeleteGrant,
  checklistProgressMap,
  workflowProgressMap,
  selectedOrganization,
  needsAnalysisCount
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-white rounded-lg border border-slate-200 p-3 mb-3 shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${status.color}`}></div>
            <h3 className="font-semibold text-slate-900">{status.label}</h3>
          </div>
          <Badge variant="secondary">{grants.length}</Badge>
        </div>
        
        {needsAnalysisCount > 0 && (
          <Badge variant="outline" className="w-full justify-center text-xs bg-purple-50 text-purple-700 border-purple-200">
            {needsAnalysisCount} need AI analysis
          </Badge>
        )}
      </div>

      <Droppable droppableId={status.value}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex-1 space-y-3 rounded-lg p-2 transition-colors ${
              snapshot.isDraggingOver ? 'bg-blue-50 ring-2 ring-blue-300' : 'bg-slate-50'
            }`}
          >
            {grants.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                No grants in this stage
              </div>
            ) : (
              grants.map((grant, index) => {
                // FIXED: Validate grant has required id before rendering
                if (!grant || !grant.id) {
                  console.warn('[KanbanColumn] Skipping grant with missing id:', grant);
                  return null;
                }
                
                const org = organizations.find(o => o.id === grant.organization_id);
                const checklistProgress = checklistProgressMap[grant.id];
                const workflowProgress = workflowProgressMap?.[grant.id];
                
                // FIXED: Ensure draggableId is always a string
                const draggableId = String(grant.id);
                
                return (
                  <Draggable key={draggableId} draggableId={draggableId} index={index}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        {...provided.dragHandleProps}
                      >
                        <KanbanCard
                          grant={grant}
                          organization={org}
                          checklistProgress={checklistProgress}
                          workflowProgress={workflowProgress}
                          onStarToggle={() => onUpdateGrant(grant.id, { starred: !grant.starred })}
                          onDelete={() => onDeleteGrant(grant)}
                          isDragging={snapshot.isDragging}
                        />
                      </div>
                    )}
                  </Draggable>
                );
              })
            )}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}