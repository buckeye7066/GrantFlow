import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Target,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  ThumbsUp,
  ThumbsDown,
  Sparkles,
  ExternalLink,
  Plus,
  FileText,
  MessageSquare
} from 'lucide-react';

export default function AIMatchResults({ opportunity, onAddToPipeline, isAdding }) {
  const matchScore = opportunity.matchScore || opportunity.match || opportunity.match_score || 0;
  const matchReasons = opportunity.matchReasons || opportunity.match_reasons || opportunity.why_this_matches || [];
  const concerns = opportunity.concerns || opportunity.match_concerns || [];
  const recommendation = opportunity.recommendation || 'consider';
  const strategicFit = opportunity.strategic_fit_summary || opportunity.strategicFitSummary || null;
  const funderTone = opportunity.funder_tone || opportunity.funderTone || null;
  const narrativeStyle = opportunity.recommended_narrative_style || opportunity.recommendedNarrativeStyle || null;

  const getScoreColor = (score) => {
    if (score >= 80) return 'text-green-600 bg-green-50 border-green-300';
    if (score >= 60) return 'text-blue-600 bg-blue-50 border-blue-300';
    if (score >= 40) return 'text-amber-600 bg-amber-50 border-amber-300';
    return 'text-slate-600 bg-slate-50 border-slate-300';
  };

  const getRecommendationBadge = (rec) => {
    switch (rec) {
      case 'highly_recommend':
        return <Badge className="bg-green-600">Highly Recommended</Badge>;
      case 'recommend':
        return <Badge className="bg-blue-600">Recommended</Badge>;
      case 'consider':
        return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300">Consider</Badge>;
      default:
        return <Badge variant="outline">Review Needed</Badge>;
    }
  };

  return (
    <Card className="hover:shadow-lg transition-all">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <Sparkles className="w-5 h-5 text-purple-600" />
              {getRecommendationBadge(recommendation)}
            </div>
            <CardTitle className="text-xl">{opportunity.title}</CardTitle>
            <p className="text-sm text-slate-600 mt-1">
              {opportunity.sponsor || opportunity.funder}
            </p>
          </div>
          
          <div className={`p-4 rounded-xl border-2 text-center ${getScoreColor(matchScore)}`}>
            <div className="flex items-center gap-1">
              <Target className="w-4 h-4" />
              <span className="text-2xl font-bold">{matchScore}</span>
            </div>
            <p className="text-xs mt-1">Match Score</p>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Award Information */}
        <div className="flex items-center gap-4 text-sm">
          {(opportunity.awardMin || opportunity.awardMax) && (
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-600" />
              <span className="font-semibold">
                ${opportunity.awardMin?.toLocaleString() || '0'} - ${opportunity.awardMax?.toLocaleString() || 'N/A'}
              </span>
            </div>
          )}
          
          {opportunity.deadlineAt && opportunity.deadlineAt !== 'rolling' && (
            <Badge variant="outline">
              Due: {(() => {
                try {
                  const date = new Date(opportunity.deadlineAt);
                  return !isNaN(date.getTime()) ? date.toLocaleDateString() : 'TBD';
                } catch {
                  return 'TBD';
                }
              })()}
            </Badge>
          )}
          
          {opportunity.deadlineAt && opportunity.deadlineAt.toLowerCase?.() === 'rolling' && (
            <Badge variant="outline" className="bg-blue-50 text-blue-700">
              Rolling
            </Badge>
          )}
          
          {opportunity.rolling && (
            <Badge variant="outline" className="bg-blue-50 text-blue-700">Rolling</Badge>
          )}
        </div>

        {/* AI Match Reasons */}
        {matchReasons.length > 0 && (
          <div className="p-3 bg-green-50 rounded-lg border border-green-200">
            <h4 className="font-semibold text-green-900 text-sm mb-2 flex items-center gap-2">
              <ThumbsUp className="w-4 h-4" />
              Why This Matches
            </h4>
            <ul className="space-y-1">
              {matchReasons.map((reason, idx) => (
                <li key={idx} className="text-sm text-green-800 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Concerns */}
        {concerns.length > 0 && (
          <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
            <h4 className="font-semibold text-amber-900 text-sm mb-2 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Considerations
            </h4>
            <ul className="space-y-1">
              {concerns.map((concern, idx) => (
                <li key={idx} className="text-sm text-amber-800 flex items-start gap-2">
                  <ThumbsDown className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{concern}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Strategic Fit Summary */}
        {strategicFit && (
          <div className="p-3 bg-purple-50 rounded-lg border border-purple-200">
            <h4 className="font-semibold text-purple-900 text-sm mb-2 flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Strategic Fit Summary
            </h4>
            <p className="text-sm text-purple-800">{strategicFit}</p>
          </div>
        )}

        {/* Funder Tone & Narrative Style */}
        {(funderTone || narrativeStyle) && (
          <div className="p-3 bg-indigo-50 rounded-lg border border-indigo-200">
            <h4 className="font-semibold text-indigo-900 text-sm mb-2 flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              Recommended Writing Approach
            </h4>
            <div className="space-y-2 text-sm text-indigo-800">
              {funderTone && (
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="bg-indigo-100 text-indigo-700 border-indigo-300">
                    Tone: {funderTone}
                  </Badge>
                </div>
              )}
              {narrativeStyle && (
                <p className="text-xs">{narrativeStyle}</p>
              )}
            </div>
          </div>
        )}

        {/* Description */}
        {opportunity.descriptionMd && (
          <p className="text-sm text-slate-600 line-clamp-3">
            {opportunity.descriptionMd}
          </p>
        )}

        {/* Eligibility bullets */}
        {opportunity.eligibilityBullets?.length > 0 && (
          <div className="text-xs text-slate-500">
            <strong>Key Requirements:</strong>
            <ul className="list-disc list-inside mt-1 space-y-0.5">
              {opportunity.eligibilityBullets.slice(0, 3).map((bullet, idx) => (
                <li key={idx}>{bullet}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button
            onClick={() => onAddToPipeline(opportunity)}
            disabled={isAdding}
            className="flex-1 bg-blue-600 hover:bg-blue-700"
          >
            {isAdding ? (
              <>Adding...</>
            ) : (
              <>
                <Plus className="w-4 h-4 mr-2" />
                Add to Pipeline
              </>
            )}
          </Button>
          
          {opportunity.url && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(opportunity.url, '_blank')}
            >
              <ExternalLink className="w-4 h-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}