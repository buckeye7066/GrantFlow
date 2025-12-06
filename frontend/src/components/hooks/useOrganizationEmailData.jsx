import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

/**
 * Hook to fetch organization email-related data
 * Consolidates grants and contact methods queries
 * 
 * @param {string} organizationId - Organization ID
 * @param {boolean} enabled - Whether to enable queries
 * @returns {Object} Grants, contacts, and loading states
 */
export function useOrganizationEmailData(organizationId, enabled = true) {
  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', organizationId],
    queryFn: () => base44.entities.Grant.filter({ organization_id: organizationId }),
    enabled: enabled && !!organizationId,
  });

  const { data: contactMethods = [], isLoading: isLoadingContacts } = useQuery({
    queryKey: ['contactMethods', organizationId],
    queryFn: () => base44.entities.ContactMethod.filter({ organization_id: organizationId }),
    enabled: enabled && !!organizationId,
  });

  const emails = contactMethods.filter(c => c.type === 'email');

  return {
    grants,
    contactMethods,
    emails,
    isLoading: isLoadingGrants || isLoadingContacts,
  };
}