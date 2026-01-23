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
    const user = req.user ?? { role: 'guest' };
    const profileId = req.params[profileIdParam];
    
    if (!profileId) {
      return res.status(400).json({ error: 'Profile ID required' });
    }
    
    // Admin can access all profiles
    if (user.role === 'admin') {
      return next();
    }
    
    // User must match profile or user ID
    if (user.profileId === profileId) {
      return next();
    }
    
    // Check if profile belongs to user via user_id
    if (user.userId) {
      const profile = req.db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(profileId);
      if (profile && profile.user_id === user.userId) {
        return next();
      }
    }
    
    return res.status(403).json({ error: 'Not authorized to access this profile' });
  };
}
