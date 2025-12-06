import React, { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  AlertTriangle,
  Sparkles,
  Loader2,
  CheckCircle2,
  ArrowRight,
  Info
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import AutoDiscoveryButton from '@/components/discovery/AutoDiscoveryButton';

export default function ProfileCompletenessAlert({ organization, showIfComplete = false }) {
  const [showDetails, setShowDetails] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Calculate completeness
  const calculateCompleteness = () => {
    const criticalFields = [
      { name: 'mission', label: 'Mission Statement' },
      { name: 'focus_areas', label: 'Focus Areas' },
      { name: 'program_areas', label: 'Program Areas' },
      { name: 'target_population', label: 'Target Population' },
      { name: 'primary_goal', label: 'Primary Goal' },
      { name: 'keywords', label: 'Keywords' },
    ];

    const fieldStatus = criticalFields.map(field => {
      const value = organization[field.name];
      let filled = false;
      let count = 0;

      if (Array.isArray(value)) {
        filled = value.length > 0;
        count = value.length;
      } else if (typeof value === 'string') {
        filled = value.trim().length > 10;
        count = filled ? 1 : 0;
      }

      return {
        ...field,
        filled,
        count
      };
    });

    const filledCount = fieldStatus.filter(f => f.filled).length;
    const percentage = Math.round((filledCount / criticalFields.length) * 100);

    // Check boolean flags
    const trueFlags = Object.keys(organization).filter(k => organization[k] === true).length;

    return {
      percentage,
      filledCount,
      totalCount: criticalFields.length,
      fieldStatus,
      trueFlags,
      isGood: percentage >= 70,
      isOk: percentage >= 50 && percentage < 70,
      isPoor: percentage < 50
    };
  };

  const enrichMutation = useMutation({
    mutationFn: async () => {
      const response = await base44.functions.invoke('enrichProfileForSearch', {
        body: { organization_id: organization.id }
      });

      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Enrichment failed');
      }

      return response.data;
    },
    onSuccess: async (data) => {
      // Apply enrichment to profile
      try {
        await base44.entities.Organization.update(organization.id, data.enriched_data);

        queryClient.invalidateQueries({ queryKey: ['organizations'] });

        const improvements = data.improvements || {};
        const added = improvements.keywords_added + improvements.focus_areas_added + improvements.program_areas_added;

        toast({
          title: '✨ Profile Enriched!',
          description: `Added ${added} new search terms. Completeness: ${data.preview.before_completeness}% → ${data.preview.after_completeness}%`,
          duration: 6000,
        });
      } catch (updateError) {
        throw new Error(`Failed to save enrichment: ${updateError.message}`);
      }
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Enrichment Failed',
        description: error.message || 'Could not enrich profile',
      });
    }
  });

  const completeness = calculateCompleteness();

  // Don't show if profile is complete and showIfComplete is false
  if (completeness.isGood && !showIfComplete) {
    return null;
  }

  const getAlertVariant = () => {
    if (completeness.isPoor) return 'destructive';
    if (completeness.isOk) return 'default';
    return 'default';
  };

  const getAlertColor = () => {
    if (completeness.isPoor) return 'from-red-50 to-orange-50 border-red-300';
    if (completeness.isOk) return 'from-amber-50 to-yellow-50 border-amber-300';
    return 'from-green-50 to-emerald-50 border-green-300';
  };

  return (
    <Alert className={`${getAlertColor()} border-2`}>
      <AlertTriangle className={`h-5 w-5 ${completeness.isPoor ? 'text-red-600' : completeness.isOk ? 'text-amber-600' : 'text-green-600'}`} />
      <AlertDescription>
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-2">
              <strong className="text-lg">
                {completeness.isPoor && '⚠️ Profile Needs More Data'}
                {completeness.isOk && '📊 Profile Could Use More Details'}
                {completeness.isGood && '✅ Profile Well-Populated'}
              </strong>
              <Badge variant={completeness.isPoor ? 'destructive' : 'outline'} className="text-base px-3">
                {completeness.percentage}% Complete
              </Badge>
            </div>

            <Progress value={completeness.percentage} className="h-3 mb-3" />

            <p className="text-sm mb-3">
              {completeness.isPoor && (
                <>
                  <strong>Search results will be poor with {completeness.percentage}% data.</strong> The AI needs more profile information to find relevant funding opportunities.
                  Missing critical fields like mission, focus areas, and keywords means you'll get either nothing or irrelevant matches.
                </>
              )}
              {completeness.isOk && (
                <>
                  Your profile has basic info, but adding more details will significantly improve search quality.
                  Currently {completeness.filledCount}/{completeness.totalCount} critical fields populated.
                </>
              )}
              {completeness.isGood && (
                <>
                  Great job! Your profile is well-populated with {completeness.filledCount}/{completeness.totalCount} critical fields.
                  Search results should be highly relevant.
                </>
              )}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => enrichMutation.mutate()}
              disabled={enrichMutation.isPending}
              size="sm"
              className="bg-purple-600 hover:bg-purple-700"
            >
              {enrichMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Analyzing Profile...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  AI: Auto-Complete Profile
                </>
              )}
            </Button>

            {completeness.isGood && (
              <AutoDiscoveryButton
                profileId={organization.id}
                profileName={organization.name}
                disabled={enrichMutation.isPending}
              />
            )}

            <Button
              onClick={() => setShowDetails(!showDetails)}
              variant="outline"
              size="sm"
            >
              <Info className="w-4 h-4 mr-2" />
              {showDetails ? 'Hide' : 'Show'} Details
            </Button>
          </div>

          {showDetails && (
            <div className="mt-4 p-4 bg-white rounded-lg border border-slate-200 space-y-2">
              <p className="text-sm font-semibold text-slate-900 mb-3">Field Status:</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {completeness.fieldStatus.map(field => (
                  <div key={field.name} className="flex items-center gap-2 text-sm">
                    {field.filled ? (
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-600" />
                    )}
                    <span className={field.filled ? 'text-green-700' : 'text-slate-600'}>
                      {field.label}
                      {field.count > 0 && ` (${field.count})`}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-3 pt-3 border-t border-slate-200">
                <p className="text-xs text-slate-600">
                  <strong>Demographic Flags:</strong> {completeness.trueFlags} criteria checked
                  {completeness.trueFlags < 5 && ' (Need 5+ for better matching)'}
                </p>
              </div>
            </div>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}