import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Loader2, Zap, CheckCircle, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AUTO_ADD_SCORE,
  MIN_SCORE_SLIDER_MAX,
  MIN_SCORE_SLIDER_HELP,
  minScoreBandLabel,
  translateLegacyMinScore,
} from '@/lib/matchDisplayThresholds';

// Platform default display floor (backend DEFAULT_MIN_SCORE = the pipeline bar
// on the data-point scale); shown when the profile has no stored preference.
// The stored preference feeds run-smart's explicit-min path server-side — it
// never changes the platform floor itself.
const PLATFORM_DEFAULT_MIN_SCORE = AUTO_ADD_SCORE;

/**
 * Per-profile discovery settings. The min-match-score slider persists to the
 * REAL preferences API (PUT /api/profiles/:id/discovery-preferences) and
 * run-smart uses the stored value as its default min_match_score — replacing
 * the dead legacy Base44 `AutomatedSearch` entity path nothing ever read.
 * `organization` is a mapped profile (id = profile id, see Organizations.jsx).
 */
export default function AutomatedSearchConfig({ organization, open, onClose }) {
  const queryClient = useQueryClient();
  const [minScore, setMinScore] = useState(PLATFORM_DEFAULT_MIN_SCORE);
  const [runResult, setRunResult] = useState(null);

  const orgId = organization?.id;

  const { data: prefs, isLoading: isLoadingConfig } = useQuery({
    queryKey: ['discoveryPreferences', orgId],
    queryFn: () => apiFetch(`/api/profiles/${orgId}/discovery-preferences`),
    enabled: !!orgId && open,
  });

  useEffect(() => {
    if (!open) { setRunResult(null); return; }
    const stored = prefs?.discovery?.min_match_score;
    // Old-scale stored preferences (>30, e.g. a stuck 85) are translated to
    // the equivalent data-point band on read — the backend persists the
    // translation, this keeps the dialog honest even against a stale response.
    setMinScore(typeof stored === 'number' || !isNaN(Number(stored)) ? translateLegacyMinScore(Number(stored)) : PLATFORM_DEFAULT_MIN_SCORE);
  }, [prefs, open]);

  const saveMutation = useMutation({
    mutationFn: (value) =>
      apiFetch(`/api/profiles/${orgId}/discovery-preferences`, {
        method: 'PUT',
        body: JSON.stringify({ min_match_score: value }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discoveryPreferences', orgId] });
      onClose();
    },
  });

  const runNowMutation = useMutation({
    // No explicit minMatchScore: the server applies this profile's stored
    // preference, which is exactly the wiring this dialog configures.
    mutationFn: async () => {
      await apiFetch(`/api/profiles/${orgId}/discovery-preferences`, {
        method: 'PUT',
        body: JSON.stringify({ min_match_score: minScore }),
      });
      // Intentionally omits min_match_score so the server resolves the stored
      // preference — proving the end-to-end wiring this dialog configures.
      return apiFetch('/api/real-crawlers/run-smart', {
        method: 'POST',
        body: JSON.stringify({ profile_id: orgId }),
      });
    },
    onSuccess: (response) => {
      setRunResult({ count: Number(response?.count ?? 0), partial: Boolean(response?.partial) });
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      queryClient.invalidateQueries({ queryKey: ['discoveryPreferences', orgId] });
    },
  });

  const isSaving = saveMutation.isPending;
  const isRunning = runNowMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-blue-600" />
            Discovery Settings
          </DialogTitle>
          <DialogDescription>
            Set the minimum match score for "{organization?.name}". Smart funding searches for this profile
            will only return opportunities scoring at or above this threshold.
          </DialogDescription>
        </DialogHeader>

        {isLoadingConfig ? (
          <div className="flex justify-center items-center h-40">
            <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
          </div>
        ) : (
          <div className="space-y-6 py-4">
            <Alert className="bg-blue-50 border-blue-200">
              <Info className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 text-sm">
                This preference is saved to the profile and applied automatically whenever a smart funding
                search runs without its own threshold. The platform default is a score of {PLATFORM_DEFAULT_MIN_SCORE}.
              </AlertDescription>
            </Alert>

            <div className="space-y-3">
              <Label>Minimum match score: Score &ge; {minScore} &middot; {minScoreBandLabel(minScore)}</Label>
              <Slider
                value={[minScore]}
                onValueChange={(values) => setMinScore(values[0])}
                min={0}
                max={MIN_SCORE_SLIDER_MAX}
                step={1}
                className="w-full"
              />
              <p className="text-xs text-slate-500">
                {MIN_SCORE_SLIDER_HELP}
              </p>
            </div>

            {runResult && (
              <div className="text-sm text-slate-600 pt-4 border-t">
                <p>
                  Search finished: {runResult.count} opportunit{runResult.count === 1 ? 'y' : 'ies'} found
                  {runResult.partial ? ' so far (still running in the background)' : ''}.
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={isSaving || isRunning}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => runNowMutation.mutate()}
            disabled={isSaving || isRunning || isLoadingConfig}
          >
            {isRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 mr-2" />
                Save & Run Now
              </>
            )}
          </Button>
          <Button onClick={() => saveMutation.mutate(minScore)} disabled={isSaving || isRunning || isLoadingConfig}>
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 mr-2" />
                Save Settings
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
