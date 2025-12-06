import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Target } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { getMatchScoreBadge } from '@/components/shared/grantCardUtils';

/**
 * GrantMatchBadge - Display match score with tooltip
 * @param {Object} props
 * @param {number|string} props.matchScore - Match score (0-100)
 */
export default function GrantMatchBadge({ matchScore }) {
  // Coerce and clamp
  let score = Number(matchScore);
  if (!Number.isFinite(score)) return null;
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  score = Math.round(score);

  const badge = getMatchScoreBadge(score);
  if (!badge) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            className={`text-xs font-bold ${badge.bgColor} ${badge.textColor} cursor-help transition-transform hover:scale-105`}
            aria-label={`Match score ${score}%`}
          >
            <Target className="w-3 h-3 mr-1" aria-hidden="true" />
            {badge.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p>{badge.tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}