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
import { MoreVertical, Star, Edit, Trash2, Calendar, DollarSign, Building2, Target, CheckSquare, Sparkles, ExternalLink, AlertCircle, Clock, Info, CalendarClock, CheckCircle2, FileEdit, Link2Off, UserCheck } from 'lucide-react';
import { format, isPast } from 'date-fns';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import HelpTip from '@/components/help/HelpTip';
import { isRenderableUrl } from '@/lib/matchDisplayThresholds';
import { formatReasonText } from '@/utils/reasonText';
import { isHumanReviewNeeded, getStageHelp } from '@/components/pipeline/pipelineStageHelp';
import YanaTaskBadge from '@/components/yana/YanaTaskBadge';
import YanaTaskDrawer from '@/components/yana/YanaTaskDrawer';
import { useYanaSelection } from '@/components/yana/YanaSelectionContext';

function getGrantDetailUrl(grant, isDiscoveryResult = false) {
  if (grant.id) {
    return createPageUrl("GrantDetail", { id: grant.id });
  }

  if (isDiscoveryResult) {
    if (grant.title) {
      return createPageUrl("FundingOpportunities") + `?search=${encodeURIComponent(grant.title)}`;
    }
    return createPageUrl("FundingOpportunities");
  }

  const url = grant.url || grant.application_url || grant.source_url;
  if (isRenderableUrl(url)) {
    return url;
  }

  if (grant.title) {
    return createPageUrl("FundingOpportunities") + `?search=${encodeURIComponent(grant.title)}`;
  }

  return createPageUrl("FundingOpportunities");
}

function isValidExternalUrl(url) {
  return isRenderableUrl(url);
}

