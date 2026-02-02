/**
 * Authentication middleware
 */

import { isAdminUserWithDb } from '../utils/accessControl.js'

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
 * Ensure user is an admin using robust DB-backed admin detection.
 * This replaces fragile token-only checks with DB resolution.
 */
export async function ensureAdmin(req, res, next) {
  const user = req.user ?? { role: 'guest' };
  
  if (user.role === 'guest') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    // Use req.ctx.isAdmin if available (canonical from requestContext middleware)
    const isAdmin = req.ctx?.isAdmin ?? (await isAdminUserWithDb(req.db, user));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin privileges required' });
    }
    next();
  } catch (error) {
    console.error('[auth] ensureAdmin check failed:', error?.message);
    return res.status(500).json({ error: 'Failed to verify admin privileges' });
  }
}

/**
 * Ensure user can access a specific profile
 * @param {string} profileIdParam - Name of the route parameter containing profile ID
 */
export function ensureProfileAccess(profileIdParam = 'id') {
  return async (req, res, next) => {
    const user = req.user ?? { role: 'guest' };
    const profileId = req.params[profileIdParam];
    
    if (!profileId) {
      return res.status(400).json({ error: 'Profile ID required' });
    }
    
    try {
      // ADMIN BYPASS: Use req.ctx if available (canonical), fallback to DB check
      const isAdmin = req.ctx?.isAdmin ?? (await isAdminUserWithDb(req.db, user));
      if (isAdmin) {
        return next();
      }
      
      // Check if profile is in user's accessible set (from req.ctx)
      if (req.ctx?.accessibleProfileIds === null) {
        // null means admin (all access) - already handled above
        return next();
      }
      
      if (req.ctx?.accessibleProfileIds?.has(profileId)) {
        return next();
      }
      
      // Check if profile belongs to user via user_id (async DB call)
      if (user.userId) {
        const profile = await new Promise((resolve, reject) => {
          try {
            const result = req.db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(profileId);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        });
        
        if (profile && profile.user_id === user.userId) {
          return next();
        }
      }
      
      return res.status(403).json({ error: 'Not authorized to access this profile' });
    } catch (error) {
      console.error('[auth] ensureProfileAccess check failed:', error?.message);
      return res.status(500).json({ error: 'Failed to verify profile access' });
    }
  };
}
