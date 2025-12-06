import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus, ArrowRight } from 'lucide-react';

/**
 * Pipeline Visualization - Funnel chart showing grant progression
 * Shows conversion rates between pipeline stages
 */
export default function PipelineVisualization({ grants }) {
  const pipelineData = useMemo(() => {
    const stages = [
      { key: 'discovered', label: 'Discovered', color: 'bg-slate-500' },
      { key: 'interested', label: 'Interested', color: 'bg-blue-500' },
      { key: 'drafting', label: 'Drafting', color: 'bg-purple-500' },
      { key: 'application_prep', label: 'Application Prep', color: 'bg-amber-500' },
      { key: 'submitted', label: 'Submitted', color: 'bg-emerald-500' },
      { key: 'awarded', label: 'Awarded', color: 'bg-green-600' }
    ];

    const counts = stages.map(stage => ({
      ...stage,
      count: grants.filter(g => g.status === stage.key).length
    }));

    // Calculate conversion rates
    const withRates = counts.map((stage, idx) => {
      if (idx === 0) return { ...stage, conversionRate: 100 };
      
      const previousCount = counts[0].count; // Compare to discovered
      const rate = previousCount > 0 ? (stage.count / previousCount) * 100 : 0;
      const previousStage = counts[idx - 1];
      const stepRate = previousStage.count > 0 ? (stage.count / previousStage.count) * 100 : 0;
      
      return {
        ...stage,
        conversionRate: rate,
        stepConversionRate: stepRate
      };
    });

    return withRates;
  }, [grants]);

  const maxCount = Math.max(...pipelineData.map(s => s.count), 1);

  const getTrendIcon = (rate) => {
    if (rate >= 75) return <TrendingUp className="w-4 h-4 text-emerald-600" />;
    if (rate >= 50) return <Minus className="w-4 h-4 text-amber-600" />;
    return <TrendingDown className="w-4 h-4 text-red-600" />;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Grant Pipeline Funnel</CardTitle>
        <CardDescription>
          Conversion rates between pipeline stages
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {pipelineData.map((stage, idx) => {
            const widthPercent = (stage.count / maxCount) * 100;
            
            return (
              <div key={stage.key}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900">{stage.label}</span>
                    <Badge variant="outline">{stage.count}</Badge>
                  </div>
                  {idx > 0 && (
                    <div className="flex items-center gap-2 text-sm">
                      {getTrendIcon(stage.stepConversionRate)}
                      <span className="text-slate-600">
                        {stage.stepConversionRate.toFixed(1)}% from previous
                      </span>
                    </div>
                  )}
                </div>

                <div className="relative h-12 bg-slate-100 rounded-lg overflow-hidden">
                  <div
                    className={`h-full ${stage.color} transition-all duration-500 flex items-center justify-between px-4`}
                    style={{ width: `${widthPercent}%` }}
                  >
                    <span className="text-white font-semibold text-sm">
                      {stage.count} grants
                    </span>
                    {stage.conversionRate < 100 && (
                      <span className="text-white text-xs">
                        {stage.conversionRate.toFixed(1)}% of discovered
                      </span>
                    )}
                  </div>
                </div>

                {idx < pipelineData.length - 1 && (
                  <div className="flex justify-center my-2">
                    <ArrowRight className="w-5 h-5 text-slate-400" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Summary Stats */}
        <div className="mt-6 pt-6 border-t border-slate-200">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-slate-600">Overall Conversion</p>
              <p className="text-2xl font-bold text-slate-900">
                {pipelineData[pipelineData.length - 1]?.conversionRate.toFixed(1)}%
              </p>
              <p className="text-xs text-slate-500">Discovered to Awarded</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Success Rate</p>
              <p className="text-2xl font-bold text-emerald-600">
                {pipelineData[5]?.count || 0} / {pipelineData[4]?.count || 0}
              </p>
              <p className="text-xs text-slate-500">Awarded / Submitted</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}