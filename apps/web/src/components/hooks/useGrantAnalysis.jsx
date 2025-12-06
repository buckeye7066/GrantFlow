import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Custom hook for managing grant AI analysis
 * Enhanced with defensive null guards and input validation
 */
export function useGrantAnalysis(grantId) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async ({ grant, organization }) => {
      console.log('[useGrantAnalysis] Starting analysis for grant:', grant?.id);
      
      // DEFENSIVE: Validate grant object
      if (!grant) {
        throw new Error('Grant object is required for analysis');
      }
      if (!grant.id) {
        throw new Error('Grant ID is missing');
      }
      
      // DEFENSIVE: Validate organization object
      if (!organization) {
        throw new Error('Organization object is required for analysis');
      }
      if (!organization.id) {
        throw new Error('Organization ID is missing');
      }
      
      // DEFENSIVE: Ensure required grant fields have safe defaults
      const safeGrant = {
        id: grant.id,
        title: grant.title || 'Untitled Grant',
        funder: grant.funder || 'Unknown Funder',
        status: grant.status || 'discovered',
        tags: Array.isArray(grant.tags) ? grant.tags : []
      };
      
      console.log('[useGrantAnalysis] Validated inputs:', {
        grant_id: safeGrant.id,
        organization_id: organization.id,
        grant_title: safeGrant.title
      });

      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          const response = await base44.functions.invoke('analyzeGrant', {
            body: {
              grant_id: safeGrant.id,
              organization_id: organization.id
            }
          });

          console.log('[useGrantAnalysis] Analysis response:', response.data);

          if (!response.data?.success) {
            const errorMsg = response.data?.error || 'Analysis failed';
            const errorField = response.data?.field;
            
            // Check for missing field errors
            if (response.data?.error === 'missing_field') {
              throw new Error(`Missing required field: ${errorField}`);
            }
            
            // Check if it's a rate limit or temporary error
            if (response.status === 429 || response.status >= 500) {
              retryCount++;
              if (retryCount < maxRetries) {
                console.log(`[useGrantAnalysis] Retrying... (${retryCount}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                continue;
              }
            }
            
            throw new Error(errorMsg);
          }

          return response.data;
        } catch (error) {
          // If it's a validation error, don't retry
          if (error.message?.includes('missing') || error.message?.includes('required')) {
            throw error;
          }
          
          // If the error is not a response error or we've hit max retries, rethrow
          if (!error.response || retryCount >= maxRetries - 1) {
            throw error;
          }
          retryCount++;
          console.log(`[useGrantAnalysis] Retry ${retryCount}/${maxRetries} after error:`, error.message);
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }
      throw new Error("Failed to analyze grant after multiple retries.");
    },
    onSuccess: (data) => {
      console.log('[useGrantAnalysis] Analysis succeeded:', data);
      
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      if (grantId) {
        queryClient.invalidateQueries({ queryKey: ['grant', grantId] });
      }
      
      toast({
        title: '✨ AI Analysis Complete',
        description: 'Grant has been analyzed and summary generated.',
      });
    },
    onError: (error) => {
      console.error('[useGrantAnalysis] Analysis failed:', error);
      
      const errorMsg = error?.message || 'AI analysis failed';
      const isRateLimit = errorMsg.toLowerCase().includes('rate limit') || 
                         errorMsg.toLowerCase().includes('429');
      
      toast({
        variant: 'destructive',
        title: isRateLimit ? 'AI Temporarily Unavailable' : 'Analysis Failed',
        description: isRateLimit 
          ? 'AI service is at capacity. Please try again in a few moments.'
          : errorMsg,
      });
    }
  });

  return mutation;
}