import { useMemo } from 'react';
import { isGrantExpired } from '@/components/shared/grantUtils';

/**
 * Custom hook to filter grants based on organization, filters, and expiration status
 * @param {Array} grants - All grants
 * @param {Object} filters - Filter object containing search, amounts, types, tags, etc.
 * @param {string} selectedOrgId - Selected organization ID ('all' for all orgs)
 * @returns {Array} - Filtered grants
 */
export function useFilteredGrants(grants, filters, selectedOrgId) {
  return useMemo(() => {
    if (!grants) return [];
    
    let filtered = grants;

    // Organization filter
    if (selectedOrgId !== "all") {
      filtered = filtered.filter((grant) => grant.organization_id === selectedOrgId);
    }

    // Deadline status filters (mutually exclusive)
    if (filters.hideExpired) {
      filtered = filtered.filter(grant => !isGrantExpired(grant));
    } else if (filters.showOnlyExpired) {
      filtered = filtered.filter(grant => isGrantExpired(grant));
    }

    // Search filter
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filtered = filtered.filter(grant =>
        grant.title?.toLowerCase().includes(searchLower) ||
        grant.funder?.toLowerCase().includes(searchLower) ||
        grant.program_description?.toLowerCase().includes(searchLower) ||
        grant.tags?.some(tag => tag.toLowerCase().includes(searchLower))
      );
    }

    // Amount filters
    if (filters.minAmount !== '') {
      const minAmount = parseFloat(filters.minAmount);
      filtered = filtered.filter(grant => 
        grant.amount_max && grant.amount_max >= minAmount
      );
    }
    if (filters.maxAmount !== '') {
      const maxAmount = parseFloat(filters.maxAmount);
      filtered = filtered.filter(grant =>
        grant.amount_max && grant.amount_max <= maxAmount
      );
    }

    // Funder type filter — checks both frontend funder_type and DB-backed funding_source_type
    if (filters.funderTypes && filters.funderTypes.length > 0) {
      filtered = filtered.filter(grant => {
        const ft = grant.funder_type ?? grant.funding_source_type
        return ft && filters.funderTypes.includes(ft)
      });
    }

    // Application method filter
    if (filters.applicationMethods && filters.applicationMethods.length > 0) {
      filtered = filtered.filter(grant =>
        grant.application_method && filters.applicationMethods.includes(grant.application_method)
      );
    }

    // Opportunity type filter
    if (filters.opportunityTypes && filters.opportunityTypes.length > 0) {
      filtered = filtered.filter(grant =>
        grant.opportunity_type && filters.opportunityTypes.includes(grant.opportunity_type)
      );
    }

    // Tags filter
    if (filters.tags && filters.tags.length > 0) {
      filtered = filtered.filter(grant =>
        grant.tags && grant.tags.some(tag => filters.tags.includes(tag))
      );
    }

    return filtered;
  }, [grants, selectedOrgId, filters]);
}