/**
 * Utility function to create page URLs for React Router
 * @param {string} pageName - Name of the page (e.g., "Dashboard", "Organizations")
 * @returns {string} URL path for the page
 */
export const createPageUrl = (pageName) => {
  if (!pageName) return '/';
  
  // Remove any existing slashes and convert to lowercase
  const cleanPageName = pageName.replace(/^\/+|\/+$/g, '');
  
  // Return path with leading slash
  return `/${cleanPageName.toLowerCase()}`;
};

/**
 * Parse URL search parameters safely
 * @param {string} search - URL search string (e.g., "?id=123&tab=details")
 * @returns {URLSearchParams} URLSearchParams object
 */
export const parseSearchParams = (search) => {
  return new URLSearchParams(search);
};

/**
 * Build URL with search parameters
 * @param {string} path - Base path
 * @param {Object} params - Object of key-value pairs for search params
 * @returns {string} Complete URL with search parameters
 */
export const buildUrlWithParams = (path, params = {}) => {
  const searchParams = new URLSearchParams(params);
  const queryString = searchParams.toString();
  return queryString ? `${path}?${queryString}` : path;
};