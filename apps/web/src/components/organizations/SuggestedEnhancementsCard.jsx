/**
 * SUGGESTED ENHANCEMENTS CARD
 *
 * Displays profile enhancement suggestions fetched from the backend.
 * ISOLATED: Fetches data fresh for each profile_id - NO FRONTEND CACHING.
 */
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Lightbulb, MapPin, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { callFunction } from '@/components/shared/functionClient';

export default function SuggestedEnhancementsCard({ organizationId, organizationName, onScrollToSection }) {
  // Guard: Don't render if no organizationId
  const hasValidId = typeof organizationId === 'string' && organizationId.length > 10;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['suggested-enhancements', organizationId],
    queryFn: async () => {
      if (!organizationId) throw new Error('Missing organizationId');

      const fnResult = await callFunction('getSuggestedEnhancements', {
        profileId: organizationId,
        profile_id: organizationId
      });
      
      if (!fnResult.ok) throw new Error(fnResult.error || 'Failed to fetch suggestions');

      // Data is already unwrapped by callFunction
      const result = fnResult.data ?? {};

      // SENTINEL CHECK
      if (result?.profile_id && result.profile_id !== organizationId) {
        console.error('[SuggestedEnhancementsCard] CONTAMINATION:', {
          expected: organizationId,
          received: result.profile_id,
        });
        throw new Error('Cross-profile contamination detected');
      }

      // Normalize shape
      return {
        profile_id: result.profile_id || organizationId,
        profile_name: result.profile_name || organizationName || 'Unknown',
        suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
        geographic_qualifiers: Array.isArray(result.geographic_qualifiers) ? result.geographic_qualifiers : [],
        completeness: Number(result.completeness ?? 0) || 0,
        boolean_flag_count: Number(result.boolean_flag_count ?? 0) || 0,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
      };
    },
    enabled: hasValidId,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: 1,
  });

  if (isLoading) {
    return (
      <Card className="border-purple-200">
        <CardHeader className="bg-purple-50">
          <CardTitle className="flex items-center gap-2 text-purple-900">
            <Lightbulb className="w-5 h-5 text-purple-600" />
            Suggested Profile Enhancements
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-purple-600" />
          <span className="ml-2 text-slate-600">Loading suggestions...</span>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-amber-200">
        <CardHeader className="bg-amber-50">
          <CardTitle className="flex items-center gap-2 text-amber-900">
            <AlertCircle className="w-5 h-5 text-amber-600" />
            Enhancement Suggestions
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <p className="text-amber-700 text-sm">Enhancement suggestions are temporarily unavailable.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-2">
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const { suggestions, geographic_qualifiers, completeness, boolean_flag_count, warnings, profile_name } = data;

  return (
    <Card className="border-purple-200">
      {/* Warnings Banner */}
      {warnings && warnings.length > 0 && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200">
          {warnings.map((warning, idx) => (
            <p key={idx} className="text-xs text-amber-700 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {warning}
            </p>
          ))}
        </div>
      )}
      <CardHeader className="bg-purple-50">
        <CardTitle className="flex items-center justify-between text-purple-900">
          <div className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-purple-600" />
            Suggested Profile Enhancements
          </div>
          <Badge variant="outline" className="text-purple-700">
            {completeness}% Complete
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {/* Geographic Qualifiers */}
        {geographic_qualifiers && geographic_qualifiers.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <MapPin className="w-4 h-4 text-teal-600" />
              Active Geographic Qualifiers
            </div>
            <div className="flex flex-wrap gap-2">
              {geographic_qualifiers.map((qual) => (
                <Badge key={qual.key || qual.label} className="bg-teal-100 text-teal-800 border-teal-300">
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  {qual.label}
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="w-full p-3 bg-amber-50 rounded-lg border border-amber-200 cursor-pointer hover:bg-amber-100 hover:border-amber-300 transition-colors text-left relative z-10"
            style={{ pointerEvents: 'auto' }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              console.log('[SuggestedEnhancementsCard] Geographic click, scrolling to:', 'geographic');
              if (typeof onScrollToSection === 'function') {
                onScrollToSection('geographic');
              } else {
                console.warn('[SuggestedEnhancementsCard] onScrollToSection is not a function');
              }
            }}
          >
            <div className="flex items-center gap-2 text-amber-800">
              <MapPin className="w-4 h-4" />
              <span className="text-sm font-medium">No Geographic Qualifiers Set</span>
            </div>
            <p className="text-xs text-amber-700 mt-1">
              Adding geographic designations can unlock location-based funding opportunities.
              <span className="text-amber-600 font-medium ml-1">Click to add →</span>
            </p>
          </button>
        )}

        {/* Suggestions List */}
        {suggestions && suggestions.length > 0 ? (
          <div className="space-y-2">
            <div className="text-sm font-medium text-slate-700">Recommended Improvements</div>
            <div className="space-y-2">
              {suggestions.map((suggestion, idx) => {
                // Map suggestion fields to section names used by the profile details
                const sectionMapping = {
                  'mission': 'narrative',
                  'primary_goal': 'narrative',
                  'target_population': 'narrative',
                  'geographic_focus': 'narrative',
                  'special_circumstances': 'narrative',
                  'barriers_faced': 'narrative',
                  'email': 'contact',
                  'phone': 'contact',
                  'address': 'contact',
                  'city': 'contact',
                  'state': 'contact',
                  'keywords': 'keywords',
                  'focus_areas': 'focus_areas',
                  'program_areas': 'program_areas',
                  'education': 'education',
                  'demographics': 'demographics',
                  'health': 'health',
                  'financial': 'financial',
                  'military': 'military',
                  'geographic': 'geographic',
                  'cultural': 'cultural',
                  'religious': 'religious',
                  'profile': 'narrative',
                  'complete_profile': 'narrative',
                };
                
                const rawSection = suggestion.section || suggestion.field || '';
                const section = sectionMapping[rawSection] || rawSection || 'narrative';
                
                return (
                  <button
                    type="button"
                    key={suggestion.field || suggestion.section || idx}
                    className="w-full p-3 bg-slate-50 rounded-lg border border-slate-200 cursor-pointer hover:bg-blue-50 hover:border-blue-200 transition-colors text-left relative z-10"
                    style={{ pointerEvents: 'auto' }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      console.log('[SuggestedEnhancementsCard] Suggestion click:', { rawSection, mappedSection: section, suggestion });
                      if (typeof onScrollToSection === 'function') {
                        onScrollToSection(section);
                      } else {
                        console.warn('[SuggestedEnhancementsCard] onScrollToSection is not a function');
                      }
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-800">{suggestion.label}</span>
                      <span className="text-xs text-blue-600 font-medium">Edit →</span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">{suggestion.description}</p>
                  </button>
                );
              })}
            </div>
          </div>
        ) : completeness >= 80 ? (
          <div className="p-3 bg-green-50 rounded-lg border border-green-200">
            <div className="flex items-center gap-2 text-green-800">
              <CheckCircle2 className="w-4 h-4" />
              <span className="text-sm font-medium">Profile Well-Optimized</span>
            </div>
            <p className="text-xs text-green-700 mt-1">
              Your profile has {boolean_flag_count} active qualifiers and is ready for matching.
            </p>
          </div>
        ) : null}

        {/* Debug Info - Only in development */}
        <div className="text-xs text-slate-400 pt-2 border-t border-slate-100">
          Profile: {profile_name} | ID: {organizationId?.substring(0, 8)}...
        </div>
      </CardContent>
    </Card>
  );
}