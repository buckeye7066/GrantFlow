import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Sparkles, TrendingUp, Clock, Target, ChevronRight, Zap } from 'lucide-react';
import { formatDateSafe } from '@/components/shared/dateUtils';

/**
 * Proactive AI-powered grant suggestions based on student profile and pipeline
 */
export default function ProactiveSuggestions({ 
  organizationId, 
  organization, 
  pipelineGrants,
  onAddToPipeline 
}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [suggestions, setSuggestions] = useState(null);

  const generateProactiveSuggestions = async () => {
    if (!organization) return;
    
    setIsGenerating(true);
    
    try {
      // Build profile summary for LLM
      const profileSummary = buildProfileSummary(organization);
      const pipelineSummary = buildPipelineSummary(pipelineGrants);
      
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `You are a scholarship advisor AI. Based on this student's profile and current pipeline, suggest proactive actions and grant strategies.

STUDENT PROFILE:
${profileSummary}

CURRENT PIPELINE (${pipelineGrants.length} grants):
${pipelineSummary}

Provide:
1. 3 specific grant types or scholarships they should be searching for based on their unique profile
2. 2-3 upcoming deadlines or time-sensitive opportunities they should be aware of for students like them
3. 3 specific actions to improve their scholarship competitiveness
4. Any gaps in their profile that are limiting their matches

Return as JSON.`,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          properties: {
            recommended_search_categories: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  category: { type: "string" },
                  reason: { type: "string" },
                  example_scholarships: { type: "array", items: { type: "string" } },
                  typical_amount: { type: "string" },
                  urgency: { type: "string", enum: ["high", "medium", "low"] }
                }
              }
            },
            time_sensitive_opportunities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  deadline_info: { type: "string" },
                  why_relevant: { type: "string" },
                  action_required: { type: "string" }
                }
              }
            },
            improvement_actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  action: { type: "string" },
                  impact: { type: "string" },
                  timeframe: { type: "string" },
                  priority: { type: "string", enum: ["high", "medium", "low"] }
                }
              }
            },
            profile_gaps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  gap: { type: "string" },
                  how_to_fix: { type: "string" },
                  scholarships_unlocked: { type: "string" }
                }
              }
            },
            overall_strategy: { type: "string" }
          }
        }
      });
      
      setSuggestions(response);
    } catch (error) {
      console.error('Failed to generate suggestions:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const buildProfileSummary = (org) => {
    const parts = [];
    parts.push(`Name: ${org.name}`);
    parts.push(`Type: ${org.applicant_type?.replace(/_/g, ' ')}`);
    if (org.gpa) parts.push(`GPA: ${org.gpa}`);
    if (org.test_scores?.sat) parts.push(`SAT: ${org.test_scores.sat}`);
    if (org.test_scores?.act) parts.push(`ACT: ${org.test_scores.act}`);
    if (org.intended_major) parts.push(`Major: ${org.intended_major}`);
    if (org.state) parts.push(`State: ${org.state}`);
    if (org.extracurricular_activities?.length) {
      parts.push(`Activities: ${org.extracurricular_activities.join(', ')}`);
    }
    if (org.community_service_hours) parts.push(`Service Hours: ${org.community_service_hours}`);
    if (org.race_ethnicity?.length) parts.push(`Background: ${org.race_ethnicity.join(', ')}`);
    if (org.household_income) parts.push(`Household Income: $${org.household_income.toLocaleString()}`);
    if (org.first_generation) parts.push('First Generation Student');
    if (org.focus_areas?.length) parts.push(`Focus Areas: ${org.focus_areas.join(', ')}`);
    return parts.join('\n');
  };

  const buildPipelineSummary = (grants) => {
    if (!grants?.length) return 'No grants in pipeline yet.';
    
    const byStatus = {};
    grants.forEach(g => {
      byStatus[g.status] = (byStatus[g.status] || 0) + 1;
    });
    
    const statusSummary = Object.entries(byStatus)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
    
    const recentTitles = grants.slice(0, 5).map(g => g.title).join(', ');
    
    return `Status breakdown: ${statusSummary}\nRecent grants: ${recentTitles}`;
  };

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'high': return 'bg-red-100 text-red-800 border-red-300';
      case 'medium': return 'bg-amber-100 text-amber-800 border-amber-300';
      case 'low': return 'bg-green-100 text-green-800 border-green-300';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  return (
    <Card className="border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-purple-600" />
            AI Proactive Suggestions
          </span>
          <Button
            size="sm"
            onClick={generateProactiveSuggestions}
            disabled={isGenerating || !organization}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                {suggestions ? 'Refresh' : 'Generate'}
              </>
            )}
          </Button>
        </CardTitle>
      </CardHeader>
      
      <CardContent>
        {!suggestions && !isGenerating && (
          <div className="text-center py-6 text-slate-600">
            <Sparkles className="w-12 h-12 mx-auto text-purple-300 mb-3" />
            <p>Click "Generate" to get personalized scholarship strategies based on your profile.</p>
          </div>
        )}

        {isGenerating && (
          <div className="text-center py-8">
            <Loader2 className="w-8 h-8 mx-auto animate-spin text-purple-600 mb-3" />
            <p className="text-slate-600">Analyzing your profile and finding opportunities...</p>
          </div>
        )}

        {suggestions && !isGenerating && (
          <div className="space-y-6">
            {/* Overall Strategy */}
            {suggestions.overall_strategy && (
              <Alert className="bg-white border-purple-200">
                <Target className="w-4 h-4 text-purple-600" />
                <AlertDescription className="text-slate-800">
                  <strong>Your Strategy:</strong> {suggestions.overall_strategy}
                </AlertDescription>
              </Alert>
            )}

            {/* Recommended Search Categories */}
            {suggestions.recommended_search_categories?.length > 0 && (
              <div>
                <h4 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <Target className="w-4 h-4 text-blue-600" />
                  Scholarships to Search For
                </h4>
                <div className="space-y-3">
                  {suggestions.recommended_search_categories.map((cat, idx) => (
                    <div key={idx} className="bg-white rounded-lg p-4 border">
                      <div className="flex items-start justify-between mb-2">
                        <h5 className="font-semibold text-slate-900">{cat.category}</h5>
                        <Badge className={getPriorityColor(cat.urgency)}>
                          {cat.urgency} priority
                        </Badge>
                      </div>
                      <p className="text-sm text-slate-600 mb-2">{cat.reason}</p>
                      {cat.typical_amount && (
                        <p className="text-sm text-green-700 font-medium">💰 Typical: {cat.typical_amount}</p>
                      )}
                      {cat.example_scholarships?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {cat.example_scholarships.map((ex, i) => (
                            <Badge key={i} variant="outline" className="text-xs">{ex}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Time Sensitive Opportunities */}
            {suggestions.time_sensitive_opportunities?.length > 0 && (
              <div>
                <h4 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-red-600" />
                  Time-Sensitive Opportunities
                </h4>
                <div className="space-y-2">
                  {suggestions.time_sensitive_opportunities.map((opp, idx) => (
                    <div key={idx} className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-semibold text-red-900">{opp.name}</p>
                          <p className="text-sm text-red-700">⏰ {opp.deadline_info}</p>
                        </div>
                      </div>
                      <p className="text-sm text-slate-600 mt-1">{opp.why_relevant}</p>
                      {opp.action_required && (
                        <p className="text-sm text-slate-800 mt-2 font-medium">
                          → {opp.action_required}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Improvement Actions */}
            {suggestions.improvement_actions?.length > 0 && (
              <div>
                <h4 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-green-600" />
                  Actions to Improve Your Chances
                </h4>
                <div className="space-y-2">
                  {suggestions.improvement_actions.map((action, idx) => (
                    <div key={idx} className="bg-white rounded-lg p-3 border flex items-start gap-3">
                      <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                        action.priority === 'high' ? 'bg-red-500' :
                        action.priority === 'medium' ? 'bg-amber-500' : 'bg-green-500'
                      }`} />
                      <div className="flex-1">
                        <p className="font-medium text-slate-800">{action.action}</p>
                        <p className="text-sm text-slate-600">{action.impact}</p>
                        {action.timeframe && (
                          <p className="text-xs text-slate-500 mt-1">📅 {action.timeframe}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Profile Gaps */}
            {suggestions.profile_gaps?.length > 0 && (
              <div>
                <h4 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <ChevronRight className="w-4 h-4 text-amber-600" />
                  Profile Gaps Limiting Matches
                </h4>
                <div className="space-y-2">
                  {suggestions.profile_gaps.map((gap, idx) => (
                    <div key={idx} className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <p className="font-medium text-amber-900">{gap.gap}</p>
                      <p className="text-sm text-amber-800">Fix: {gap.how_to_fix}</p>
                      {gap.scholarships_unlocked && (
                        <p className="text-sm text-green-700 mt-1">🔓 Unlocks: {gap.scholarships_unlocked}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}