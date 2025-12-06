import React from 'react';
import { DollarSign, Calendar, Target } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function GrantMetaFooter({ deadline, awardCeiling, matchScore, isExpired }) {
  // Safe deadline text
  const deadlineText =
    typeof deadline === 'string' && deadline.trim().length > 0 ? deadline.trim() : 'No deadline';

  // Safe award amount
  const awardNum = Number(awardCeiling);
  const showAward = Number.isFinite(awardNum) && awardNum > 0;

  // Safe match score (0-100 int)
  let score = Number(matchScore);
  const showScore = Number.isFinite(score) && score > 0;
  if (!Number.isFinite(score)) score = 0;
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  const scoreInt = Math.round(score);

  const scoreClass =
    scoreInt >= 70
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : scoreInt >= 50
      ? 'bg-blue-50 text-blue-700 border-blue-200'
      : 'bg-slate-50 text-slate-700 border-slate-200';

  return (
    <div className="p-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-xs gap-2">
      <div className="flex items-center gap-1 text-slate-600">
        <Calendar className="w-3 h-3" />
        <span className={isExpired ? 'text-red-600 font-semibold' : ''}>
          {deadlineText}
        </span>
      </div>

      {showAward && (
        <div className="flex items-center gap-1 text-slate-600">
          <DollarSign className="w-3 h-3" />
          <span>${awardNum.toLocaleString()}</span>
        </div>
      )}

      {showScore && (
        <Badge variant="outline" className={scoreClass}>
          <Target className="w-3 h-3 mr-1" />
          {scoreInt}% match
        </Badge>
      )}
    </div>
  );
}