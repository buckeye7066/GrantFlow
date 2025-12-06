/**
 * Client User Utilities
 * Helper functions for client_user role management and RLS isolation
 */

/** Owner email that always gets full access (centralized) */
export const OWNER_EMAIL = 'buckeye7066@gmail.com';

/** Pages visible to client_user role */
export const CLIENT_VISIBLE_PAGES = Object.freeze([
  'Dashboard',
  'Organizations',
  'OrganizationProfile',
  'Pipeline',
  'Documents',
  'GrantDetail',
  'Billing',
  'SendMessage',
]);

/** Pages hidden from client_user role */
export const ADMIN_ONLY_PAGES = Object.freeze([
  'UserManagement',
  'UserAnalytics',
  'AdminMessages',
  'AutomationSettings',
  'SmartMatcher',
  'ProfileMatcher',
  'ItemSearch',
  'DiscoverGrants',
  'DataSources',
  'SourceDirectory',
  'Diagnostics',
  'FrontendDiagnostics',
  'BackendDiagnostics',
  'NOFOParser',
  'AIGrantScorer',
  'Reports',
  'AdvancedAnalytics',
  'GrantMonitoring',
  'Stewardship',
  'Funders',
  'OutreachCampaigns',
  'TaxCenter',
  'Leads',
  'LeadDetail',
]);

/** Users with restricted access (see only their own profile) */
const RESTRICTED_ACCESS_USERS = Object.freeze([
  'rdashermiller@gmail.com',
]);

/** Normalize a possibly-number ID to a canonical string */
function normalizeId(id) {
  if (id === null || id === undefined) return null;
  try {
    return String(id).trim() || null;
  } catch {
    return null;
  }
}

/** Normalize email (lowercase + trim) for consistent comparisons */
function normalizeEmail(email) {
  if (!email) return null;
  return String(email).trim().toLowerCase() || null;
}

/**
 * Check if user is the owner with full access
 * @param {Object} user - User object with email/role
 * @returns {boolean}
 */
