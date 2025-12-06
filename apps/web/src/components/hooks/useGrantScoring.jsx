import { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { buildScoringPrompt, SCORING_RESPONSE_SCHEMA } from '@/components/scoring/scoringPrompt';

/**
 * Custom hook for grant proposal scoring
 * @param {Object} grant - The selected grant
 * @param {string} proposalText - The proposal text to score
 */
export function useGrantScoring(grant, proposalText) {
  const [isScoring, setIsScoring] = useState(false);
  const [scoringResult, setScoringResult] = useState(null);
  const [error, setError] = useState(null);
  const { toast } = useToast();

  const validateInputs = useCallback(() => {
    if (!grant) {
      setError("Please select a grant opportunity.");
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Please select a grant from your pipeline.",
      });
      return false;
    }

    if (!proposalText || proposalText.trim().length === 0) {
      setError("Please enter your proposal text.");
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Please paste your proposal draft to score.",
      });
      return false;
    }

    if (proposalText.trim().length < 50) {
      setError("Proposal text is too short. Please provide a meaningful draft.");
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Your proposal seems too short. Please provide more content for accurate scoring.",
      });
      return false;
    }

    return true;
  }, [grant, proposalText, toast]);

  const scoreProposal = useCallback(async () => {
    // Reset state
    setError(null);
    setScoringResult(null);

    // Validate inputs
    if (!validateInputs()) {
      return;
    }

    setIsScoring(true);

    try {
      console.log('[useGrantScoring] Starting proposal scoring...');
      
      const prompt = buildScoringPrompt(grant, proposalText);
      
      const response = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: SCORING_RESPONSE_SCHEMA,
      });

      console.log('[useGrantScoring] Scoring completed successfully');
      
      // Validate response
      if (!response || typeof response.total_score !== 'number') {
        throw new Error('Invalid scoring response from AI');
      }

      setScoringResult(response);
      
      toast({
        title: "Scoring Complete! 🎉",
        description: `Your proposal scored ${response.total_score}/100`,
      });

    } catch (err) {
      console.error('[useGrantScoring] Scoring failed:', err);
      
      // Parse error types
      let errorMessage = 'An error occurred while scoring your proposal.';
      let errorTitle = 'Scoring Failed';
      
      if (err.message) {
        if (err.message.includes('rate limit') || err.message.includes('429')) {
          errorTitle = 'Rate Limit Exceeded';
          errorMessage = 'Too many requests. Please wait a moment and try again.';
        } else if (err.message.includes('timeout')) {
          errorTitle = 'Request Timeout';
          errorMessage = 'The scoring request took too long. Please try again with a shorter proposal.';
        } else if (err.message.includes('Invalid')) {
          errorTitle = 'Invalid Response';
          errorMessage = 'The AI returned an invalid response. Please try again.';
        } else {
          errorMessage = err.message;
        }
      }
      
      setError(errorMessage);
      
      toast({
        variant: "destructive",
        title: errorTitle,
        description: errorMessage,
      });
    } finally {
      setIsScoring(false);
    }
  }, [grant, proposalText, validateInputs, toast]);

  const reset = useCallback(() => {
    setScoringResult(null);
    setError(null);
  }, []);

  return {
    scoreProposal,
    isScoring,
    scoringResult,
    error,
    reset,
  };
}