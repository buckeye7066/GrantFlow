import { useMemo } from 'react';
import { isGrantExpired } from '@/components/shared/grantUtils';
import { log } from '@/components/shared/logger';

/**
 * Parse deadline into a Date or recognize "rolling"
 */
function parseDeadlineValue(deadline) {
  if (deadline == null) return { isRolling: false, date: null };
  // Handle strings safely
  const dStr = typeof deadline === 'string' ? deadline.trim() : deadline;
  if (typeof dStr === 'string' && dStr.toLowerCase() === 'rolling') {
    return { isRolling: true, date: null };
  }
  // Already a Date?
  if (deadline instanceof Date) {
    return isNaN(deadline.getTime()) ? { isRolling: false, date: null } : { isRolling: false, date: deadline };
  }
  // Fallback parse
  const dt = new Date(String(deadline));
  return isNaN(dt.getTime()) ? { isRolling: false, date: null } : { isRolling: false, date: dt };
}

/**
 * Safely get a numeric award value for filtering/sorting
 * Prefers award_ceiling, then award_floor, then typical_award
 */
function getAwardNumber(grant) {
  const raw =
    grant?.award_ceiling ??
    grant?.award_floor ??
    grant?.typical_award ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lowercase-safe helper
 */
function lc(value) {
  return typeof value === 'string' ? value.toLowerCase() : String(value ?? '').toLowerCase();
}

/**
 * Custom hook to filter grants based on organization, filters, and expiration status
 *
 * PART 3 & 7: Uses BOTH organization_id AND profile_id for isolation.
 * Logs contamination if grants have mismatched profile_id.
 *
 * @param {Array} grants - All grants
 * @param {string} selectedOrgId - Selected organization ID ('all' for all orgs)
 * @param {Object} filters - Filter object containing search, amounts, types, tags, etc.
 * @returns {Object} - { filteredGrants: Array }
 */
export function useFilteredGrants(grants, selectedOrgId, filters = {}) {
  const filteredGrants = useMemo(() => {
    if (!Array.isArray(grants) || grants.length === 0) return [];

    try {
      let filtered = grants.filter(Boolean);

      // PART 3: Organization + Profile filter for isolation (string-normalized)
      if (selectedOrgId && selectedOrgId !== 'all') {
        const orgIdStr = String(selectedOrgId);
        const beforeCount = filtered.length;

        filtered = filtered.filter((grant) => {
          if (!grant?.id) {
            log.warn('[useFilteredGrants] Skipping grant with missing id');
            return false;
          }
          if (String(grant.organization_id) !== orgIdStr) return false;

          // PART 7: Sentinel check - if grant has profile_id, it must match
          if (grant.profile_id != null && String(grant.profile_id) !== orgIdStr) {
            log.error('[useFilteredGrants] CONTAMINATION_DETECTED:', {
              grantId: grant.id,
              grantTitle: grant.title?.substring(0, 30),
              expectedProfileId: orgIdStr,
              actualProfileId: grant.profile_id
            });
            return false;
          }
          return true;
        });

        log.debug('[useFilteredGrants] Org filter:', { before: beforeCount, after: filtered.length, orgId: selectedOrgId });
      }

      // Deadline status filters (mutually exclusive)
      if (filters.hideExpired) {
        filtered = filtered.filter((grant) => !isGrantExpired(grant));
      } else if (filters.showOnlyExpired) {
        filtered = filtered.filter((grant) => isGrantExpired(grant));
      }

      // Deadline date range filters
      if (filters.deadlineAfter) {
        const afterDate = new Date(filters.deadlineAfter);
        if (!isNaN(afterDate.getTime())) {
          filtered = filtered.filter((grant) => {
            const { isRolling, date } = parseDeadlineValue(grant?.deadline);
            // Keep rolling if not explicitly excluded
            if (isRolling || !date) return true;
            return date >= afterDate;
          });
        }
      }
      if (filters.deadlineBefore) {
        const beforeDate = new Date(filters.deadlineBefore);
        if (!isNaN(beforeDate.getTime())) {
          filtered = filtered.filter((grant) => {
            const { isRolling, date } = parseDeadlineValue(grant?.deadline);
            if (isRolling || !date) return true;
            return date <= beforeDate;
          });
        }
      }

      // Match score minimum filter
      if (filters.matchScoreMin && filters.matchScoreMin > 0) {
        const minScore = Number(filters.matchScoreMin) || 0;
        filtered = filtered.filter((grant) => {
          const score = Number(grant?.match ?? grant?.match_score ?? 0);
          return Number.isFinite(score) && score >= minScore;
        });
      }

      // Search filter with keyword matching option
      if (filters.search) {
        const searchTerms = String(filters.search)
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 0);

        filtered = filtered.filter((grant) => {
          const searchableText = [
            grant?.title,
            grant?.funder,
            grant?.sponsor,
            grant?.program_description,
            ...(Array.isArray(grant?.tags) ? grant.tags : []),
          ]
            .filter((v) => v != null)
            .map((v) => lc(v))
            .join(' ');

          if (!searchableText) return false;

          return filters.keywordIncludesAllTerms
            ? searchTerms.every((term) => searchableText.includes(term))
            : searchTerms.some((term) => searchableText.includes(term));
        });
      }

      // Amount filters (use normalized award)
      if (filters.minAmount !== '' && filters.minAmount !== undefined && filters.minAmount !== null) {
        const minAmount = Number(filters.minAmount);
        if (Number.isFinite(minAmount)) {
          filtered = filtered.filter((grant) => {
            const amt = getAwardNumber(grant);
            return amt != null && amt >= minAmount;
          });
        }
      }
      if (filters.maxAmount !== '' && filters.maxAmount !== undefined && filters.maxAmount !== null) {
        const maxAmount = Number(filters.maxAmount);
        if (Number.isFinite(maxAmount)) {
          filtered = filtered.filter((grant) => {
            const amt = getAwardNumber(grant);
            return amt != null && amt <= maxAmount;
          });
        }
      }

      // Funder type filter (tolerate minor case variance)
      if (Array.isArray(filters.funderTypes) && filters.funderTypes.length > 0) {
        const norm = new Set(filters.funderTypes.map(lc));
        filtered = filtered.filter((grant) => grant?.funder_type && norm.has(lc(grant.funder_type)));
      }

      // Application method filter
      if (Array.isArray(filters.applicationMethods) && filters.applicationMethods.length > 0) {
        const norm = new Set(filters.applicationMethods.map(lc));
        filtered = filtered.filter((grant) => grant?.application_method && norm.has(lc(grant.application_method)));
      }

      // Opportunity type filter
      if (Array.isArray(filters.opportunityTypes) && filters.opportunityTypes.length > 0) {
        const norm = new Set(filters.opportunityTypes.map(lc));
        filtered = filtered.filter((grant) => grant?.opportunity_type && norm.has(lc(grant.opportunity_type)));
      }

      // Tags filter (case-sensitive keep; can be made case-insensitive if needed)
      if (Array.isArray(filters.tags) && filters.tags.length > 0) {
        filtered = filtered.filter(
          (grant) => Array.isArray(grant?.tags) && grant.tags.some((tag) => filters.tags.includes(tag))
        );
      }

      return filtered;
    } catch (err) {
      log.error('[useFilteredGrants] Filter pipeline error:', err?.message || err);
      // Fail-safe: return empty to avoid leaking cross-profile data on error
      return [];
    }
  }, [grants, selectedOrgId, filters]);

  return { filteredGrants };
}