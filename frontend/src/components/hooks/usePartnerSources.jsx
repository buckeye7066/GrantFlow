import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Custom hook for managing partner sources with RLS filtering
 * @param {Object} options
 * @param {Object} options.user - Current user object
 * @param {boolean} options.isAdmin - Whether user is admin
 */
export function usePartnerSources({ user, isAdmin } = {}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedPartner, setSelectedPartner] = useState(null);

  // Fetch partners with RLS filtering and user-aware query key
  const { data: partners = [], isLoading: isLoadingPartners } = useQuery({
    queryKey: ['partnerSources', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.PartnerSource.list()
        : base44.entities.PartnerSource.filter({ created_by: user.email }),
    enabled: !!user?.email,
  });

  // Fetch crawl logs with RLS filtering and user-aware query key
  const { data: crawlLogs = [], isLoading: isLoadingLogs } = useQuery({
    queryKey: ['crawlLogs', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.CrawlLog.list('-created_date', 50)
        : base44.entities.CrawlLog.filter({ created_by: user.email }, '-created_date', 50),
    enabled: !!user?.email,
    refetchInterval: 30000,
  });

  // Create or update partner mutation with permission check
  const createOrUpdateMutation = useMutation({
    mutationFn: async (partnerData) => {
      const { id, ...data } = partnerData;

      // If updating, verify ownership
      if (id && !isAdmin) {
        const existingPartner = partners.find(p => p.id === id);
        if (!existingPartner || existingPartner.created_by !== user?.email) {
          throw new Error('Access denied: You do not own this partner source.');
        }
      }

      return id 
        ? base44.entities.PartnerSource.update(id, data) 
        : base44.entities.PartnerSource.create(data);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['partnerSources', user?.email, isAdmin] });
      toast({
        title: 'Partner saved successfully',
        description: variables.id ? 'Partner updated.' : 'New partner added.',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Failed to save partner',
        description: error.message || 'An unexpected error occurred.',
      });
    }
  });

  // Delete partner mutation with permission check
  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      // Verify ownership before delete
      if (!isAdmin) {
        const existingPartner = partners.find(p => p.id === id);
        if (!existingPartner || existingPartner.created_by !== user?.email) {
          throw new Error('Access denied: You do not own this partner source.');
        }
      }

      return base44.entities.PartnerSource.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partnerSources', user?.email, isAdmin] });
      toast({
        title: 'Partner deleted',
        description: 'Partner source has been removed.',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Failed to delete partner',
        description: error.message || 'An unexpected error occurred.',
      });
    }
  });

  // Run feed mutation with permission check
  const runFeedMutation = useMutation({
    mutationFn: async (partnerId) => {
      // Verify ownership before running feed
      const partner = partners.find(p => p.id === partnerId);
      if (!partner) {
        throw new Error('Partner not found.');
      }

      if (!isAdmin && partner.created_by !== user?.email) {
        throw new Error('Access denied: You do not have permission to run this feed.');
      }

      return base44.functions.invoke('runPartnerFeed', { body: { partner_id: partnerId } });
    },
    onSuccess: (_, partnerId) => {
      const partner = partners.find(p => p.id === partnerId);
      toast({
        title: `Feed Run Initiated for ${partner?.name || 'Partner'}`,
        description: 'Check activity log for status.',
      });
      queryClient.invalidateQueries({ queryKey: ['crawlLogs', user?.email, isAdmin] });
    },
    onError: (error, partnerId) => {
      const partner = partners.find(p => p.id === partnerId);
      toast({
        variant: 'destructive',
        title: `Feed Run Failed for ${partner?.name || 'Partner'}`,
        description: error.message,
      });
    }
  });

  // Get AI suggestions mutation
  const getSuggestionsMutation = useMutation({
    mutationFn: () => {
      // User must be authenticated
      if (!user?.email) {
        throw new Error('Not authenticated');
      }

      const existingPartnerDetails = partners
        .map(p => `Name: ${p.name}, Type: ${p.org_type}, Status: ${p.status}`)
        .join('; ');

      return base44.integrations.Core.InvokeLLM({
        prompt: `Based on this list of existing funding sources: [${existingPartnerDetails}]. Suggest 5 new, similar organizations (foundations, corporate CSR programs, government bodies) that could also be good funding sources. For each suggestion, provide its official website URL, a general public-facing contact email, and classify its organization type from this list: university, utility, foundation, municipality, other. Do not include any from the existing list.`,
        add_context_from_internet: true,
        response_json_schema: {
          type: 'object',
          properties: {
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  reason: { type: 'string', description: 'A brief reason why it\'s a good suggestion.' },
                  org_type: { type: 'string', enum: ['university', 'utility', 'foundation', 'municipality', 'other'] },
                  api_base_url: { type: 'string', description: 'The main official website URL, if available.' },
                  contact_email: { type: 'string', description: 'A general contact email, like contact@ or info@.' }
                },
                required: ['name', 'reason', 'org_type']
              }
            }
          }
        }
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'AI Suggestions Failed',
        description: `Could not load suggestions. Error: ${error.message}`,
      });
    }
  });

  // Add multiple suggestions mutation
  const addSuggestionsMutation = useMutation({
    mutationFn: async (suggestions) => {
      // User must be authenticated
      if (!user?.email) {
        throw new Error('Not authenticated');
      }

      const results = [];
      for (const suggestion of suggestions) {
        try {
          const newPartner = await base44.entities.PartnerSource.create({
            name: suggestion.name,
            org_type: suggestion.org_type || 'other',
            api_base_url: suggestion.api_base_url || '',
            contact_email: suggestion.contact_email || '',
            auth_type: 'none',
            auth_secret_name: '',
            status: 'inactive',
          });
          results.push({ success: true, source: newPartner });
        } catch (error) {
          results.push({ success: false, name: suggestion.name, error: error.message });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ['partnerSources', user?.email, isAdmin] });
      
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      if (successCount > 0) {
        toast({
          title: `Added ${successCount} Partner${successCount > 1 ? 's' : ''}`,
          description: failCount > 0 ? `${failCount} failed to add` : undefined,
        });
      }
      
      if (failCount > 0) {
        const failedNames = results.filter(r => !r.success).map(r => r.name).join(', ');
        toast({
          variant: 'destructive',
          title: `Failed to Add ${failCount} Partner${failCount > 1 ? 's' : ''}`,
          description: failedNames,
        });
      }
    },
  });

  const createOrUpdatePartner = useCallback((partnerData) => {
    createOrUpdateMutation.mutate(partnerData);
  }, [createOrUpdateMutation]);

  const deletePartner = useCallback((id) => {
    deleteMutation.mutate(id);
  }, [deleteMutation]);

  const runFeed = useCallback((partnerId) => {
    runFeedMutation.mutate(partnerId);
  }, [runFeedMutation]);

  const getSuggestions = useCallback(() => {
    return getSuggestionsMutation.mutateAsync();
  }, [getSuggestionsMutation]);

  const addSuggestions = useCallback((suggestions) => {
    addSuggestionsMutation.mutate(suggestions);
  }, [addSuggestionsMutation]);

  const isLoading = isLoadingPartners || isLoadingLogs;

  return {
    partners,
    crawlLogs,
    selectedPartner,
    setSelectedPartner,
    isLoading,
    isLoadingPartners,
    isLoadingLogs,
    createOrUpdatePartner,
    deletePartner,
    runFeed,
    getSuggestions,
    addSuggestions,
    isSaving: createOrUpdateMutation.isPending,
    isRunningFeed: runFeedMutation.isPending,
    runFeedVariables: runFeedMutation.variables,
    isGettingSuggestions: getSuggestionsMutation.isPending,
    getSuggestionsError: getSuggestionsMutation.error,
    isAddingSuggestions: addSuggestionsMutation.isPending,
  };
}