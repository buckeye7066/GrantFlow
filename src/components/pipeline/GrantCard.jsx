import React, { useState, useRef, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreVertical, Star, Edit, Trash2, Calendar, DollarSign, Building2, Target, CheckSquare, Sparkles, ExternalLink, AlertCircle } from 'lucide-react';
import { format, isPast } from 'date-fns';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

// Helper to get a valid grant detail URL
function getGrantDetailUrl(grant, isDiscoveryResult = false) {
  // If grant has an ID, always go to internal detail page
  if (grant.id) {
    return createPageUrl("GrantDetail", { id: grant.id });
  }
  
  // For discovery results without ID, go to opportunities page
  if (isDiscoveryResult) {
    if (grant.title) {
      return createPageUrl("FundingOpportunities") + `?search=${encodeURIComponent(grant.title)}`;
    }
    return createPageUrl("FundingOpportunities");
  }
  
  // Check if URL is valid and not a placeholder
  const url = grant.url || grant.application_url || grant.source_url;
  if (url && !url.includes('example.org') && !url.includes('placeholder') && !url.includes('example.com')) {
    // External URL - will be handled by the Link component
    return url;
  }
  
  // No valid URL - go to opportunities page with search
  if (grant.title) {
    return createPageUrl("FundingOpportunities") + `?search=${encodeURIComponent(grant.title)}`;
  }
  
  return createPageUrl("FundingOpportunities");
}

