import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Brain, Loader2 } from "lucide-react";
import ScoringSetup from "@/components/scoring/ScoringSetup";
import ScoringResultCard from "@/components/scoring/ScoringResultCard";
import { useGrantScoring } from "@/components/hooks/useGrantScoring";

export default function AIGrantScorer() {
  const [selectedGrantId, setSelectedGrantId] = useState("");
  const [proposalText, setProposalText] = useState("");

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // Fetch grants with RLS filtering
  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Grant.list('-created_date')
        : base44.entities.Grant.filter({ created_by: user.email }, '-created_date'),
    enabled: !!user?.email,
  });

  // Validate selectedGrantId against authorized grants
  const selectedGrant = grants.find(g => g.id === selectedGrantId) || null;

  // Use custom scoring hook - pass null if grant is not authorized
  const { scoreProposal, isScoring, scoringResult, error } = useGrantScoring(
    selectedGrant,
    proposalText
  );

  // Loading state
  if (isLoadingUser || isLoadingGrants) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-purple-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-4xl mx-auto">
        <header className="text-center mb-8">
          <Brain className="w-12 h-12 mx-auto text-purple-600 mb-4" />
          <h1 className="text-3xl font-bold text-slate-900">AI Grant Scorer</h1>
          <p className="text-slate-600 mt-2">Instant AI-powered proposal scoring and feedback</p>
        </header>

        <ScoringSetup
          grants={grants}
          selectedGrantId={selectedGrantId}
          onGrantSelect={setSelectedGrantId}
          proposalText={proposalText}
          onProposalChange={setProposalText}
          onScore={scoreProposal}
          isScoring={isScoring}
          error={error}
        />

        {scoringResult && (
          <div className="mt-8">
            <ScoringResultCard result={scoringResult} />
          </div>
        )}
      </div>
    </div>
  );
}