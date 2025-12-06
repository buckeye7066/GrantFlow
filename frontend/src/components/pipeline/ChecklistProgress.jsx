import React from 'react';
import { CheckSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * ChecklistProgress - Display task completion progress
 * @param {Object} props
 * @param {Object} props.progress - Progress object with completed/total/percentage
 * @param {boolean} props.compact - Use compact display
 */
export default function ChecklistProgress({ progress, compact = false }) {
  if (!progress || progress.total === 0) return null;

  const { completed, total, percentage } = progress;
  const isComplete = completed === total;

  if (compact) {
    return (
      <div className="flex items-center gap-1 text-xs text-slate-600">
        <CheckSquare className="w-3 h-3" aria-hidden="true" />
        <span>
          {completed}/{total}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1 text-slate-600">
          <CheckSquare className="w-3 h-3" aria-hidden="true" />
          <span>Checklist</span>
        </div>
        <Badge 
          variant={isComplete ? "default" : "secondary"}
          className={`text-xs ${isComplete ? 'bg-green-500' : ''}`}
        >
          {completed}/{total}
        </Badge>
      </div>
      
      <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            isComplete ? 'bg-green-500' : 'bg-blue-500'
          }`}
          style={{ width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${completed} of ${total} tasks completed`}
        />
      </div>
    </div>
  );
}