import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { 
  Plus, 
  ChevronDown, 
  ChevronUp,
  CheckCircle2, 
  XCircle,
  AlertTriangle,
  Sparkles,
  BarChart3,
  TrendingUp,
  Lightbulb,
  Target,
  GraduationCap,
  DollarSign,
  Calendar,
  ExternalLink
} from 'lucide-react';
import { formatDateSafe } from '@/components/shared/dateUtils';

/**
 * Enhanced match card with detailed analysis and improvement recommendations
 */
export default function MatchDetailCard({ 
  match, 
  organization,
  onAddToPipeline, 
  isAddingToPipeline,
  index 
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const getScoreColor = (score) => {
    if (score >= 90) return '#10b981';
    if (score >= 80) return '#3b82f6';
    if (score >= 70) return '#8b5cf6';
    return '#64748b';
  };

  const scoreColor = getScoreColor(match.match_score);

  // Parse criteria breakdown if available
  const criteriaBreakdown = match.criteria_breakdown || [];
  
  // Get improvement recommendations
  const improvements = match.improvement_recommendations || [];

  return (
    <Card 
      className="hover:shadow-xl transition-all border-l-4"
      style={{ borderLeftColor: scoreColor }}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <Badge 
                className="text-white font-bold px-3 py-1"
                style={{ backgroundColor: scoreColor }}
              >
                {match.match_score}% Match
              </Badge>
              <Badge variant="outline">
                {match.fundingType || 'Scholarship'}
              </Badge>
              {match.match_score >= 90 && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-300">
                  🌟 Top Pick
                </Badge>
              )}
            </div>
            <CardTitle className="text-xl mb-2 text-slate-900">
              {match.title}
            </CardTitle>
            <p className="text-sm text-slate-600">
              <strong>Funder:</strong> {match.sponsor || match.funder || 'Unknown'}
            </p>
          </div>
          
          <Button
            onClick={() => onAddToPipeline(match)}
            disabled={isAddingToPipeline}
            className="bg-green-600 hover:bg-green-700 shrink-0"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add to Pipeline
          </Button>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Quick Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="flex items-center gap-2 text-sm bg-slate-50 p-2 rounded">
            <DollarSign className="w-4 h-4 text-green-600" />
            <div>
              <p className="text-xs text-slate-500">Award</p>
              <p className="font-semibold text-slate-900">
                {match.awardMax ? `Up to $${match.awardMax.toLocaleString()}` : 'Varies'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm bg-slate-50 p-2 rounded">
            <Calendar className="w-4 h-4 text-blue-600" />
            <div>
              <p className="text-xs text-slate-500">Deadline</p>
              <p className="font-semibold text-slate-900">
                {match.rolling ? 'Rolling' : formatDateSafe(match.deadlineAt || match.deadline, 'MMM d, yyyy', 'TBD')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm bg-slate-50 p-2 rounded">
            <GraduationCap className="w-4 h-4 text-purple-600" />
            <div>
              <p className="text-xs text-slate-500">Type</p>
              <p className="font-semibold text-slate-900">
                {match.opportunity_type || match.fundingType || 'Scholarship'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm bg-slate-50 p-2 rounded">
            <Target className="w-4 h-4 text-orange-600" />
            <div>
              <p className="text-xs text-slate-500">Competition</p>
              <p className="font-semibold text-slate-900">
                {match.competition_level || 'Medium'}
              </p>
            </div>
          </div>
        </div>

        {/* AI Match Explanation */}
        <Alert className="bg-purple-50 border-purple-200">
          <Sparkles className="h-4 w-4 text-purple-600" />
          <AlertDescription className="text-purple-900">
            <strong>Why this matches your profile:</strong>
            <p className="mt-1">{match.ai_explanation || match.match_reason}</p>
          </AlertDescription>
        </Alert>

        {/* Match Criteria with Scores */}
        {criteriaBreakdown.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              Match Criteria Breakdown
            </p>
            <div className="grid gap-2">
              {criteriaBreakdown.map((criteria, idx) => (
                <div key={idx} className="flex items-center gap-3">
                  <div className="w-24 text-xs text-slate-600">{criteria.name}</div>
                  <div className="flex-1">
                    <Progress 
                      value={criteria.score} 
                      className="h-2"
                    />
                  </div>
                  <div className="w-12 text-right">
                    {criteria.met ? (
                      <CheckCircle2 className="w-4 h-4 text-green-500 inline" />
                    ) : criteria.partial ? (
                      <AlertTriangle className="w-4 h-4 text-amber-500 inline" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-400 inline" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Match Reasons */}
        {match.match_reasons?.length > 0 && (
          <div>
            <p className="text-sm font-semibold text-slate-700 mb-2">
              Matching Factors:
            </p>
            <div className="flex flex-wrap gap-2">
              {match.match_reasons.map((reason, idx) => (
                <Badge key={idx} variant="outline" className="bg-green-50 text-green-800 border-green-300">
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  {reason}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Expandable Section for More Details */}
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between">
              <span className="flex items-center gap-2">
                <Lightbulb className="w-4 h-4 text-amber-500" />
                View Improvement Tips & Details
              </span>
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </CollapsibleTrigger>
          
          <CollapsibleContent className="space-y-4 pt-4">
            {/* Improvement Recommendations */}
            {improvements.length > 0 && (
              <Alert className="bg-amber-50 border-amber-200">
                <Lightbulb className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-900">
                  <strong>How to improve your chances:</strong>
                  <ul className="mt-2 space-y-1 list-disc pl-4">
                    {improvements.map((tip, idx) => (
                      <li key={idx} className="text-sm">{tip}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* Requirements vs Profile Comparison */}
            {match.requirements_comparison && (
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-sm font-semibold text-slate-700 mb-3">
                  Requirements vs Your Profile
                </p>
                <div className="space-y-2">
                  {match.requirements_comparison.map((req, idx) => (
                    <div key={idx} className="flex items-start gap-3 text-sm">
                      <div className="mt-0.5">
                        {req.met ? (
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                        ) : req.partial ? (
                          <AlertTriangle className="w-4 h-4 text-amber-500" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400" />
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-slate-800">{req.requirement}</p>
                        <p className="text-slate-600">{req.your_status}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Eligibility Bullets */}
            {match.eligibilityBullets?.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-2">Eligibility Requirements:</p>
                <ul className="text-sm text-slate-600 space-y-1 list-disc pl-4">
                  {match.eligibilityBullets.slice(0, 5).map((bullet, idx) => (
                    <li key={idx}>{bullet}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Description */}
            {(match.descriptionMd || match.program_description) && (
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-2">Description:</p>
                <p className="text-sm text-slate-600 line-clamp-4">
                  {match.descriptionMd || match.program_description}
                </p>
              </div>
            )}

            {/* External Link */}
            {match.url && (
              <Button variant="outline" size="sm" asChild>
                <a href={match.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-4 h-4 mr-2" />
                  View Full Opportunity
                </a>
              </Button>
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}