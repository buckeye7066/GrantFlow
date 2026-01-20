import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Target, TrendingUp, AlertTriangle, CheckCircle2, Calendar, DollarSign, ExternalLink, Sparkles, User } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { format } from 'date-fns';
import { listProfiles } from '@/api/profiles';
import { matchProfileToGrants } from '@/api/matching';

export default function ProfileMatcher() {
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [matches, setMatches] = useState(null);
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState(null);

  const { data: profiles = [], isLoading: isLoadingProfiles } = useQuery({
    queryKey: ['profiles'],
    queryFn: listProfiles,
  });

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId],
  )

  const handleMatch = async () => {
    if (!selectedProfileId) return;
    
    setIsMatching(true);
    setError(null);
    
    try {
      const response = await matchProfileToGrants(selectedProfileId)
      setMatches(Array.isArray(response) ? response : [])
    } catch (err) {
      console.error('Matching failed:', err);
      setError(err.message || 'An error occurred while matching grants');
    } finally {
      setIsMatching(false);
    }
  };

  const getMatchColor = (score) => {
    if (score >= 80) return 'text-emerald-600 bg-emerald-50 border-emerald-200';
    if (score >= 60) return 'text-blue-600 bg-blue-50 border-blue-200';
    if (score >= 40) return 'text-amber-600 bg-amber-50 border-amber-200';
    return 'text-slate-600 bg-slate-50 border-slate-200';
  };

  const getMatchLabel = (score) => {
    if (score >= 80) return 'Excellent Match';
    if (score >= 60) return 'Good Match';
    if (score >= 40) return 'Fair Match';
    return 'Low Match';
  };

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-3">
            <Target className="w-8 h-8 text-purple-600" />
            Profile Matcher
          </h1>
          <p className="text-slate-600 mt-2">
            Use AI to find which grants in your pipeline best match your profile's criteria.
          </p>
        </header>

        <Card className="shadow-lg border-0 mb-8">
          <CardHeader>
            <CardTitle>Select Profile to Match</CardTitle>
            <CardDescription>
              Choose an organization or individual profile to analyze grant compatibility
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <Select 
                  value={selectedProfileId} 
                  onValueChange={setSelectedProfileId}
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
                    Match Grants
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
                  {selectedProfile.state && ` • ${selectedProfile.state}`}
                  {selectedProfile.gpa && ` • GPA: ${selectedProfile.gpa}`}
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
            <h3 className="text-xl font-semibold text-slate-800">Analyzing Grant Matches...</h3>
            <p className="text-slate-600 mt-2">Using AI to calculate compatibility scores for each grant in your pipeline.</p>
          </div>
        )}

        {matches && matches.length === 0 && (
          <div className="text-center py-16">
            <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
            <h3 className="text-xl font-semibold text-slate-800">No Grants Found</h3>
            <p className="text-slate-600 mt-2 mb-4">
              This profile doesn't have any grants in the pipeline yet.
            </p>
            <Link to={createPageUrl('DiscoverGrants')}>
              <Button className="bg-blue-600 hover:bg-blue-700">
                Discover Grants
              </Button>
            </Link>
          </div>
        )}

        {matches && matches.length > 0 && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-slate-900">
                {matches.length} Grant{matches.length !== 1 ? 's' : ''} Analyzed
              </h2>
              <div className="text-sm text-slate-600">
                Sorted by match score
              </div>
            </div>

            <div className="grid gap-4">
              {matches.map((match) => (
                <Card key={match.grant_id} className="hover:shadow-lg transition-shadow">
                  <CardContent className="p-6">
                    <div className="flex items-start gap-6">
                      {/* Match Score Circle */}
                      <div className="flex-shrink-0">
                        <div className={`relative w-24 h-24 rounded-full border-4 flex items-center justify-center ${getMatchColor(match.match_score)}`}>
                          <div className="text-center">
                            <div className="text-2xl font-bold">{match.match_score}</div>
                            <div className="text-xs font-medium">MATCH</div>
                          </div>
                        </div>
                        <div className="text-center mt-2">
                          <Badge variant="outline" className="text-xs">
                            {getMatchLabel(match.match_score)}
                          </Badge>
                        </div>
                      </div>

                      {/* Grant Details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1 min-w-0">
                            <Link 
                              to={createPageUrl("GrantDetail", { id: match.grant_id })}
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
                          <Link to={createPageUrl("GrantDetail", { id: match.grant_id })}>
                            <Button variant="outline" size="sm">
                              View Details
                            </Button>
                          </Link>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}