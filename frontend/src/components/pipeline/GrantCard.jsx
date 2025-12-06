import React, { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { getDeadlineText, parseDateSafe } from '@/components/shared/dateUtils';
import GrantSummaryBox from './GrantSummaryBox';
import GrantEligibilityBullets from './GrantEligibilityBullets';
import GrantTagList from './GrantTagList';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  CheckCircle2,
  FileText,
  Send,
  Brain,
  Loader2,
  AlertCircle,
  ChevronRight,
  Mail,
  Heart,
  Pencil,
  Trash,
} from 'lucide-react';

/** number coercion helper */
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Get the next action message based on grant status and AI analysis status
 */
function getNextActionMessage(grant) {
  // AI is processing
  if (['queued', 'running'].includes(grant.ai_status)) {
    return {
      icon: Loader2,
      text: 'AI analyzing opportunity...',
      color: 'text-blue-600',
      spin: true
    };
  }

  // AI failed
  if (grant.ai_status === 'error') {
    return {
      icon: AlertCircle,
      text: 'Click to retry AI analysis',
      color: 'text-amber-600',
      spin: false
    };
  }

  // Status-based next actions
  switch (grant.status) {
    case 'discovered':
      return { icon: Brain, text: 'Click to analyze with AI', color: 'text-purple-600', spin: false };
    case 'interested':
      if (grant.ai_status === 'ready' && grant.ai_summary) {
        return { icon: FileText, text: 'Review AI insights → Start application', color: 'text-blue-600', spin: false };
      }
      return { icon: FileText, text: 'Click to start application', color: 'text-blue-600', spin: false };
    case 'drafting':
    case 'application_prep':
      return { icon: FileText, text: 'Continue drafting proposal', color: 'text-indigo-600', spin: false };
    case 'portal':
      return { icon: Send, text: 'Complete portal submission', color: 'text-orange-600', spin: false };
    case 'submitted':
      return { icon: CheckCircle2, text: 'Awaiting funder decision', color: 'text-green-600', spin: false };
    case 'awarded':
      return { icon: CheckCircle2, text: 'Grant awarded! Manage compliance', color: 'text-emerald-600', spin: false };
    default:
      return null;
  }
}

/** Helper to get status color class */
const getStatusColorClass = (status) => {
  switch (status) {
    case 'discovered': return 'bg-slate-100 text-slate-700';
    case 'interested': return 'bg-blue-100 text-blue-700';
    case 'drafting':
    case 'application_prep': return 'bg-indigo-100 text-indigo-700';
    case 'portal': return 'bg-orange-100 text-orange-700';
    case 'submitted': return 'bg-green-100 text-green-700';
    case 'awarded': return 'bg-emerald-100 text-emerald-700';
    default: return 'bg-gray-100 text-gray-700';
  }
};

/**
 * GrantCard - Main card component for displaying grant information
 */
