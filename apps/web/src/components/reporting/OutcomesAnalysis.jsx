import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { BarChart3, Loader2, TrendingUp, Target, AlertTriangle, CheckCircle2, Lightbulb } from 'lucide-react';
import { toast } from 'sonner';

export default function OutcomesAnalysis({ grant }) {
  const [analysisType, setAnalysisType] = useState('impact');
  const [analysis, setAnalysis] = useState(null);

  const analyzeMutation = useMutation({
    mutationFn: async ({ grant_id, analysis_type }) => {
      const response = await base44.functions.invoke('analyzeProjectOutcomes', {
        body: {
          grant_id,
          analysis_type
        }
      });
      return response.data;
    },
    onSuccess: (data) => {
      setAnalysis(data.analysis);
      toast.success('Analysis complete!');
    },
    onError: (error) => {
      toast.error(`Analysis failed: ${error.message}`);
    }
  });

  const handleAnalyze = () => {
    analyzeMutation.mutate({
      grant_id: grant.id,
      analysis_type: analysisType
    });
  };

  const getHealthColor = (health) => {
    const colors = {
      excellent: 'bg-green-600',
      good: 'bg-blue-600',
      fair: 'bg-yellow-600',
      needs_improvement: 'bg-orange-600',
      at_risk: 'bg-red-600'
    };
    return colors[health] || 'bg-slate-600';
  };

  return (
    <div className="space-y-4">
      <Card className="border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-cyan-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-blue-600" />
            AI Outcomes Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Lightbulb className="h-4 w-4" />
            <AlertDescription>
              AI will analyze your KPIs, financial data, milestones, and reports to provide 
              insights about project health, trends, and recommendations.
            </AlertDescription>
          </Alert>

          <div>
            <label className="text-sm font-medium mb-2 block">Analysis Type</label>
            <Select value={analysisType} onValueChange={setAnalysisType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="impact">Impact Assessment</SelectItem>
                <SelectItem value="trends">Trend Analysis</SelectItem>
                <SelectItem value="comparison">Benchmark Comparison</SelectItem>
                <SelectItem value="narrative">Narrative Summary</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button
            onClick={handleAnalyze}
            disabled={analyzeMutation.isPending}
            className="w-full bg-gradient-to-r from-blue-600 to-cyan-600"
            size="lg"
          >
            {analyzeMutation.isPending ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <BarChart3 className="w-5 h-5 mr-2" />
                Run Analysis
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {analysis && (
        <Card className="border-2 border-green-200">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Analysis Results</CardTitle>
              {analysis.overall_health && (
                <Badge className={getHealthColor(analysis.overall_health)}>
                  {analysis.overall_health.replace(/_/g, ' ').toUpperCase()}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Summary */}
            {analysis.summary && (
              <div>
                <h3 className="font-semibold text-slate-900 mb-2">Executive Summary</h3>
                <p className="text-slate-700 text-sm whitespace-pre-wrap">{analysis.summary}</p>
              </div>
            )}

            {/* Metrics */}
            {analysis.metrics && (
              <div>
                <h3 className="font-semibold text-slate-900 mb-3">Key Metrics</h3>
                <div className="grid md:grid-cols-2 gap-3">
                  {analysis.metrics.kpi_achievement_rate && (
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-xs text-slate-600">KPI Achievement</p>
                      <p className="text-2xl font-bold text-slate-900">
                        {Math.round(analysis.metrics.kpi_achievement_rate)}%
                      </p>
                    </div>
                  )}
                  {analysis.metrics.milestone_completion_rate && (
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-xs text-slate-600">Milestone Completion</p>
                      <p className="text-2xl font-bold text-slate-900">
                        {Math.round(analysis.metrics.milestone_completion_rate)}%
                      </p>
                    </div>
                  )}
                  {analysis.metrics.budget_utilization_rate && (
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-xs text-slate-600">Budget Utilization</p>
                      <p className="text-2xl font-bold text-slate-900">
                        {Math.round(analysis.metrics.budget_utilization_rate)}%
                      </p>
                    </div>
                  )}
                  {analysis.metrics.timeline_adherence_score && (
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-xs text-slate-600">Timeline Adherence</p>
                      <p className="text-2xl font-bold text-slate-900">
                        {Math.round(analysis.metrics.timeline_adherence_score)}%
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Achievements */}
            {analysis.achievements && analysis.achievements.length > 0 && (
              <div>
                <h3 className="font-semibold text-slate-900 mb-2 flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                  Key Achievements
                </h3>
                <ul className="space-y-2">
                  {analysis.achievements.map((achievement, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm">
                      <span className="text-green-600 mt-1">✓</span>
                      <span className="text-slate-700">{achievement}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Concerns */}
            {analysis.concerns && analysis.concerns.length > 0 && (
              <div>
                <h3 className="font-semibold text-slate-900 mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-orange-600" />
                  Areas of Concern
                </h3>
                <ul className="space-y-2">
                  {analysis.concerns.map((concern, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm">
                      <span className="text-orange-600 mt-1">⚠</span>
                      <span className="text-slate-700">{concern}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recommendations */}
            {analysis.recommendations && analysis.recommendations.length > 0 && (
              <div>
                <h3 className="font-semibold text-slate-900 mb-2 flex items-center gap-2">
                  <Target className="w-5 h-5 text-blue-600" />
                  Recommendations
                </h3>
                <ul className="space-y-2">
                  {analysis.recommendations.map((rec, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm">
                      <span className="text-blue-600 mt-1">→</span>
                      <span className="text-slate-700">{rec}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Key Findings */}
            {analysis.key_findings && analysis.key_findings.length > 0 && (
              <div>
                <h3 className="font-semibold text-slate-900 mb-2">Key Findings</h3>
                <ul className="space-y-2">
                  {analysis.key_findings.map((finding, idx) => (
                    <li key={idx} className="text-sm text-slate-700 flex items-start gap-2">
                      <span className="text-slate-400">•</span>
                      {finding}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}