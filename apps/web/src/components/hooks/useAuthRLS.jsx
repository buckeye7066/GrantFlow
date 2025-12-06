import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Owner email that always gets full access bypass
export const OWNER_EMAIL = 'buckeye7066@gmail.com';

/**
 * Check if user is the owner with full access
 * @param {object} user - User object with email property
 * @returns {boolean}
 */
export function isOwner(user) {
  return user?.email === OWNER_EMAIL || user?.role === 'admin';
}

/**
 * Central auth context - provides user + admin flag
 * Used throughout every other RLS hook.
 * Dr. John White (buckeye7066@gmail.com) always gets admin access.
 */
export function useAuthContext() {
  const {
    data: user,
    isLoading: isLoadingUser,
    error: authError,
  } = useQuery({
    queryKey: ['currentUser'],
    queryFn: async () => {
      try {
        const me = await base44.auth.me();
        return me ?? null;
      } catch (error) {
        console.error('[useAuthContext] Auth error:', error);
        return null; // soft-fail
      }
    },
    // keep auth fresh-ish but avoid excess refetches
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  // Admin if role is admin OR if email is the designated owner email
  const isAdmin = !!user && isOwner(user);

  return { user, isAdmin, isLoadingUser, authError };
}

/**
 * RLS-SAFE ORGANIZATION LIST
 */
export function useRLSOrganizations(options = {}) {
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  const query = useQuery({
    queryKey: ['organizationsRLS', user?.email ?? null, !!isAdmin],
    queryFn: async () => {
      if (!user) return [];
      try {
        if (isAdmin) {
          return await base44.entities.Organization.list('-created_date');
        }
        return await base44.entities.Organization.filter({ created_by: user?.email });
      } catch (error) {
        console.warn('[RLS] Organizations query blocked:', error?.message || error);
        return [];
      }
    },
    enabled: !!user && (options.enabled ?? true),
    staleTime: 20_000,
    gcTime: 2 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { ...query, user, isAdmin, isLoadingUser };
}

/**
 * RLS-SAFE ORGANIZATION BY ID
 */
export function useRLSOrganization(organizationId, options = {}) {
  const { user, isAdmin } = useAuthContext();

  const query = useQuery({
    queryKey: ['organizationRLS', organizationId ?? null, user?.email ?? null, !!isAdmin],
    queryFn: async () => {
      if (!organizationId || !user) return null;
      try {
        if (isAdmin) {
          return await base44.entities.Organization.get(organizationId);
        }
        const results = await base44.entities.Organization.filter({ id: organizationId, created_by: user?.email });
        return results?.[0] ?? null;
      } catch (err) {
        console.warn('[RLS] Organization fetch blocked:', err?.message || err);
        return null;
      }
    },
    enabled: !!organizationId && !!user && (options.enabled ?? true),
    staleTime: 20_000,
    gcTime: 2 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { ...query, user, isAdmin };
}

/**
 * RLS-SAFE GRANT LIST
 */
export function useRLSGrants(options = {}) {
  const { user, isAdmin } = useAuthContext();

  // Normalize status filter to stable array or undefined
  const statusFilterNorm = Array.isArray(options.statusFilter)
    ? options.statusFilter
    : options.statusFilter
    ? [options.statusFilter]
    : undefined;

  const query = useQuery({
    queryKey: ['grantsRLS', user?.email ?? null, !!isAdmin, statusFilterNorm?.join('|') ?? ''],
    queryFn: async () => {
      if (!user) return [];
      try {
        const filter = isAdmin ? {} : { created_by: user.email };
        if (statusFilterNorm?.length) {
          // backend supports array or explicit OR; pass-through array if supported
          filter.status = statusFilterNorm;
        }
        return await base44.entities.Grant.filter(filter);
      } catch (error) {
        console.warn('[RLS] Grants query blocked:', error?.message || error);
        return [];
      }
    },
    enabled: !!user && (options.enabled ?? true),
    staleTime: 15_000,
    gcTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { ...query, user, isAdmin };
}

/**
 * RLS-SAFE GRANT BY ID
 */
export function useRLSGrant(grantId, options = {}) {
  const { user, isAdmin } = useAuthContext();

  const query = useQuery({
    queryKey: ['grantRLS', grantId ?? null, user?.email ?? null, !!isAdmin],
    queryFn: async () => {
      if (!grantId || !user) return null;
      try {
        if (isAdmin) {
          return await base44.entities.Grant.get(grantId);
        }
        const results = await base44.entities.Grant.filter({ id: grantId, created_by: user?.email });
        return results?.[0] ?? null;
      } catch (error) {
        console.warn('[RLS] Grant fetch blocked:', error?.message || error);
        return null;
      }
    },
    enabled: !!grantId && !!user && (options.enabled ?? true),
    staleTime: 15_000,
    gcTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { ...query, user, isAdmin };
}

/**
 * GENERIC RLS-SAFE FILTER
 *
 * Option B semantics:
 * - For entity "Organization": Admin sees all, non-admin adds created_by=user.email
 * - For entities with organization_id filter: Caller must pass RLS-safe org_id
 * - For other entities with created_by: Non-admin auto-adds created_by=user.email
 */
export function useRLSFilter(entityName, filter = {}, options = {}) {
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // Normalize filter for key stability (shallow)
  const stableFilterKey = JSON.stringify(filter ?? {});

  const query = useQuery({
    queryKey: ['rlsFilter', entityName ?? '', stableFilterKey, user?.email ?? null, !!isAdmin],
    queryFn: async () => {
      if (!user) return [];
      try {
        const entities = base44.entities?.[entityName];
        if (!entities || typeof entities.filter !== 'function') {
          console.warn(`[RLS] Unknown entity or filter not supported: ${entityName}`);
          return [];
        }

        // Optional sorting/limit passthrough if supplied via options
        const sort = options.sort ?? undefined;
        const limit = options.limit ?? undefined;

        // Organization: enforce created_by for non-admin
        if (entityName === 'Organization') {
          if (isAdmin) {
            return await entities.filter(filter, sort, limit);
          }
          const orgFilter = { ...filter, created_by: user?.email };
          return await entities.filter(orgFilter, sort, limit);
        }

        // If caller supplies organization_id, assume it came from a RLS-safe source
        if (Object.prototype.hasOwnProperty.call(filter, 'organization_id')) {
          return await entities.filter(filter, sort, limit);
        }

        // For non-admin, auto-add created_by where relevant
        if (!isAdmin) {
          const combined = { ...filter, created_by: user?.email };
          return await entities.filter(combined, sort, limit);
        }

        // Admin fallback: plain filter
        return await entities.filter(filter, sort, limit);
      } catch (error) {
        console.warn(`[RLS] Filter blocked for ${entityName}:`, error?.message || error);
        return [];
      }
    },
    enabled: !!user && !!entityName && (options.enabled ?? true),
    staleTime: 15_000,
    gcTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { ...query, user, isAdmin, isLoadingUser };
}