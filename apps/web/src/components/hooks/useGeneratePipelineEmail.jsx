import { useState, useCallback, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import {
  buildProfileSummary,
  buildPipelineSummary,
  generatePipelineEmailPrompt,
} from '@/components/emails/emailGenerationHelpers';

/**
 * Hook for generating pipeline update emails using AI
 * Reusable across any email generation flow
 * 
 * @returns {Object} Generation function and state
 */
export function useGeneratePipelineEmail() {
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast } = useToast();

  /**
   * Generate email body using AI
   * 
   * @param {Object} params - Generation parameters
   * @param {Object} params.organization - Organization data
   * @param {Array} params.grants - Array of grants
   * @param {Array} params.contactMethods - Contact methods
   * @returns {Promise<{body: string, error?: string}>}
   */
  const generate = useCallback(async ({ organization, grants, contactMethods }) => {
    if (!organization) {
      return { body: '', error: 'Organization data is required' };
    }

    setIsGenerating(true);
    
    try {
      // Build summaries
      const profileSummary = buildProfileSummary(organization, contactMethods);
      const pipelineSummary = buildPipelineSummary(grants);
      
      // Generate prompt
      const prompt = generatePipelineEmailPrompt(
        organization.name,
        profileSummary,
        pipelineSummary
      );

      // Call LLM
      const response = await base44.integrations.Core.InvokeLLM({ 
        prompt,
        // No response_json_schema since we want plain text
      });

      if (!response || typeof response !== 'string') {
        throw new Error('Invalid response from AI');
      }

      toast({
        title: "Email Generated! ✨",
        description: "Review and edit before sending",
      });

      return { body: response, error: null };

    } catch (error) {
      console.error("Failed to generate email:", error);
      
      toast({
        variant: "destructive",
        title: "Generation Failed",
        description: "Could not generate email. Please write one manually.",
      });

      return { body: '', error: error.message };
    } finally {
      setIsGenerating(false);
    }
  }, [toast]);

  return {
    generate,
    isGenerating,
  };
}