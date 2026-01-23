/**
 * Authentication middleware
 */

/**
 * Ensure user is authenticated
 */
export function ensureAuth(req, res, next) {
  const userId = req.ctx?.userId ?? req.user?.userId ?? null
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  next();
}

/**
 * Ensure user is an admin
 */
export function ensureAdmin(req, res, next) {
  if (!req.ctx?.isAdmin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  
  next();
}

/**
 * Ensure user can access a specific profile
 * @param {string} profileIdParam - Name of the route parameter containing profile ID
 */
export function ensureProfileAccess(profileIdParam = 'id') {
  return (req, res, next) => {
    const profileId = req.params[profileIdParam];
    
    if (!profileId) {
      return res.status(400).json({ error: 'Profile ID required' });
    }
    
    // Canonical admin bypass (DB-backed via req.ctx)
    if (req.ctx?.isAdmin) {
      return next();
    }

    // Canonical access set (resolved once in req.ctx)
    if (req.ctx?.accessibleProfileIds instanceof Set && req.ctx.accessibleProfileIds.has(String(profileId))) {
      return next();
    }

    return res.status(403).json({ error: 'Not authorized to access this profile' });
  };
}
