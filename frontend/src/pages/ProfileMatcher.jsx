import React, { useEffect } from 'react';
import { Target, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Custom hook
import { useProfileMatcher } from '@/components/hooks/useProfileMatcher';

// UI Components
import ProfileSelectPanel from '@/components/profile-matcher/ProfileSelectPanel';
import SelectedProfileAlert from '@/components/profile-matcher/SelectedProfileAlert';
import MatchResultCard from '@/components/profile-matcher/MatchResultCard';
import MatchLoading from '@/components/profile-matcher/MatchLoading';
import MatchError from '@/components/profile-matcher/MatchError';
import MatchEmptyState from '@/components/profile-matcher/MatchEmptyState';

export default function ProfileMatcher() {
  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  const {
    organizations,
    isLoadingOrgs,
    selectedOrgId,
    setSelectedOrgId,
    selectedOrg,
    matches,
    isMatching,
    error,
    handleMatch,
  } = useProfileMatcher({
    user,
    isAdmin,
    enabled: !!user?.email,
  });

  // Validate selected org is in authorized list
  useEffect(() => {
    if (selectedOrgId && organizations.length > 0 && !organizations.some(o => o.id === selectedOrgId)) {
      setSelectedOrgId('');
    }
  }, [selectedOrgId, organizations, setSelectedOrgId]);

  // Combined loading state
  if (isLoadingUser || isLoadingOrgs) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-3">
            <Target className="w-8 h-8 text-purple-600" />
            Profile Matcher
          </h1>
          <p className="text-slate-600 mt-2">
            AI-powered matching of grants to profile criteria
          </p>
        </header>

        {/* Profile Selection */}
        <div className="mb-8">
          <ProfileSelectPanel
            organizations={organizations}
            selectedOrgId={selectedOrgId}
            onSelectOrg={setSelectedOrgId}
            onMatch={handleMatch}
            isLoading={isLoadingOrgs}
            isMatching={isMatching}
          />
        </div>

        {/* Selected Profile Info */}
        {selectedOrg && (
          <div className="mb-8">
            <SelectedProfileAlert organization={selectedOrg} />
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="mb-8">
            <MatchError error={error} />
          </div>
        )}

        {/* Loading State */}
        {isMatching && <MatchLoading />}

        {/* Empty State - No Matches */}
        {matches && matches.length === 0 && !isMatching && (
          <MatchEmptyState />
        )}

        {/* Results */}
        {matches && matches.length > 0 && !isMatching && (
          <div className="space-y-6" role="region" aria-live="polite">
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
                <MatchResultCard key={match.grant_id} match={match} />
              ))}
            </div>
          </div>
        )}

        {/* Initial State */}
        {!matches && !isMatching && !error && (
          <MatchEmptyState
            message="Ready to Discover Matches"
            showDiscoverButton={false}
          />
        )}
      </div>
    </div>
  );
}