export default function GrantCard({ grant, organization, organizationName, onStatusChange, onStarToggle, onDelete, isDragging, checklistProgress, showSummary = false, isInPipeline = false, onAddToPipeline = null, profileId = null }) {
  const [showMenu, setShowMenu] = useState(false);
  const [showMatchBreakdown, setShowMatchBreakdown] = useState(false);
  const [yanaTask, setYanaTask] = useState(null);
  const [yanaDrawerOpen, setYanaDrawerOpen] = useState(false);
  const cardRef = useRef(null);
  const navigate = useNavigate();
  const yanaSelection = useYanaSelection();
  const yanaSelectionSource = {
    grant_id: grant?.id || null,
    opportunity_id: grant?.opportunity_id || grant?.funding_opportunity_id || null,
    current_stage: grant?.status || null,
    title: grant?.title || null,
  };
  const yanaIsSelected = yanaSelection?.enabled
    ? yanaSelection.isSelected(yanaSelectionSource)
    : false;

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

  // Deadline urgency: days remaining (null when no valid deadline or already expired)
  const daysUntilDeadline = isDeadlineValid && !isExpired
    ? Math.ceil((deadlineDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;
  const deadlineUrgency = daysUntilDeadline !== null
    ? daysUntilDeadline <= 7 ? 'critical' : daysUntilDeadline <= 14 ? 'warning' : 'normal'
    : null;

  // Freshness badge — only show for stale or unverified
  const freshness = grant.freshness ?? null;

  // Normalize snake_case eligibility_bullets from backend to camelCase
  const eligibilityBullets = grant.eligibilityBullets ?? grant.eligibility_bullets ?? [];
  // Check if this is a discovery result (from FundingOpportunity entity)
  const isDiscoveryResult = grant.descriptionMd || eligibilityBullets.length > 0;
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

  // Human review surface: surface when the stage itself is human-required
  // (portal / follow_up / report) OR the latest pipeline_automation event
  // for this grant said handoff_required=true. The reason string (if any)
  // is shown in the badge tooltip so a clinician/grant writer sees WHY.
  const latestAutomation = grant.latest_automation ?? grant.latestAutomation ?? null;
  const needsHumanReview = isHumanReviewNeeded(grant.status, latestAutomation);
  const stageHelp = getStageHelp(grant.status);
  const humanReviewReason =
    latestAutomation?.handoff_reason ||
    stageHelp.nextStep ||
    'A person needs to finish this step.';

  return (
    <div
      ref={cardRef}
      className={`bg-white rounded-lg border hover:shadow-md transition-all duration-200 ${isDragging ? 'shadow-2xl rotate-2' : ''} ${grant.starred ? 'border-yellow-400 border-2' : 'border-slate-200'}`}
    >
      <div className="flex items-center justify-between p-3 border-b border-slate-100">
        <div className="flex items-center gap-2 flex-wrap">
          {yanaSelection?.enabled && (
            <label
              className="inline-flex items-center cursor-pointer select-none mr-1"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              title={yanaIsSelected ? 'Selected for Yana' : 'Select for Yana automation'}
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                checked={yanaIsSelected}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { e.stopPropagation(); yanaSelection.toggle(yanaSelectionSource); }}
              />
            </label>
          )}
          {grant.starred && <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />}
          {isExpired && <Badge variant="destructive" className="text-xs">EXPIRED</Badge>}
          {hasSummary && showSummary && (
            <HelpTip text="AI Summary: This opportunity has been analyzed by our AI to provide a quick description of the funding program.">
                <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200 cursor-help">
                  <Sparkles className="w-3 h-3 mr-1" />
                  AI Summary
                </Badge>
              </HelpTip>
          )}
          {/* Match Score Badge - PROMINENT */}
          {hasMatchScore && (
            <div className="flex items-center gap-1">
              <HelpTip text={"Match Score: " + Math.round(matchScore) + "%. This shows how well this opportunity fits your profile based on location, demographics, interests, and eligibility criteria. 80%+ = Excellent, 65%+ = Good, 50%+ = Fair."}>
                <Badge className={"text-xs font-bold " + matchColor.bg + " " + matchColor.text + " cursor-help"}>
                  <Target className="w-3 h-3 mr-1" />
                  {Math.round(matchScore)}% Match
                </Badge>
              </HelpTip>
              {/* Info toggle for match breakdown — only show when there are reasons to display */}
              {(() => {
                const reasons = Array.isArray(grant.match_reasons) ? grant.match_reasons : (Array.isArray(grant.matchReasons) ? grant.matchReasons : []);
                return reasons.length > 0 ? (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowMatchBreakdown(v => !v); }}
                    className="text-slate-400 hover:text-slate-600 transition-colors"
                    title={showMatchBreakdown ? 'Hide match details' : 'Why this matched'}
                    aria-label="Toggle match breakdown"
                  >
                    <Info className="w-3.5 h-3.5" />
                  </button>
                ) : null;
              })()}
            </div>
            )}
          {/* In-Pipeline indicator */}
          {isInPipeline && (
            <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-300 gap-1">
              <CheckCircle2 className="w-3 h-3" />
              In Pipeline
            </Badge>
          )}
          {/* Human Review Needed — fires when stage requires a person
              (portal / follow_up / report) or the latest automation event
              flagged handoff_required. Tooltip shows the actual reason
              from automation when available, otherwise the stage's next-step. */}
          {needsHumanReview && (
            <HelpTip text={`Human Review Needed: ${humanReviewReason}`}>
              <Badge className="text-xs gap-1 bg-amber-500 text-white hover:bg-amber-600 cursor-help">
                <UserCheck className="w-3 h-3" />
                Human Review Needed
              </Badge>
            </HelpTip>
          )}
          {/* Freshness Badges */}
          {freshness === 'fresh' && (
            <HelpTip text="Added or verified within the last 30 days.">
              <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-300 cursor-help">
                <Sparkles className="w-3 h-3 mr-1" />
                New
              </Badge>
            </HelpTip>
          )}
          {freshness === 'stale' && (
            <HelpTip text="Last verified 90+ days ago — verify this is still active before applying.">
              <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-300 cursor-help">
                <Clock className="w-3 h-3 mr-1" />
                !
              </Badge>
            </HelpTip>
          )}
          {freshness === 'unverified' && (
            <HelpTip text="Verification date unknown — confirm this opportunity is still open before applying.">
              <Badge variant="outline" className="text-xs bg-slate-100 text-slate-500 border-slate-300 cursor-help">
                <Clock className="w-3 h-3 mr-1" />
                ?
              </Badge>
            </HelpTip>
          )}
          {/* Link broken badge — warns user the application URL returned 4xx/5xx */}
          {grant.link_status === 'broken' && (
            <HelpTip text="The application link may be broken — our last check got an error. The URL may have moved or expired.">
              <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-300 cursor-help">
                <Link2Off className="w-3 h-3 mr-1" />
                Link Issue
              </Badge>
            </HelpTip>
          )}
          {/* Pro Bono / In-Kind / Service Type Badge */}
          {['pro_bono', 'in_kind', 'charity_care', 'training_paid', 'legal_aid', 'clinic_service', 'equipment_donation'].includes(grant.opportunity_type) && (
            <Badge variant="secondary" className="text-xs bg-purple-100 text-purple-800 border-purple-200">
              {{
                pro_bono: 'Pro Bono',
                in_kind: 'In-Kind',
                charity_care: 'Charity Care',
                training_paid: 'Free Training',
                legal_aid: 'Legal Aid',
                clinic_service: 'Clinic Service',
                equipment_donation: 'Equipment',
              }[grant.opportunity_type] || 'Service'}
            </Badge>
          )}
          {grant.funding_type && ['service', 'cost_coverage', 'referral'].includes(grant.funding_type) && (
            <Badge variant="outline" className="text-xs border-purple-200 text-purple-700">
              {{service: 'Service', cost_coverage: 'Cost Coverage', referral: 'Referral'}[grant.funding_type]}
            </Badge>
          )}
        </div>
        {(onStarToggle || onDelete || yanaSelection?.enabled) && (
          <DropdownMenu open={showMenu} onOpenChange={setShowMenu}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onStarToggle && (
                <DropdownMenuItem onSelect={() => { onStarToggle(); setShowMenu(false); }}>
                  <Star className="w-4 h-4 mr-2" />
                  {grant.starred ? 'Unstar' : 'Star'}
                </DropdownMenuItem>
              )}
              {yanaSelection?.enabled && (
                <DropdownMenuItem
                  onSelect={() => { yanaSelection.toggle(yanaSelectionSource); setShowMenu(false); }}
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  {yanaIsSelected ? 'Remove from Yana selection' : 'Automate with Yana'}
                </DropdownMenuItem>
              )}
              {yanaTask && (
                <DropdownMenuItem onSelect={() => { setYanaDrawerOpen(true); setShowMenu(false); }}>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Resume / view Yana task
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => { navigate(createPageUrl("GrantDetail", { id: grant.id })); setShowMenu(false); }}>
                <Edit className="w-4 h-4 mr-2" />
                View Details
              </DropdownMenuItem>
              {onDelete && (
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    onDelete(grant);
                    setShowMenu(false);
                  }}
                  className="text-red-600"
                >
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
          
          {/* Match Reasons (if available) - support both match_reasons (API) and matchReasons (legacy) */}
          {(showSummary || showMatchBreakdown) && (() => {
            const reasons = Array.isArray(grant.match_reasons) ? grant.match_reasons : (Array.isArray(grant.matchReasons) ? grant.matchReasons : []);
            return reasons.length > 0 ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-md p-2 space-y-1">
              <p className="text-xs font-semibold text-emerald-900">Why this matches:</p>
              {reasons.slice(0, 5).map((reason, idx) => {
                const text = formatReasonText(reason)
                return text ? (
                  <p key={idx} className="text-xs text-emerald-700 leading-tight">
                    {text}
                  </p>
                ) : null
              })}
            </div>
            ) : null;
          })()}

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
          {showSummary && eligibilityBullets.length > 0 && (
            <div className="mt-2 space-y-1">
              {eligibilityBullets.slice(0, 2).map((bullet, idx) => (
                <div key={idx} className="flex items-start gap-1">
                  <CheckSquare className="w-3 h-3 text-emerald-600 mt-0.5 shrink-0" />
                  <span className="text-xs text-slate-600 line-clamp-1">{bullet}</span>
                </div>
              ))}
              {eligibilityBullets.length > 2 && (
                <span className="text-xs text-slate-500 italic">+{eligibilityBullets.length - 2} more requirements</span>
              )}
            </div>
          )}
          
          {/* Tags */}
          {grant.tags && grant.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {grant.tags.slice(0, 2).map(tag => (
                <HelpTip key={tag} text={"Tag: " + tag + ". Tags indicate the funding category or focus area of this opportunity."}>
                    <Badge variant="secondary" className="text-xs px-1.5 py-0 cursor-help">
                      {tag}
                    </Badge>
                  </HelpTip>
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
                <HelpTip key={cat} text={"Category: " + cat + ". This funding opportunity falls under this program category."}>
                    <Badge variant="outline" className="text-xs px-1.5 py-0 bg-blue-50 text-blue-700 border-blue-200 cursor-help">
                      {cat}
                    </Badge>
                  </HelpTip>
              ))}
              {grant.categories.length > 2 && (
                <Badge variant="outline" className="text-xs px-1.5 py-0">
                  +{grant.categories.length - 2}
                </Badge>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 items-center">
            {isExpired && (
              <div className="flex items-center gap-1 text-xs text-red-600 font-semibold">
                <Calendar className="w-3 h-3" />
                <span className="line-through">{format(deadlineDate, 'MMM d, yyyy')}</span>
                <span className="no-underline ml-0.5">— Deadline passed</span>
              </div>
            )}
            {!isExpired && isDeadlineValid && deadlineUrgency === 'critical' && (
              <HelpTip text={`Only ${daysUntilDeadline} day${daysUntilDeadline === 1 ? '' : 's'} remaining — act soon!`}>
                <div className="flex items-center gap-1 text-xs text-red-600 font-semibold cursor-help">
                  <Calendar className="w-3 h-3" />
                  <span>⚠ {daysUntilDeadline} day{daysUntilDeadline === 1 ? '' : 's'} left ({format(deadlineDate, 'MMM d')})</span>
                </div>
              </HelpTip>
            )}
            {!isExpired && isDeadlineValid && deadlineUrgency === 'warning' && (
              <HelpTip text={`Deadline in ${daysUntilDeadline} days — start preparing your application.`}>
                <div className="flex items-center gap-1 text-xs text-amber-600 font-medium cursor-help">
                  <Calendar className="w-3 h-3" />
                  <span>{format(deadlineDate, 'MMM d, yyyy')} ({daysUntilDeadline}d)</span>
                </div>
              </HelpTip>
            )}
            {!isExpired && isDeadlineValid && deadlineUrgency === 'normal' && (
              <div className="flex items-center gap-1 text-xs text-slate-600">
                <Calendar className="w-3 h-3" />
                <span>{format(deadlineDate, 'MMM d, yyyy')}</span>
              </div>
            )}

            {grant.rolling && (
              <HelpTip text="Rolling Deadline: This opportunity accepts applications on an ongoing basis with no fixed closing date.">
                    <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200 cursor-help">
                      Rolling Deadline
                    </Badge>
                  </HelpTip>
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

          {/* Action buttons for discovery cards */}
          {(onAddToPipeline || (!isExpired && isDeadlineValid) || (grant.id && (grant.application_url || grant.source_id))) && (
            <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100 mt-1" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              {/* Add to Pipeline / In Pipeline button */}
              {onAddToPipeline && (
                isInPipeline ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled
                    className="flex-1 text-xs bg-emerald-50 text-emerald-700 border-emerald-200 cursor-default"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                    In Pipeline
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="flex-1 text-xs"
                    onClick={() => onAddToPipeline(grant)}
                  >
                    + Add to Pipeline
                  </Button>
                )
              )}
              {/* Start Proposal — only when grant has an application_url or source_id */}
              {grant.id && (grant.application_url || grant.source_id) && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-xs shrink-0 border-blue-300 text-blue-700 hover:bg-blue-50"
                  title="Start a proposal for this grant"
                  onClick={() => navigate(createPageUrl('Apply', { id: grant.id }))}
                >
                  <FileEdit className="w-3.5 h-3.5 mr-1" />
                  Start Proposal
                </Button>
              )}
              {/* Set Deadline Reminder */}
              {!isExpired && isDeadlineValid && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-xs shrink-0"
                  title="Set a reminder for this deadline"
                  onClick={() => {
                    const msg = `Set a reminder for: ${grant.title} deadline: ${grant.deadline}`;
                    window.dispatchEvent(new CustomEvent('anya:open', { detail: { prefillMessage: msg } }));
                  }}
                >
                  <CalendarClock className="w-3.5 h-3.5 mr-1" />
                  Remind Me
                </Button>
              )}
            </div>
          )}

          {/* Yana — application-completion agent. Visible on pipeline cards
              (isInPipeline) so the user sees a "Let Yana help" CTA without
              cluttering discovery results. */}
          {isInPipeline && grant.id && grant.profile_id && (
            <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <YanaTaskBadge
                profileId={grant.profile_id}
                grant={grant}
                onTaskUpdated={(t) => setYanaTask(t)}
                onOpenDrawer={(t) => { setYanaTask(t); setYanaDrawerOpen(true); }}
              />
            </div>
          )}
        </div>
      </Link>
      {yanaDrawerOpen && (
        <YanaTaskDrawer
          open={yanaDrawerOpen}
          task={yanaTask}
          onClose={() => setYanaDrawerOpen(false)}
          onTaskUpdated={(t) => setYanaTask(t)}
        />
      )}
    </div>
  );
}
