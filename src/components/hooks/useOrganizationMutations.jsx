import { useMutation, useQueryClient } from "@tanstack/react-query";
import client from '@/api/client';
import { useToast } from "@/components/ui/use-toast";

/**
 * Hook for organization CRUD mutations
 * @returns {Object} Object containing create, update, and delete mutations
 */
export function useOrganizationMutations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data) => client.entities.Organization.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast({
        title: "Profile Created!",
        description: "Your new profile has been successfully created.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Creation Failed",
        description: error.message || "There was an error creating the profile.",
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => client.entities.Organization.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast({
        title: "Profile Updated!",
        description: "Your profile has been successfully updated.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error.message || "There was an error updating the profile.",
      });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (organizationId) => {
      const response = await client.functions.invoke('deleteOrganizationWithCascade', {
        organization_id: organizationId
      });
      
      if (!response.data.success) {
        throw new Error(response.data.error || 'Failed to delete organization');
      }
      
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      toast({
        title: "Profile Deleted",
        description: "Profile and all related data deleted successfully.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Deletion Failed",
        description: error.message || "There was an error deleting the profile.",
      });
    }
  });

  return {
    createMutation,
    updateMutation,
    deleteMutation
  };
}