// Check if a URL is a valid external link (not a placeholder)
function isValidExternalUrl(url) {
  if (!url) return false;
  if (url.includes('example.org') || url.includes('example.com') || url.includes('placeholder')) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

export default function GrantCard({ grant, organization, organizationName, onStatusChange, onStarToggle, onDelete, isDragging, checklistProgress, showSummary = false }) {
  const [showMenu, setShowMenu] = useState(false);
  const cardRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (cardRef.current && !cardRef.current.contains(event.target)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const deadlineDate = grant.deadline ? new Date(grant.deadline) : null;
  const isDeadlineValid = deadlineDate && !isNaN(deadlineDate.getTime());
  const isExpired = isDeadlineValid && isPast(deadlineDate) && grant.deadline.toLowerCase() !== 'rolling';

  // Check if this is a discovery result (from FundingOpportunity entity)
  const isDiscoveryResult = grant.descriptionMd || grant.eligibilityBullets;
  const hasSummary = grant.descriptionMd && grant.descriptionMd.length > 0;

  // Get match score - prefer 'match' over 'match_score'
  const matchScore = grant.match || grant.match_score || 0;
  const hasMatchScore = matchScore > 0;

  // Get match score color and label
  const getMatchScoreColor = (score) => {
    if (score >= 80) return { bg: 'bg-emerald-500', text: 'text-white', label: 'Excellent Match' };
    if (score >= 65) return { bg: 'bg-green-500', text: 'text-white', label: 'Good Match' };
    if (score >= 50) return { bg: 'bg-blue-500', text: 'text-white', label: 'Fair Match' };
    if (score >= 35) return { bg: 'bg-amber-500', text: 'text-white', label: 'Potential Match' };
    return { bg: 'bg-slate-400', text: 'text-white', label: 'Low Match' };
  };

  const matchColor = getMatchScoreColor(matchScore);

  return (
    <div
      ref={cardRef}
      className={`bg-white rounded-lg border hover:shadow-md transition-all duration-200 ${isDragging ? 'shadow-2xl rotate-2' : ''} ${grant.starred ? 'border-yellow-400 border-2' : 'border-slate-200'}`}
    >
      <div className="flex items-center justify-between p-3 border-b border-slate-100">
        <div className="flex items-center gap-2 flex-wrap">
          {grant.starred && <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />}
          {isExpired && <Badge variant="destructive" className="text-xs">EXPIRED</Badge>}
          {hasSummary && showSummary && (
            <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
              <Sparkles className="w-3 h-3 mr-1" />
              AI Summary
            </Badge>
          )}
          {/* Match Score Badge - PROMINENT */}
          {hasMatchScore && (
            <Badge className={`text-xs font-bold ${matchColor.bg} ${matchColor.text}`}>
              <Target className="w-3 h-3 mr-1" />
              {Math.round(matchScore)}% Match
            </Badge>
          )}
        </div>
        {(onStarToggle || onDelete) && (
          <DropdownMenu open={showMenu} onOpenChange={setShowMenu}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onStarToggle && (
                <DropdownMenuItem onClick={() => { onStarToggle(); setShowMenu(false); }}>
                  <Star className="w-4 h-4 mr-2" />
                  {grant.starred ? 'Unstar' : 'Star'}
                </DropdownMenuItem>
              )}
              <Link to={createPageUrl("GrantDetail", { id: grant.id })}>
                <DropdownMenuItem>
                  <Edit className="w-4 h-4 mr-2" />
                  View Details
                </DropdownMenuItem>
              </Link>
              {onDelete && (
                <DropdownMenuItem onClick={() => { onDelete(grant); setShowMenu(false); }} className="text-red-600">
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      
      <Link to={getGrantDetailUrl(grant, showSummary)}>
        <div className="p-3 space-y-2 cursor-pointer">
          <h4 className="font-semibold text-slate-900 text-sm line-clamp-2 leading-tight">
            {grant.title}
          </h4>
          
          <p className="text-xs text-slate-600 truncate">{grant.funder || grant.sponsor}</p>
          
          {/* Match Reasons (if available) */}
          {showSummary && grant.matchReasons && grant.matchReasons.length > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-md p-2 space-y-1">
              <p className="text-xs font-semibold text-emerald-900">Why this matches:</p>
              {grant.matchReasons.slice(0, 3).map((reason, idx) => (
                <p key={idx} className="text-xs text-emerald-700 leading-tight">
                  {reason}
                </p>
              ))}
            </div>
          )}

          {/* Warnings (if any) */}
          {showSummary && grant.matchWarnings && grant.matchWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-2 space-y-1">
              <div className="flex items-center gap-1">
                <AlertCircle className="w-3 h-3 text-amber-600" />
                <p className="text-xs font-semibold text-amber-900">Note:</p>
              </div>
              {grant.matchWarnings.slice(0, 2).map((warning, idx) => (
                <p key={idx} className="text-xs text-amber-700 leading-tight">
                  {warning}
                </p>
              ))}
            </div>
          )}
          
          {/* AI-Generated Summary (Only for discovery results) */}
          {showSummary && hasSummary && (
            <div className="bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 rounded-md p-2 mt-2">
              <p className="text-xs text-slate-700 leading-relaxed line-clamp-3">
                {grant.descriptionMd}
              </p>
            </div>
          )}

          {/* Eligibility Bullets */}
          {showSummary && grant.eligibilityBullets && grant.eligibilityBullets.length > 0 && (
            <div className="mt-2 space-y-1">
              {grant.eligibilityBullets.slice(0, 2).map((bullet, idx) => (
                <div key={idx} className="flex items-start gap-1">
                  <CheckSquare className="w-3 h-3 text-emerald-600 mt-0.5 shrink-0" />
                  <span className="text-xs text-slate-600 line-clamp-1">{bullet}</span>
                </div>
              ))}
              {grant.eligibilityBullets.length > 2 && (
                <span className="text-xs text-slate-500 italic">+{grant.eligibilityBullets.length - 2} more requirements</span>
              )}
            </div>
          )}
          
          {/* Tags */}
          {grant.tags && grant.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {grant.tags.slice(0, 2).map(tag => (
                <Badge key={tag} variant="secondary" className="text-xs px-1.5 py-0">
                  {tag}
                </Badge>
              ))}
              {grant.tags.length > 2 && (
                <Badge variant="secondary" className="text-xs px-1.5 py-0">
                  +{grant.tags.length - 2}
                </Badge>
              )}
            </div>
          )}

          {/* Categories (for discovery results) */}
          {grant.categories && grant.categories.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {grant.categories.slice(0, 2).map(cat => (
                <Badge key={cat} variant="outline" className="text-xs px-1.5 py-0 bg-blue-50 text-blue-700 border-blue-200">
                  {cat}
                </Badge>
              ))}
              {grant.categories.length > 2 && (
                <Badge variant="outline" className="text-xs px-1.5 py-0">
                  +{grant.categories.length - 2}
                </Badge>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 items-center">
            {isDeadlineValid && (
              <div className={`flex items-center gap-1 text-xs ${isExpired ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>
                <Calendar className="w-3 h-3" />
                <span>{format(deadlineDate, 'MMM d, yyyy')}</span>
              </div>
            )}

            {grant.rolling && (
              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                Rolling Deadline
              </Badge>
            )}

            {(grant.amount_max || grant.typical_award || grant.awardMax) && (
              <div className="flex items-center gap-1 text-xs text-slate-600">
                <DollarSign className="w-3 h-3" />
                <span>~${(grant.typical_award || grant.amount_max || grant.awardMax)?.toLocaleString()}</span>
              </div>
            )}
          </div>

          {organizationName && (
            <div className="flex items-center gap-1 text-xs text-slate-500 truncate">
              <Building2 className="w-3 h-3 shrink-0" />
              <span className="truncate">{organizationName}</span>
            </div>
          )}

          {checklistProgress && checklistProgress.total > 0 && (
            <div className="flex items-center gap-1 text-xs text-slate-600">
              <CheckSquare className="w-3 h-3" />
              <span>{checklistProgress.completed}/{checklistProgress.total} tasks</span>
            </div>
          )}

          {/* External Link for discovery results - only show if valid URL */}
          {showSummary && isValidExternalUrl(grant.url || grant.application_url || grant.source_url) && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const href = grant.url || grant.application_url || grant.source_url;
                if (href) window.open(href, '_blank', 'noopener,noreferrer');
              }}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 text-left"
            >
              <ExternalLink className="w-3 h-3" />
              <span>View full details</span>
            </button>
          )}
        </div>
      </Link>
    </div>
  );
}