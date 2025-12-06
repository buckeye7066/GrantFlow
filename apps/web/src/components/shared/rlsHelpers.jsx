/**
 * RLS Helper Functions for Frontend
 * Provides consistent owner detection and RLS-safe patterns for UI components
 */

// Owner email that always gets full access
export const OWNER_EMAIL = 'buckeye7066@gmail.com';

/** Internal: normalize roles to an array of strings */
function toRoleArray(roleLike) {
  if (!roleLike) return [];
  if (Array.isArray(roleLike)) return roleLike.filter(Boolean).map(String);
  return [String(roleLike)];
}

/** Internal: quick admin-role predicate */
function isAdminRole(user) {
  if (!user) return false;
  const roles = toRoleArray(user.roles ?? user.role);
  return roles.some((r) => r.toLowerCase() === 'admin');
}

/**
 * Safe email getter
 * @param {Object} user - User object
 * @returns {string} user email string or empty string
 */
export function requireEmail(user) {
  return typeof user?.email === 'string' ? user.email : '';
}

/**
 * Check if user is the owner with full access
 * @param {Object} user - User object with email/role
 * @returns {boolean}
 */
export function isOwner(user) {
  const email = requireEmail(user);
  return email === OWNER_EMAIL || isAdminRole(user);
}

/**
 * Check if user should have admin/owner privileges
 * @param {Object} user - User object
 * @returns {boolean}
 */
export function hasAdminAccess(user) {
  return isOwner(user);
}

/**
 * Get appropriate query filter based on user permissions.
 * Owner sees all, others see only their own data.
 *
 * NOTE: Does not mutate the provided baseFilter.
 *
 * @param {Object} user - User object
 * @param {Object} baseFilter - Base filter to extend
 * @returns {Object} Filter with ownership applied
 */
export function getOwnershipFilter(user, baseFilter = {}) {
  // Clone defensively
  const filter = { ...(baseFilter || {}) };

  if (isOwner(user)) {
    // Owner sees everything
    return filter;
  }

  const email = requireEmail(user);
  if (!email) {
    // No email -> return filter unchanged (caller may subsequently block request)
    return filter;
  }

  // Apply RLS scoping
  return { ...filter, created_by: email };
}

/**
 * Wrap async data fetch with RLS/error handling.
 * Returns fallback value instead of throwing on RLS/permission errors;
 * otherwise rethrows unless onError returns a value.
 *
 * @param {Function} fetchFn - Async function to execute
 * @param {any} fallback - Value to return on RLS/permission errors (default [])
 * @param {string} context - Context string for logging
 * @param {Function} onError - Optional hook to transform/handle non-RLS errors
 * @returns {Promise<any>}
 */
export async function safeDataFetch(
  fetchFn,
  fallback = [],
  context = 'Unknown',
  onError
) {
  try {
    const result = await fetchFn();
    // Some SDKs return null/undefined on empty -> coalesce to fallback
    return result ?? fallback;
  } catch (error) {
    const message = error?.message || String(error);
    // RLS / permission-like errors -> soft-fail to fallback
    if (isRLSError(error)) {
      console.warn(`[RLS] Data fetch blocked (${context}):`, message);
      return fallback;
    }
    // Non-RLS error: allow caller hook to decide
    if (typeof onError === 'function') {
      const maybe = await onError(error);
      if (maybe !== undefined) return maybe;
    }
    // Re-throw for upstream handling
    throw error;
  }
}

/**
 * Log RLS restriction warning
 * @param {string} context - What was being accessed
 * @param {string} reason - Why it was blocked
 */
export function logRLSRestriction(context, reason = 'Access denied') {
  console.warn(`[RLS] Restriction detected in ${context}: ${reason}`);
}

/**
 * Check if an error is an RLS-related error
 * Heuristics: message text + common HTTP shapes (status/codes)
 * @param {any} error - Error to check
 * @returns {boolean}
 */
export function isRLSError(error) {
  if (!error) return false;

  const msg = (error?.message || error?.toString?.() || '').toLowerCase();

  // Text-based heuristics
  if (
    msg.includes('rls') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('access denied') ||
    msg.includes('permission')
  ) {
    return true;
  }

  // HTTP-like shapes
  const status = error?.status ?? error?.response?.status ?? error?.code;
  if (typeof status === 'number' && (status === 401 || status === 403)) return true;
  if (typeof status === 'string') {
    const s = status.toLowerCase();
    if (s === 'unauthorized' || s === 'forbidden') return true;
  }

  // Supabase/PostgREST-ish error codes
  const pgCode = (error?.code || error?.hint || '').toString().toLowerCase();
  if (pgCode.includes('42501') || pgCode.includes('permission')) return true;

  return false;
}