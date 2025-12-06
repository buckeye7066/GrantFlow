import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertTriangle, Sparkles, ExternalLink, Calendar } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { format } from 'date-fns';
import { getMatchTier } from '@/components/shared/matchScoring';

/**
 * Individual grant match result card
 */
export default function MatchResultCard({ match }) {
  const tier = getMatchTier(match.match_score);

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardContent className="p-6">
        <div className="flex items-start gap-6">
          {/* Match Score Circle */}
          <div className="flex-shrink-0">
            <div className={`relative w-24 h-24 rounded-full border-4 flex items-center justify-center ${tier.bgClass} ${tier.borderClass}`}>
              <div className="text-center">
                <div className={`text-2xl font-bold ${tier.colorClass}`}>
                  {match.match_score}
                </div>
                <div className="text-xs font-medium">MATCH</div>
              </div>
            </div>
            <div className="text-center mt-2">
              <Badge variant="outline" className="text-xs">
                {tier.label}
              </Badge>
            </div>
          </div>

          {/* Grant Details */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1 min-w-0">
                <Link 
                  to={createPageUrl(`GrantDetail?id=${match.grant_id}`)}
                  className="text-lg font-bold text-slate-900 hover:text-blue-600 flex items-center gap-2 group"
                >
                  {match.title}
                  <ExternalLink className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                </Link>
                <p className="text-slate-600 text-sm mt-1">{match.funder}</p>
              </div>
              {match.status && (
                <Badge variant="outline" className="ml-4">
                  {match.status}
                </Badge>
              )}
            </div>

            {/* Match Reasons */}
            {match.match_reasons && match.match_reasons.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm font-semibold text-slate-700">Why This Matches:</span>
                </div>
                <ul className="space-y-1">
                  {match.match_reasons.map((reason, idx) => (
                    <li key={idx} className="text-sm text-slate-600 flex items-start gap-2">
                      <span className="text-emerald-600 mt-0.5">✓</span>
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Unmet Requirements */}
            {match.unmet_requirements && match.unmet_requirements.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-semibold text-slate-700">Concerns:</span>
                </div>
                <ul className="space-y-1">
                  {match.unmet_requirements.map((req, idx) => (
                    <li key={idx} className="text-sm text-amber-700 flex items-start gap-2">
                      <span className="text-amber-600 mt-0.5">!</span>
                      <span>{req}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recommendations */}
            {match.recommendations && (
              <Alert className="bg-purple-50 border-purple-200 mt-3">
                <Sparkles className="h-4 w-4 text-purple-600" />
                <AlertDescription className="text-purple-900 text-sm">
                  <strong>Recommendation:</strong> {match.recommendations}
                </AlertDescription>
              </Alert>
            )}

            {/* Metadata */}
            <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t">
              {match.deadline && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Calendar className="w-4 h-4" />
                  <span>Due: {format(new Date(match.deadline), 'MMM d, yyyy')}</span>
                </div>
              )}
              <Link to={createPageUrl(`GrantDetail?id=${match.grant_id}`)}>
                <Button variant="outline" size="sm">
                  View Details
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}