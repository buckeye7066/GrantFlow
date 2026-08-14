import React, { useMemo, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { canonicalMatchDisplay } from '@/lib/matchDisplayThresholds';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Target, AlertTriangle, CheckCircle2, Calendar, DollarSign, ExternalLink, Sparkles, User, Plus, Check } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { format } from 'date-fns';
import { listProfiles } from '@/api/profiles';
import { matchProfileToOpportunities } from '@/api/matching';
import { apiFetch } from '@/api/client';
import { formatReasonText } from '@/utils/reasonText';

export default function ProfileMatcher() {
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [matches, setMatches] = useState(null);
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState(null);

  // Checkbox selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [addedIds, setAddedIds] = useState(new Set());

  const { toast } = useToast();

  const { data: profiles = [], isLoading: isLoadingProfiles } = useQuery({
    queryKey: ['profiles'],
    queryFn: listProfiles,
  });

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId],
  );

  const handleMatch = async () => {
    if (!selectedProfileId) return;

    setIsMatching(true);
    setError(null);
    setMatches(null);
    setSelectedIds(new Set());
    setAddedIds(new Set());

    try {
      const response = await matchProfileToOpportunities(selectedProfileId);
      const payload = response?.data ?? response ?? {};
      const opps = payload?.opportunities ?? payload?.results ?? [];
      if (Array.isArray(opps)) {
        setMatches(opps);
      } else {
        console.warn('[ProfileMatcher] Unexpected response shape:', response);
        setMatches([]);
        setError('Match service returned an unexpected response format.');
      }
    } catch (err) {
      console.error('Matching failed:', err);
      setError(err.message || 'An error occurred while matching opportunities');
    } finally {
      setIsMatching(false);
    }
  };

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!matches) return;
    const addable = matches.filter((m) => m.id && !addedIds.has(m.id));
    if (selectedIds.size >= addable.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(addable.map((m) => m.id)));
    }
  }, [matches, selectedIds, addedIds]);

  const handleAddToPipeline = async () => {
    if (!selectedProfile || selectedIds.size === 0) return;

    setIsAdding(true);
    let successCount = 0;
    let failCount = 0;

    for (const oppId of selectedIds) {
      const opp = matches.find((m) => m.id === oppId);
      if (!opp) continue;

      try {
        await apiFetch('/api/grants/from-opportunity', {
          method: 'POST',
          headers: { 'X-Profile-Id': selectedProfile.id },
          body: JSON.stringify({
            opportunity_id: opp.id || null,
            profile_id: selectedProfile.id,
            organization_id: selectedProfile.organization_id || null,
            opportunity_data: {
              title: opp.title,
              sponsor: opp.sponsor || opp.funder,
              deadline: opp.deadline,
              application_url: opp.application_url || null,
              url: opp.url || opp.source_url || null,
              awardMin: opp.amount_min,
              awardMax: opp.amount_max,
              descriptionMd: opp.description,
              eligibilityBullets: opp.eligibility_bullets || [],
              source: opp.source || 'database',
            },
          }),
        });
        successCount++;
        setAddedIds((prev) => new Set(prev).add(oppId));
      } catch (err) {
        failCount++;
        console.warn(`Failed to add ${opp.title}:`, err?.message);
      }
    }

    setSelectedIds(new Set());
    setIsAdding(false);

    if (successCount > 0) {
      toast({
        title: `Added ${successCount} to pipeline`,
        description: `${successCount} funding source${successCount !== 1 ? 's' : ''} added for ${selectedProfile.display_name || selectedProfile.name || 'the selected profile'}.${failCount > 0 ? ` ${failCount} failed.` : ''}`,
      });
    } else if (failCount > 0) {
      toast({
        variant: 'destructive',
        title: 'Failed to add',
        description: `${failCount} funding source${failCount !== 1 ? 's' : ''} could not be added. They may already be in the pipeline.`,
      });
    }
  };

  // Bands come from the canonical display contract — never inline cutoffs, and
  // never a tier derived from the score ALONE. `canonicalMatchDisplay` refuses
  // to promote a row the backend never decided on: a missing/unknown
  // match_decision reads "Unrated", not "Low Match" (which asserts a verdict
  // the engine never issued), and a REVIEW row reads "Needs review" instead of
  // borrowing an ACCEPT-band label off its number.
  const TIER_CLASSES = {
    excellent: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    good: 'text-blue-600 bg-blue-50 border-blue-200',
    fair: 'text-amber-600 bg-amber-50 border-amber-200',
    potential: 'text-amber-600 bg-amber-50 border-amber-200',
    low: 'text-slate-600 bg-slate-50 border-slate-200',
    review: 'text-amber-600 bg-amber-50 border-amber-200',
    rejected: 'text-red-600 bg-red-50 border-red-200',
    unrated: 'text-slate-400 bg-slate-50 border-slate-200',
  };

  const matchDisplayFor = (opp) =>
    canonicalMatchDisplay({
      score: opp?.match_score,
      decision: opp?.match_decision ?? opp?.decision,
    });

  const addableMatches = matches?.filter((m) => m.id && !addedIds.has(m.id)) ?? [];

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-3">
            <Target className="w-8 h-8 text-purple-600" />
            Profile Matcher
          </h1>
          <p className="text-slate-600 mt-2">
            Discover funding opportunities that match your profile and add them to your pipeline.
          </p>
        </header>

        <Card className="shadow-lg border-0 mb-8">
          <CardHeader>
            <CardTitle>Select Profile to Match</CardTitle>
            <CardDescription>
              Choose an organization or individual profile to find matching funding opportunities
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <Select
                  value={selectedProfileId || undefined}
                  onValueChange={(v) => setSelectedProfileId(v ?? '')}
                  disabled={isLoadingProfiles || isMatching}
                >
                  <SelectTrigger className="h-12">
                    <SelectValue placeholder="Select a profile..." />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map(profile => (
                      <SelectItem key={profile.id} value={profile.id}>
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4" />
                          {profile.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={handleMatch}
                disabled={!selectedProfileId || isMatching}
                className="bg-purple-600 hover:bg-purple-700"
                size="lg"
              >
                {isMatching ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5 mr-2" />
                    Find Matches
                  </>
                )}
              </Button>
            </div>

            {selectedProfile && (
              <Alert className="bg-blue-50 border-blue-200">
                <User className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-blue-800">
                  <strong>Selected Profile:</strong> {selectedProfile.name}{' '}
                  ({(selectedProfile.primary_type || selectedProfile.applicant_type || 'profile').replace(/_/g, ' ')})
                  {selectedProfile.state && ` \u2022 ${selectedProfile.state}`}
                  {selectedProfile.gpa && ` \u2022 GPA: ${selectedProfile.gpa}`}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive" className="mb-8">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {isMatching && (
          <div className="text-center py-16">
            <Loader2 className="w-12 h-12 mx-auto text-purple-600 mb-4 animate-spin" />
            <h3 className="text-xl font-semibold text-slate-800">Searching Funding Catalog...</h3>
            <p className="text-slate-600 mt-2">Matching your profile against available funding opportunities.</p>
          </div>
        )}

        {matches && matches.length === 0 && (
          <div className="text-center py-16">
            <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
            <h3 className="text-xl font-semibold text-slate-800">No Matching Opportunities Found</h3>
            <p className="text-slate-600 mt-2">
              Try updating your profile with more details or running a crawl to discover new funding sources.
            </p>
          </div>
        )}

        {matches && matches.length > 0 && (
          <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white border rounded-lg p-4 shadow-sm sticky top-0 z-10">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="select-all"
                    checked={addableMatches.length > 0 && selectedIds.size >= addableMatches.length}
                    onCheckedChange={toggleSelectAll}
                    disabled={addableMatches.length === 0}
                  />
                  <label htmlFor="select-all" className="text-sm font-medium text-slate-700 cursor-pointer select-none">
                    Select All
                  </label>
                </div>
                <span className="text-sm text-slate-500">
                  {matches.length} opportunit{matches.length !== 1 ? 'ies' : 'y'} found
                  {selectedIds.size > 0 && (
                    <span className="font-medium text-purple-700"> &middot; {selectedIds.size} selected</span>
                  )}
                  {addedIds.size > 0 && (
                    <span className="font-medium text-emerald-700"> &middot; {addedIds.size} added</span>
                  )}
                </span>
              </div>

              <Button
                onClick={handleAddToPipeline}
                disabled={selectedIds.size === 0 || isAdding}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {isAdding ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
                    Add {selectedIds.size > 0 ? selectedIds.size : ''} to Pipeline
                  </>
                )}
              </Button>
            </div>

            {/* Results */}
            <div className="grid gap-4">
              {matches.map((opp) => {
                const isSelected = selectedIds.has(opp.id);
                const wasAdded = addedIds.has(opp.id);
                const fit = matchDisplayFor(opp);

                return (
                  <Card
                    key={opp.id}
                    className={`transition-all cursor-pointer ${
                      wasAdded
                        ? 'border-emerald-300 bg-emerald-50/30'
                        : isSelected
                        ? 'border-purple-300 bg-purple-50/30 shadow-md'
                        : 'hover:shadow-lg'
                    }`}
                    onClick={() => !wasAdded && toggleSelect(opp.id)}
                  >
                    <CardContent className="p-6">
                      <div className="flex items-start gap-4">
                        {/* Checkbox */}
                        <div className="flex-shrink-0 pt-1" onClick={(e) => e.stopPropagation()}>
                          {wasAdded ? (
                            <div className="w-5 h-5 rounded bg-emerald-600 flex items-center justify-center">
                              <Check className="w-3.5 h-3.5 text-white" />
                            </div>
                          ) : (
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleSelect(opp.id)}
                            />
                          )}
                        </div>

                        {/* Match Score */}
                        <div className="flex-shrink-0">
                          <div className={`relative w-16 h-16 rounded-full border-[3px] flex items-center justify-center ${TIER_CLASSES[fit.tier] ?? TIER_CLASSES.unrated}`}>
                            <div className="text-center">
                              <div className="text-lg font-bold">{fit.score ?? '-'}</div>
                              <div className="text-[9px] font-medium uppercase">Match</div>
                            </div>
                          </div>
                          <div className="text-center mt-1">
                            <Badge variant="outline" className="text-[10px] px-1">
                              {fit.label}
                            </Badge>
                          </div>
                        </div>

                        {/* Details */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex-1 min-w-0">
                              <h3 className="text-base font-bold text-slate-900 leading-snug">
                                {opp.title}
                              </h3>
                              <p className="text-slate-600 text-sm mt-0.5">{opp.sponsor}</p>
                            </div>
                            {wasAdded && (
                              <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 ml-3 shrink-0">
                                Added
                              </Badge>
                            )}
                          </div>

                          {/* Match Reasons */}
                          {opp.match_reasons && opp.match_reasons.length > 0 && (
                            <div className="mb-2">
                              <div className="flex items-center gap-1.5 mb-1">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                <span className="text-xs font-semibold text-slate-600">Why This Matches:</span>
                              </div>
                              <ul className="flex flex-wrap gap-1.5">
                                {opp.match_reasons.slice(0, 5).map((reason, idx) => {
                                  const text = formatReasonText(reason)
                                  return text ? (
                                    <li key={idx}>
                                      <Badge variant="outline" className="text-xs font-normal bg-emerald-50 text-emerald-800 border-emerald-200">
                                        {text}
                                      </Badge>
                                    </li>
                                  ) : null
                                })}
                                {opp.match_reasons.length > 5 && (
                                  <li>
                                    <Badge variant="outline" className="text-xs text-slate-500">
                                      +{opp.match_reasons.length - 5} more
                                    </Badge>
                                  </li>
                                )}
                              </ul>
                            </div>
                          )}

                          {/* Metadata */}
                          <div className="flex flex-wrap items-center gap-3 mt-3 pt-2 border-t border-slate-100">
                            {opp.deadline && (
                              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                <Calendar className="w-3.5 h-3.5" />
                                <span>{(() => { const d = new Date(opp.deadline); return isNaN(d.getTime()) ? 'Rolling' : format(d, 'MMM d, yyyy'); })()}</span>
                              </div>
                            )}
                            {(opp.amount_min || opp.amount_max) && (
                              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                <DollarSign className="w-3.5 h-3.5" />
                                <span>
                                  {opp.amount_min && opp.amount_max
                                    ? `${Number(opp.amount_min).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} - ${Number(opp.amount_max).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`
                                    : `Up to ${Number(opp.amount_max || opp.amount_min).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`}
                                </span>
                              </div>
                            )}
                            {opp.state && (
                              <Badge variant="outline" className="text-xs">{opp.state}</Badge>
                            )}
                            {(opp.url || opp.application_url || opp.source_url) && (
                              <a
                                href={opp.url || opp.application_url || opp.source_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="w-3 h-3" />
                                View Source
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
