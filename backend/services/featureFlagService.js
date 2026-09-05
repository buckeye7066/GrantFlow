/**
 * Feature Flag Service
 * 
 * Simple, production-grade feature flag system for GrantFlow.
 * Supports global flags, user-specific flags, and percentage rollouts.
 */

import { randomUUID } from 'crypto'

// Default feature flags
const DEFAULT_FLAGS = {
  // Anya AI features
  'anya.enabled': { enabled: true, description: 'Enable Anya AI assistant' },
  'anya.brain': { enabled: true, description: 'Enable Anya persistent memory' },
  'anya.autonomous': { enabled: true, description: 'Enable Anya autonomous operations', requiresAdmin: true },
  
  // Crawler features
  'crawlers.geo': { enabled: true, description: 'Enable Geo Crawl (comprehensive by geography)' },
  'crawlers.scholarship': { enabled: true, description: 'Enable scholarship crawler' },
  'crawlers.local': { enabled: true, description: 'Enable local opportunity crawler' },
  'crawlers.auto_run': { enabled: false, description: 'Enable automatic crawler runs on login' },
  
  // Profile features
  'profiles.avatar_lookup': { enabled: true, description: 'Enable AI avatar lookup' },
  'profiles.enrichment': { enabled: true, description: 'Enable profile enrichment' },
  'profiles.import_export': { enabled: true, description: 'Enable profile import/export' },
  
  // UI features
  'ui.dark_mode': { enabled: true, description: 'Enable dark mode toggle' },
  'ui.advanced_filters': { enabled: true, description: 'Enable advanced grant filters' },
  'ui.onboarding': { enabled: true, description: 'Show onboarding wizard for new users' },
  
  // Admin features
  'admin.diagnostics': { enabled: true, description: 'Enable admin diagnostics panel', requiresAdmin: true },
  'admin.code_scan': { enabled: true, description: 'Enable admin code scanning tools', requiresAdmin: true },
  'admin.audit_logs': { enabled: true, description: 'Enable audit log viewing', requiresAdmin: true },
  
  // Experimental features
  'experimental.ai_matching': { enabled: false, description: 'Enable AI-powered grant matching (experimental)', percentage: 0 },
  'experimental.real_time_alerts': { enabled: false, description: 'Enable real-time deadline alerts (experimental)', percentage: 0 },

  // vNext backbone
  // NOTE: In Postgres deployments, feature flags are currently defaults-only (in-memory).
  // Use SHOULDERS_VNEXT=true as an emergency override if you need to enable without DB-backed flags.
  'shoulders.vnext': { enabled: false, description: 'Enable vNext Shoulders of Giants backbone (applications state machine)' },
}

// In-memory cache for flags (refreshed periodically)
let flagCache = new Map()
let lastCacheRefresh = 0
const CACHE_TTL_MS = 60 * 1000 // 1 minute

/**
 * Initialize feature flags (create table if needed)
 */
