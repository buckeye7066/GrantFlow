import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";

/**
 * Hook for organization CRUD mutations
 * @returns {Object} Object containing create, update, and delete mutations
 */
export function useOrganizationMutations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Organization.create(data),
    onSuccess: (created) => {
      // Invalidate broad list and precise entity fetches when present
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      if (created?.id) {
        queryClient.invalidateQueries({ queryKey: ['organization', created.id] });
      }
      toast({
        title: "Profile Created!",
        description: "Your new profile has been successfully created.",
      });
    },
    onError: (error) => {
      const message =
        error?.response?.data?.message ||
        error?.message ||
        "There was an error creating the profile.";
      toast({
        variant: "destructive",
        title: "Creation Failed",
        description: message,
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Organization.update(id, data),
    onSuccess: (_updated, variables) => {
      // Invalidate list and the specific organization view
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      if (variables?.id) {
        queryClient.invalidateQueries({ queryKey: ['organization', variables.id] });
        // Downstream views often depend on this org (docs, grants)
        queryClient.invalidateQueries({ queryKey: ['documents', variables.id] });
        queryClient.invalidateQueries({ queryKey: ['grants', variables.id] });
      }
      toast({
        title: "Profile Updated!",
        description: "Your profile has been successfully updated.",
      });
    },
    onError: (error) => {
      const message =
        error?.response?.data?.message ||
        error?.message ||
        "There was an error updating the profile.";
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: message,
      });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (organizationId) => {
      if (!organizationId) {
        throw new Error('Missing organizationId');
      }
      // Use { body } envelope; tolerate multiple success envelope shapes
      const response = await base44.functions.invoke('deleteOrganizationWithCascade', {
        body: { organization_id: organizationId }
      });

      // Handle various response shapes
      const data = response?.data ?? response;
      const error = response?.error;

      if (error) throw error;

      const ok = data?.success === true || data?.ok === true;
      if (!ok) {
        const message = data?.error || data?.message || 'Failed to delete organization';
        throw new Error(message);
      }
      return data;
    },
    onSuccess: (_res, organizationId) => {
      // Invalidate lists and entity-scoped caches
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      queryClient.invalidateQueries({ queryKey: ['documents', organizationId] });
      toast({
        title: "Profile Deleted",
        description: "Profile and all related data deleted successfully.",
      });
    },
    onError: (error) => {
      const message =
        error?.response?.data?.message ||
        error?.message ||
        "There was an error deleting the profile.";
      toast({
        variant: "destructive",
        title: "Deletion Failed",
        description: message,
      });
    }
  });

  return {
    createMutation,
    updateMutation,
    deleteMutation
  };
}