export function isOwner(user) {
  const e = normalizeEmail(user?.email);
  return e === normalizeEmail(OWNER_EMAIL) || user?.role === 'admin';
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
 * Check if user is a client_user with restricted access
 * Also treat specific emails as restricted.
 * @param {Object} user - User object
 * @returns {boolean}
 */
export function isClientUser(user) {
  const roleIsClient = (user?.role || '').toLowerCase() === 'client_user';
  const email = normalizeEmail(user?.email);
  return roleIsClient || (email ? RESTRICTED_ACCESS_USERS.includes(email) : false);
}

/**
 * Get appropriate query filter based on user permissions
 * Owner sees all, others see only their own data
 * @param {Object} user - User object
 * @param {Object} baseFilter - Base filter to extend
 * @returns {Object}
 */
export function getOwnershipFilter(user, baseFilter = {}) {
  if (isOwner(user)) return baseFilter;
  const email = normalizeEmail(user?.email);
  return {
    ...baseFilter,
    ...(email ? { created_by: email } : {}),
  };
}

/**
 * Wrap async data fetch with RLS error handling
 * Returns fallback value instead of throwing on RLS errors
 * @param {Function} fetchFn - Async function to execute
 * @param {any} fallback - Fallback value on error
 * @param {string} context - Context string for logging
 * @returns {Promise<any>}
 */
export async function safeDataFetch(fetchFn, fallback, context = 'Unknown') {
  try {
    const result = await fetchFn();
    return result ?? fallback;
  } catch (error) {
    console.warn(`[RLS] Data fetch blocked (${context}):`, error?.message || error);
    return fallback;
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
 * @param {any} error - Error to check
 * @returns {boolean}
 */
export function isRLSError(error) {
  const msg = (error?.message || '').toLowerCase();
  return (
    msg.includes('rls') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('access denied') ||
    msg.includes('permission')
  );
}

/**
 * Check if user can access a specific organization
 * - Admin/owner: always true
 * - client_user: must be in allowed_organization_ids
 * - everyone else: true (RLS will still enforce on backend)
 * @param {Object} user - User object
 * @param {string|number} organizationId - Organization ID to check
 * @returns {boolean}
 */
export function canAccessOrganization(user, organizationId) {
  const id = normalizeId(organizationId);
  if (!id) return false;
  if (isOwner(user)) return true;

  if (isClientUser(user)) {
    const allowed = Array.isArray(user?.allowed_organization_ids)
      ? user.allowed_organization_ids.map(normalizeId).filter(Boolean)
      : [];
    return allowed.includes(id);
  }

  // For standard users, defer to backend RLS
  return true;
}

/**
 * Check if a page is visible to client_user
 * Note: For non-client users, visibility is not restricted here.
 * @param {string} pageName - Page name to check
 * @returns {boolean}
 */
export function isPageVisibleToClient(pageName) {
  return CLIENT_VISIBLE_PAGES.includes(pageName);
}

/**
 * Filter organizations for a given user (UI helper)
 * - Admin: all
 * - client_user: allowed + owned
 * - Regular: created_by matches
 * @param {Array} organizations - Array of organization objects
 * @param {Object} user - User object
 * @returns {Array}
 */
export function filterOrganizationsForUser(organizations = [], user) {
  if (!user) return [];
  if (isOwner(user)) return organizations;

  const email = normalizeEmail(user.email);
  if ((user.role || '').toLowerCase() === 'client_user') {
    const allowed = new Set(
      (user.allowed_organization_ids || []).map(normalizeId).filter(Boolean)
    );
    return organizations.filter((org) => {
      const id = normalizeId(org.id);
      const owner = normalizeEmail(org.owner_email || null);
      return (id && allowed.has(id)) || (email && owner === email);
    });
  }

  return organizations.filter((org) => normalizeEmail(org.created_by || null) === email);
}

/**
 * Get client's primary organization ID
 * @param {Object} user - User object
 * @returns {string|null}
 */
export function getClientPrimaryOrganization(user) {
  if (!isClientUser(user)) return null;
  const primary = normalizeId(user?.primary_organization_id);
  if (primary) return primary;

  const first = (user?.allowed_organization_ids || [])
    .map(normalizeId)
    .filter(Boolean)[0];
  return first || null;
}

/**
 * Build navigation items for client_user
 * Returns null for non-client users.
 * @param {Object} user - User object
 * @returns {Array|null}
 */
export function getClientNavItems(user) {
  if (!isClientUser(user)) return null;
  const primaryOrgId = getClientPrimaryOrganization(user);
  return [
    { label: 'My Profile', path: primaryOrgId ? `/organizationprofile?id=${primaryOrgId}` : '/organizations', icon: 'User' },
    { label: 'My Grants', path: '/pipeline', icon: 'Target' },
    { label: 'My Documents', path: '/documents', icon: 'FileText' },
    { label: 'Services & Billing', path: '/billing', icon: 'DollarSign' },
    { label: 'Contact Admin', path: '/sendmessage', icon: 'Mail' },
  ];
}

/**
 * Gate a route name by user role.
 * - client_user: must be in CLIENT_VISIBLE_PAGES
 * - admin/owner: allowed
 * - others: allowed (UI-level; backend RLS still applies)
 * @param {Object} user - User object
 * @param {string} routeName - Route name to check
 * @returns {boolean}
 */
export function isRouteAllowedForUser(user, routeName) {
  if (isOwner(user)) return true;
  if (isClientUser(user)) {
    return isPageVisibleToClient(routeName) && !ADMIN_ONLY_PAGES.includes(routeName);
  }
  return true;
}

/**
 * Provide the restricted pages for a given user (UI can hide them)
 * @param {Object} user - User object
 * @returns {Array}
 */
export function getRestrictedPagesForUser(user) {
  if (isOwner(user)) return [];
  if (isClientUser(user)) return ADMIN_ONLY_PAGES;
  return [];
}