export function initializeFeatureFlags(db) {
  if (!db) {
    console.error('[FeatureFlags] Database connection required for initialization')
    throw new Error('Database connection required for feature flag initialization')
  }

  // Postgres: for now, keep feature flags in-memory only (defaults) to avoid dialect-specific
  // table DDL during the DB migration rollout. We'll migrate these tables explicitly later.
  if (db.dialect === 'postgres') {
    flagCache = new Map(
      Object.entries(DEFAULT_FLAGS).map(([key, cfg]) => [
        key,
        {
          flag_key: key,
          enabled: cfg.enabled ? 1 : 0,
          requires_admin: cfg.requiresAdmin ? 1 : 0,
          percentage: cfg.percentage || 100,
          description: cfg.description || '',
          metadata: '{}',
        },
      ]),
    )
    lastCacheRefresh = Date.now()
    return
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        flag_key TEXT UNIQUE NOT NULL,
        enabled INTEGER DEFAULT 0,
        description TEXT,
        percentage INTEGER DEFAULT 100,
        requires_admin INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_feature_flags_key ON feature_flags(flag_key);

      CREATE TABLE IF NOT EXISTS feature_flag_overrides (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        flag_key TEXT NOT NULL,
        user_id TEXT,
        profile_id TEXT,
        enabled INTEGER NOT NULL,
        expires_at DATETIME,
        UNIQUE(flag_key, user_id, profile_id)
      );

      CREATE INDEX IF NOT EXISTS idx_flag_overrides_key ON feature_flag_overrides(flag_key);
      CREATE INDEX IF NOT EXISTS idx_flag_overrides_user ON feature_flag_overrides(user_id);
    `)

    // Seed default flags if they don't exist
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO feature_flags (id, flag_key, enabled, description, percentage, requires_admin)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    for (const [key, config] of Object.entries(DEFAULT_FLAGS)) {
      insertStmt.run(
        randomUUID(),
        key,
        config.enabled ? 1 : 0,
        config.description || '',
        config.percentage || 100,
        config.requiresAdmin ? 1 : 0
      )
    }

    refreshCache(db)
  } catch (error) {
    console.error('[FeatureFlags] Failed to initialize:', error.message)
  }
}

/**
 * Refresh the in-memory cache
 */
function refreshCache(db) {
  if (!db) {
    console.error('[FeatureFlags] Cannot refresh cache without database connection')
    return
  }
  if (db.dialect === 'postgres') return
  
  try {
    const flags = db.prepare('SELECT * FROM feature_flags').all()
    flagCache = new Map(flags.map(f => [f.flag_key, f]))
    lastCacheRefresh = Date.now()
  } catch (error) {
    console.error('[FeatureFlags] Failed to refresh cache:', error.message)
  }
}

/**
 * Check if a feature flag is enabled for a given context
 */
export function isFeatureEnabled(db, flagKey, { userId = null, profileId = null, isAdmin = false } = {}) {
  if (!db) {
    console.warn('[FeatureFlags] No database connection, using defaults only')
  }
  
  // Refresh cache if stale
  if (Date.now() - lastCacheRefresh > CACHE_TTL_MS) {
    refreshCache(db)
  }
  
  // Check for user/profile override first
  if (db && db.dialect !== 'postgres' && (userId || profileId)) {
    try {
      const override = db.prepare(`
        SELECT enabled
        FROM feature_flag_overrides
        WHERE flag_key = ?
          AND ((user_id = ? AND user_id IS NOT NULL) OR (profile_id = ? AND profile_id IS NOT NULL))
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        LIMIT 1
      `).get(flagKey, userId, profileId)
      
      if (override) {
        return Boolean(override.enabled)
      }
    } catch (error) {
      // Fall through to default behavior
    }
  }
  
  // Get flag from cache or default
  let flag = flagCache.get(flagKey)
  
  if (!flag) {
    // Check default flags
    const defaultConfig = DEFAULT_FLAGS[flagKey]
    if (defaultConfig) {
      flag = {
        enabled: defaultConfig.enabled ? 1 : 0,
        requires_admin: defaultConfig.requiresAdmin ? 1 : 0,
        percentage: defaultConfig.percentage || 100,
      }
    } else {
      // Unknown flag - default to disabled
      return false
    }
  }
  
  // Check admin requirement
  if (flag.requires_admin && !isAdmin) {
    return false
  }
  
  // Check if globally enabled
  if (!flag.enabled) {
    return false
  }
  
  // Check percentage rollout
  if (flag.percentage < 100) {
    if (!userId) {
      // No user context - use random fallback for percentage rollout
      return Math.random() * 100 < flag.percentage
    }
    // Use consistent hashing based on userId for stable rollout
    const hash = simpleHash(userId + flagKey)
    const bucket = hash % 100
    return bucket < flag.percentage
  }
  
  return Boolean(flag.enabled)
}

/**
 * Canonical server-side gate for the Shoulders vNext backbone.
 *
 * Both mutation routes and read-side guidance must use this helper so an
 * application row left behind by an earlier rollout cannot advertise actions
 * that the current user/profile is no longer allowed to invoke.
 */
export function isShouldersVnextEnabled(
  db,
  { userId = null, profileId = null, isAdmin = false } = {},
) {
  const envEnabled = String(process.env.SHOULDERS_VNEXT || '').trim().toLowerCase() === 'true'
  if (envEnabled) return true
  try {
    return isFeatureEnabled(db, 'shoulders.vnext', { userId, profileId, isAdmin })
  } catch {
    return false
  }
}

/**
 * Get all feature flags (admin only)
 */
export function getAllFlags(db) {
  if (!db) {
    console.error('[FeatureFlags] Database required to get all flags')
    // Return default flags when DB unavailable
    return Object.entries(DEFAULT_FLAGS).map(([key, config]) => ({
      flag_key: key,
      enabled: config.enabled,
      description: config.description || '',
      percentage: config.percentage || 100,
      requires_admin: config.requiresAdmin || false,
      metadata: {}
    }))
  }
  
  try {
    const flags = db.prepare('SELECT * FROM feature_flags ORDER BY flag_key').all()
    return flags.map(f => ({
      ...f,
      enabled: Boolean(f.enabled),
      requires_admin: Boolean(f.requires_admin),
      metadata: f.metadata ? JSON.parse(f.metadata) : {},
    }))
  } catch (error) {
    console.error('[FeatureFlags] Failed to get all flags:', error.message)
    return []
  }
}

/**
 * Update a feature flag (admin only)
 */
export function updateFlag(db, flagKey, { enabled, description, percentage, metadata }) {
  if (!db) throw new Error('Database connection unavailable')
  
  const updates = []
  const params = []
  
  if (enabled !== undefined) {
    updates.push('enabled = ?')
    params.push(enabled ? 1 : 0)
  }
  
  if (description !== undefined) {
    updates.push('description = ?')
    params.push(description)
  }
  
  if (percentage !== undefined) {
    updates.push('percentage = ?')
    params.push(Math.max(0, Math.min(100, percentage)))
  }
  
  if (metadata !== undefined) {
    updates.push('metadata = ?')
    params.push(JSON.stringify(metadata))
  }
  
  if (updates.length === 0) {
    throw new Error('No updates provided')
  }
  
  updates.push('updated_at = CURRENT_TIMESTAMP')
  params.push(flagKey)
  
  const result = db.prepare(`
    UPDATE feature_flags
    SET ${updates.join(', ')}
    WHERE flag_key = ?
  `).run(...params)
  
  // Refresh cache
  refreshCache(db)
  
  return { updated: result.changes > 0 }
}

/**
 * Create a flag override for a specific user or profile
 */
export function createFlagOverride(db, flagKey, { userId = null, profileId = null, enabled, expiresInDays = null }) {
  if (!db) throw new Error('Database connection unavailable')
  if (!userId && !profileId) throw new Error('Either userId or profileId required')
  
  const id = randomUUID()
  const expiresAt = expiresInDays 
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null
  
  const stmt = db.prepare(`
    INSERT INTO feature_flag_overrides (id, flag_key, user_id, profile_id, enabled, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(flag_key, user_id, profile_id) DO UPDATE SET
      enabled = excluded.enabled,
      expires_at = excluded.expires_at
  `)
  
  stmt.run(id, flagKey, userId, profileId, enabled ? 1 : 0, expiresAt)
  
  return { id, created: true }
}

/**
 * Remove a flag override
 */
export function removeFlagOverride(db, flagKey, { userId = null, profileId = null }) {
  if (!db) throw new Error('Database connection unavailable')
  
  const result = db.prepare(`
    DELETE FROM feature_flag_overrides
    WHERE flag_key = ?
      AND ((user_id = ? AND user_id IS NOT NULL) OR (profile_id = ? AND profile_id IS NOT NULL))
  `).run(flagKey, userId, profileId)
  
  return { removed: result.changes > 0 }
}

/**
 * Get flag overrides for a user/profile
 */
export function getFlagOverrides(db, { userId = null, profileId = null }) {
  if (!db) return []
  
  try {
    const overrides = db.prepare(`
      SELECT *
      FROM feature_flag_overrides
      WHERE ((user_id = ? AND user_id IS NOT NULL) OR (profile_id = ? AND profile_id IS NOT NULL))
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `).all(userId, profileId)
    
    return overrides.map(o => ({
      ...o,
      enabled: Boolean(o.enabled),
    }))
  } catch (error) {
    console.error('[FeatureFlags] Failed to get overrides:', error.message)
    return []
  }
}

/**
 * Simple hash function for percentage rollout
 */
// Cap iteration to a sane bound: `str` is built from userId+flagKey, and an
// unbounded loop count derived from external input is a resource-exhaustion
// vector (js/loop-bound-injection) even though both inputs are normally
// short. Anything past this length is truncated for hashing purposes only —
// rollout bucketing degrading slightly on a pathological input is fine.
const SIMPLE_HASH_MAX_CHARS = 4096

function simpleHash(str) {
  let hash = 0
  const bounded = str.length > SIMPLE_HASH_MAX_CHARS ? str.slice(0, SIMPLE_HASH_MAX_CHARS) : str
  for (let i = 0; i < bounded.length; i++) {
    const char = bounded.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash)
}

/**
 * Cleanup expired overrides
 */
export function cleanupExpiredOverrides(db) {
  if (!db) return { deleted: 0 }
  
  try {
    const result = db.prepare(`
      DELETE FROM feature_flag_overrides
      WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
    `).run()
    
    return { deleted: result.changes }
  } catch (error) {
    console.error('[FeatureFlags] Failed to cleanup overrides:', error.message)
    return { deleted: 0 }
  }
}