export default function GrantCard({
  grant,
  onStarToggle,
  onStatusChange,
  onDelete,
  isDragging = false,
  showSummary = false,
  organizationName = null,
  workflowProgress = null,
  showActions = true,
  onClick
}) {
  const [showMenu, setShowMenu] = useState(false);
  const cardRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (cardRef.current && !cardRef.current.contains(event.target)) {
        setShowMenu(false);
      }
    };
    if (showMenu) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const deadlineText = getDeadlineText(grant.deadline);

  const deadlineStr = typeof grant.deadline === 'string' ? grant.deadline.trim() : null;
  const deadlineDate = deadlineStr ? parseDateSafe(deadlineStr) : null;

  const isExpired =
    !!deadlineStr &&
    deadlineStr.toLowerCase() !== 'rolling' &&
    deadlineDate instanceof Date &&
    !isNaN(deadlineDate.getTime()) &&
    deadlineDate < new Date();

  const matchScoreRaw = grant.match_score ?? grant.match ?? 0;
  const matchScore = toNum(matchScoreRaw);
  const hasMatchScore = matchScore > 0;

  const categories = Array.isArray(grant.categories)
    ? grant.categories
    : (Array.isArray(grant.category_list) ? grant.category_list : []);

  const tags = Array.isArray(grant.tags) ? grant.tags : [];

  const hasAISummary = typeof grant.ai_summary === 'string' && grant.ai_summary.trim().length > 0;

  const nextAction = getNextActionMessage(grant);

  // Award amount (show the best available)
  const awardAmount = toNum(grant.award_ceiling) || toNum(grant.award_floor) || toNum(grant.typical_award);

  return (
    <Card
      ref={cardRef}
      className={cn(
        "relative transition-all hover:shadow-lg",
        onClick && "cursor-pointer",
        grant.starred && "ring-2 ring-amber-400",
        isExpired && "opacity-60",
        isDragging && "opacity-50 rotate-2"
      )}
      onClick={(e) => {
        if (e.target.closest?.('[data-no-card-click]')) return;
        if (onClick) onClick(e);
      }}
    >
      <CardHeader className="relative flex flex-row items-start gap-3 p-3 pb-0">
        {/* Star Icon */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-no-card-click
                className={cn(
                  "absolute top-2 left-2 h-7 w-7 rounded-full",
                  grant.starred ? 'text-amber-500' : 'text-slate-400 hover:text-amber-500'
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onStarToggle(grant.id);
                }}
              >
                <Heart className={cn("h-4 w-4 fill-current", grant.starred ? 'stroke-amber-500' : 'stroke-slate-400')} />
                <span className="sr-only">Toggle star</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {grant.starred ? "Unstar grant" : "Star grant"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="flex-grow flex flex-col pl-9">
          <div className="flex items-center gap-2 mb-1">
            {/* Status Badge */}
            {grant.status && (
              <Badge variant="outline" className={cn("text-xs", getStatusColorClass(grant.status))}>
                {String(grant.status).replace(/_/g, ' ')}
              </Badge>
            )}
            {/* Expired Badge */}
            {isExpired && (
              <Badge variant="destructive" className="text-xs">
                Expired
              </Badge>
            )}
            {/* Match Score Badge */}
            {hasMatchScore && (
              <Badge className="bg-blue-500 hover:bg-blue-600 text-white text-xs">
                {matchScore}% Match
              </Badge>
            )}
          </div>
          <CardTitle className="font-semibold text-slate-900 text-sm leading-tight line-clamp-2">
            {grant.title || 'Untitled Opportunity'}
          </CardTitle>
          <CardDescription className="text-xs text-slate-600 truncate">
            {grant.funder || grant.sponsor || 'Unknown Funder'}
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 p-3">
        {/* Brief description of the funding source */}
        {(grant.program_description || grant.descriptionMd) && (
          <p className="text-xs text-slate-600 line-clamp-3">
            {grant.program_description || grant.descriptionMd}
          </p>
        )}

        <GrantSummaryBox
          summary={grant.ai_summary || ""}
          matchReasons={grant.matchReasons || grant.match_reasons}
          matchWarnings={grant.matchWarnings || grant.match_warnings}
          showSummary={showSummary}
        />

        <GrantEligibilityBullets
          bullets={Array.isArray(grant.eligibilityBullets) ? grant.eligibilityBullets : (Array.isArray(grant.eligibility_bullets) ? grant.eligibility_bullets : [])}
          show={showSummary}
        />

        <GrantTagList
          tags={tags}
          categories={categories}
        />

        {/* Workflow Progress Indicator */}
        {workflowProgress && workflowProgress.total > 0 && (
          <div className="p-2 bg-slate-50 rounded-lg border border-slate-200">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-medium text-slate-700">Workflow Progress</span>
              <span className="text-slate-600">
                {workflowProgress.completed}/{workflowProgress.total} stages
              </span>
            </div>
            <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all"
                style={{ width: `${(workflowProgress.completed / workflowProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* NEXT ACTION MESSAGE */}
        {nextAction && (() => {
          const NextIcon = nextAction.icon;
          return (
            <div className={`flex items-center gap-2 p-2 rounded-lg bg-gradient-to-r from-slate-50 to-blue-50 border border-blue-100 mt-3`}>
              <NextIcon
                className={`w-4 h-4 ${nextAction.color} ${nextAction.spin ? 'animate-spin' : ''}`}
              />
              <span className={`text-xs font-medium ${nextAction.color}`}>
                {nextAction.text}
              </span>
              {!nextAction.spin && (
                <ChevronRight className={`w-3 h-3 ml-auto ${nextAction.color}`} />
              )}
            </div>
          );
        })()}

        {/* Meta footer */}
        <div className="flex items-center justify-between text-xs text-slate-500 border-t pt-3 mt-3">
          {deadlineText && (
            <span className={isExpired ? 'text-red-600' : ''}>
              Deadline: {deadlineText}
            </span>
          )}
          {awardAmount > 0 && (
            <span>
              Award: ${awardAmount.toLocaleString()}
            </span>
          )}
        </div>

        {showActions && (
          <div className="flex flex-wrap gap-2 pt-3 border-t">
            <Link to={createPageUrl(`GrantDetail?id=${grant.id}`)} data-no-card-click>
              <Button variant="outline" size="sm" className="gap-1" data-no-card-click>
                <FileText className="w-4 h-4" />
                View Details
              </Button>
            </Link>
            <Link to={createPageUrl(`GrantDetail?id=${grant.id}&edit=true`)} data-no-card-click>
              <Button variant="outline" size="sm" className="gap-1" data-no-card-click>
                <Pencil className="w-4 h-4" />
                Edit
              </Button>
            </Link>
            <Link to={createPageUrl(`OutreachCampaigns?organization_id=${grant.organization_id}&grant_id=${grant.id}`)} data-no-card-click>
              <Button variant="outline" size="sm" className="gap-1" data-no-card-click>
                <Mail className="w-4 h-4" />
                Outreach
              </Button>
            </Link>
            <Button
              variant="destructive"
              size="sm"
              data-no-card-click
              className="gap-1"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(grant.id);
              }}
            >
              <Trash className="w-4 h-4" />
              Delete
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}