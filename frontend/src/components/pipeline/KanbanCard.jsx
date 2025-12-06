import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { formatDateSafe, parseDateSafe } from '@/components/shared/dateUtils';
import { differenceInDays } from 'date-fns';
import {
  Star,
  Trash2,
  Calendar,
  DollarSign,
  CheckSquare,
  Building2
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export default function KanbanCard({ 
  grant, 
  organization, 
  checklistProgress,
  workflowProgress, // NEW
  onStarToggle, 
  onDelete, 
  isDragging 
}) {
  const deadlineDate = parseDateSafe(grant.deadline);
  const daysLeft = deadlineDate ? differenceInDays(deadlineDate, new Date()) : null;
  const isExpired = daysLeft !== null && daysLeft < 0;
  const isRolling = grant.deadline?.toLowerCase() === 'rolling';

  return (
    <div className={`bg-white rounded-lg border shadow-sm hover:shadow-md transition-all ${
      grant.starred ? 'ring-2 ring-yellow-400' : ''
    } ${isDragging ? 'opacity-50 rotate-2' : ''}`}>
      {/* Header Actions */}
      <div className="flex items-center justify-between p-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          {grant.starred && <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />}
          {grant.match_score > 0 && (
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-xs">
              {Math.round(grant.match_score)}% match
            </Badge>
          )}
        </div>
        
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onStarToggle();
            }}
          >
            <Star className={`w-4 h-4 ${grant.starred ? 'text-yellow-500 fill-yellow-500' : 'text-slate-400'}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-red-500 hover:text-red-700"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Content - only link if grant has valid id */}
      <Link 
        to={grant?.id ? createPageUrl(`GrantDetail?id=${grant.id}`) : '#'}
        onClick={(e) => {
          if (!grant?.id) {
            e.preventDefault();
            console.error('[KanbanCard] BLOCKED: Navigation blocked due to undefined grant ID', {
              grantTitle: grant?.title,
              grantFunder: grant?.funder,
              grantStatus: grant?.status,
              timestamp: new Date().toISOString()
            });
            return;
          }
          console.log('[KanbanCard] Navigating to grant:', {
            id: grant.id,
            title: grant.title?.substring(0, 40)
          });
        }}
      >
        <div className="p-3 space-y-2">
          <h4 className="font-semibold text-slate-900 text-sm line-clamp-2 leading-tight">
            {grant.title}
          </h4>
          
          <p className="text-xs text-slate-600 truncate">{grant.funder}</p>
          
          {organization && (
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <Building2 className="w-3 h-3" />
              {organization.name}
            </div>
          )}
          
          {/* Deadline */}
          {grant.deadline && (
            <div className={`flex items-center gap-1 text-xs ${
              isExpired ? 'text-red-600 font-semibold' :
              daysLeft !== null && daysLeft <= 7 ? 'text-amber-600 font-medium' :
              'text-slate-600'
            }`}>
              <Calendar className="w-3 h-3" />
              {isRolling ? 'Rolling' : formatDateSafe(grant.deadline, 'MMM d, yyyy')}
              {daysLeft !== null && !isRolling && (
                <span className="ml-1">
                  ({daysLeft === 0 ? 'Today' : 
                    daysLeft === 1 ? '1 day' : 
                    daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` :
                    `${daysLeft}d left`})
                </span>
              )}
            </div>
          )}
          
          {/* Award Amount */}
          {grant.award_ceiling && (
            <div className="flex items-center gap-1 text-xs text-slate-600">
              <DollarSign className="w-3 h-3" />
              Up to ${grant.award_ceiling.toLocaleString()}
            </div>
          )}
          
          {/* Checklist Progress */}
          {checklistProgress && checklistProgress.total > 0 && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <CheckSquare className="w-3 h-3" />
              <span>{checklistProgress.completed}/{checklistProgress.total} tasks</span>
              <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${checklistProgress.percentage}%` }}
                />
              </div>
            </div>
          )}
          
          {/* NEW: Workflow Progress */}
          {workflowProgress && workflowProgress.total > 0 && (
            <div className="p-2 bg-gradient-to-r from-slate-50 to-purple-50 rounded-lg border border-purple-100">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-medium text-purple-700">Workflow</span>
                <span className="text-purple-600">
                  {workflowProgress.completed}/{workflowProgress.total} stages
                </span>
              </div>
              <div className="h-1.5 bg-purple-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all"
                  style={{ width: `${workflowProgress.percentage}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}