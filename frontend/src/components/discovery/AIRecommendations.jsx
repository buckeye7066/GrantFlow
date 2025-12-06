import React, { useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sparkles, TrendingUp, Target, ExternalLink, Plus, Search } from 'lucide-react';
import { motion } from 'framer-motion';

/** Safe key extraction: prefer id, fallback to source_id, then index */
const getRecKey = (rec, idx) => rec?.id ?? rec?.source_id ?? `rec-${idx}`;

/** Safe number formatting */
const formatCurrency = (val) => {
  const num = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(num) && num > 0 ? `$${num.toLocaleString()}` : null;
};

/** Safe date formatting */
const formatDeadline = (val) => {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
};

/** Safe external link open with try/catch */
const safeOpenUrl = (url) => {
  if (!url) return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.warn('[AIRecommendations] Could not open URL:', err?.message || err);
  }
};

export default function AIRecommendations({ profileId, recommendations, onAddToPipeline, isLoading, onRunSearch }) {
  // Validate profileId
  const validProfileId = typeof profileId === 'string' && profileId.trim()
    ? profileId.trim()
    : typeof profileId === 'number' && Number.isFinite(profileId)
    ? String(profileId)
    : null;

  // Memoize processed recommendations
  const processedRecs = useMemo(() => {
    if (!Array.isArray(recommendations)) return [];
    return recommendations.map((rec) => ({
      ...rec,
      _title: rec?.title || 'Untitled Opportunity',
      _sponsor: rec?.sponsor || rec?.funder || 'Unknown Sponsor',
      _matchScore: typeof rec?.matchScore === 'number' ? rec.matchScore : (rec?.match || 0),
      _awardFormatted: formatCurrency(rec?.awardAmount ?? rec?.awardMax ?? rec?.awardMin),
      _deadlineFormatted: formatDeadline(rec?.deadline ?? rec?.deadlineAt),
      _aiReason: rec?.aiReason || rec?.reason_text || 'AI-recommended based on your profile.',
      _reasonIcon: rec?.reason === 'similar_awards' ? 'trending' : 'target',
    }));
  }, [recommendations]);

  // Stable callback for add to pipeline
  const handleAdd = useCallback(
    (rec) => {
      if (typeof onAddToPipeline === 'function') {
        onAddToPipeline(rec);
      } else {
        console.warn('[AIRecommendations] onAddToPipeline is not a function');
      }
    },
    [onAddToPipeline]
  );

  if (!validProfileId) {
    return null;
  }

  if (isLoading) {
    return (
      <Card className="border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-purple-900">
            <Sparkles className="w-5 h-5" />
            AI Recommendations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3" role="status" aria-label="Loading recommendations">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-24 bg-white rounded-lg animate-pulse"
                aria-hidden="true"
              />
            ))}
            <span className="sr-only">Loading AI recommendations...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (processedRecs.length === 0) {
    return (
      <Card className="border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-purple-900">
            <Sparkles className="w-5 h-5" />
            AI Recommendations
          </CardTitle>
          <CardDescription>
            AI-powered suggestions based on your profile and history
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600 mb-4">
            Complete a few searches to help our AI learn your preferences and provide better recommendations.
          </p>
          {typeof onRunSearch === 'function' && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRunSearch}
              className="gap-2"
            >
              <Search className="w-4 h-4" />
              Run a Search
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-purple-900">
          <Sparkles className="w-5 h-5" />
          AI Recommendations
        </CardTitle>
        <CardDescription>
          Personalized suggestions based on your profile and application history
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {processedRecs.map((rec, idx) => (
          <motion.div
            key={getRecKey(rec, idx)}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.1 }}
          >
            <Card className="bg-white shadow-sm">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2 mb-2">
                      {rec._reasonIcon === 'trending' ? (
                        <TrendingUp className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
                      ) : (
                        <Target className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />
                      )}
                      <div className="flex-1">
                        <h4 className="font-semibold text-sm text-slate-900 line-clamp-1">
                          {rec._title}
                        </h4>
                        <p className="text-xs text-slate-600 mt-1">
                          {rec._sponsor}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <Badge variant="outline" className="text-xs">
                        {rec._matchScore}% match
                      </Badge>
                      {rec._awardFormatted && (
                        <Badge variant="outline" className="text-xs text-emerald-700 border-emerald-200 bg-emerald-50">
                          {rec._awardFormatted}
                        </Badge>
                      )}
                      {rec._deadlineFormatted && (
                        <Badge variant="outline" className="text-xs">
                          Due: {rec._deadlineFormatted}
                        </Badge>
                      )}
                    </div>

                    <p className="text-xs text-slate-600 italic">
                      {rec._aiReason}
                    </p>
                  </div>

                  <div className="flex flex-col gap-1 shrink-0">
                    {rec.url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => safeOpenUrl(rec.url)}
                        aria-label={`Open ${rec._title} in new tab`}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                      onClick={() => handleAdd(rec)}
                      aria-label={`Add ${rec._title} to pipeline`}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </CardContent>
    </Card>
  );
}