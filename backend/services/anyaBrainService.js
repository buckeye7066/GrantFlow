/**
 * Anya Brain Service
 * 
 * Manages Anya's persistent state including:
 * - Memory storage and retrieval
 * - Context tracking
 * - Tool usage learning
 * - Safe fallback behavior
 */

import { randomUUID } from 'crypto'

// Memory scopes
const SCOPES = {
  GLOBAL: 'global',
  PROFILE: 'profile',
  USER: 'user',
}

// Memory types
const MEMORY_TYPES = {
  FACT: 'fact',
  PREFERENCE: 'preference',
  CONTEXT: 'context',
  LEARNED_PATTERN: 'learned_pattern',
}

// Context types
const CONTEXT_TYPES = {
  TOPIC: 'topic',
  ENTITY: 'entity',
  INTENT: 'intent',
  GOAL: 'goal',
}

/**
 * Store a memory in Anya's brain
 */
export async function storeMemory(db, {
  scope = SCOPES.GLOBAL,
  scopeId = null,
  memoryType = MEMORY_TYPES.FACT,
  memoryKey,
  content,
  confidence = 1.0,
  expiresAt = null,
  source = 'system',
}) {
  if (!memoryKey) {
    throw new Error('Memory key is required')
  }
  
  const contentJson = typeof content === 'string' ? content : JSON.stringify(content)
  
  // Upsert memory
  const stmt = db.prepare(`
    INSERT INTO anya_brain_memory (
      id, scope, scope_id, memory_type, memory_key, content, confidence, expires_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, scope_id, memory_key) DO UPDATE SET
      content = excluded.content,
      confidence = excluded.confidence,
      expires_at = excluded.expires_at,
      source = excluded.source,
      updated_at = CURRENT_TIMESTAMP
  `)
  
  const id = randomUUID()
  await stmt.run(id, scope, scopeId, memoryType, memoryKey, contentJson, confidence, expiresAt, source)
  
  return { id, scope, scopeId, memoryKey, stored: true }
}

/**
 * Retrieve a specific memory by key
 */
export async function getMemory(db, { scope = SCOPES.GLOBAL, scopeId = null, memoryKey }) {
  let row
  try {
    row = await db.prepare(`
      SELECT *
      FROM anya_brain_memory
      WHERE scope = ? AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL)) AND memory_key = ?
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(scope, scopeId, scopeId, memoryKey)
  } catch (error) {
    if (!/no such column: (updated_at|created_at)/i.test(error?.message || '')) throw error
    row = await db.prepare(`
      SELECT *
      FROM anya_brain_memory
      WHERE scope = ? AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL)) AND memory_key = ?
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      LIMIT 1
    `).get(scope, scopeId, scopeId, memoryKey)
  }
  
  if (!row) return null
  
  // Update access count
  await db.prepare(`
    UPDATE anya_brain_memory
    SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(row.id)
  
  return {
    ...row,
    content: safeParseJson(row.content, {}),
  }
}

/**
 * Retrieve all memories for a scope
 */
export async function getMemories(db, { scope = SCOPES.GLOBAL, scopeId = null, memoryType = null, limit = 100 }) {
  let query = `
    SELECT *
    FROM anya_brain_memory
    WHERE scope = ? AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL))
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
  `
  const params = [scope, scopeId, scopeId]
  
  if (memoryType) {
    query += ` AND memory_type = ?`
    params.push(memoryType)
  }
  
  query += ` ORDER BY access_count DESC, updated_at DESC LIMIT ?`
  params.push(limit)
  
  const rows = await db.prepare(query).all(...params)
  
  return rows.map(row => ({
    ...row,
    content: safeParseJson(row.content, {}),
  }))
}

/**
 * Delete a memory
 */
export async function deleteMemory(db, { scope = SCOPES.GLOBAL, scopeId = null, memoryKey }) {
  const result = await db.prepare(`
    DELETE FROM anya_brain_memory
    WHERE scope = ? AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL)) AND memory_key = ?
  `).run(scope, scopeId, scopeId, memoryKey)
  
  return { deleted: result.changes > 0 }
}

/**
 * Store context for a session
 */
export async function storeContext(db, { sessionId, contextType, contextValue, turnNumber = 0 }) {
  if (!sessionId || !contextValue) {
    throw new Error('Session ID and context value are required')
  }
  
  const id = randomUUID()
  const stmt = db.prepare(`
    INSERT INTO anya_context (id, session_id, context_type, context_value, turn_number)
    VALUES (?, ?, ?, ?, ?)
  `)
  
  await stmt.run(id, sessionId, contextType, contextValue, turnNumber)
  
  return { id, stored: true }
}

/**
 * Get session context (most relevant items)
 */
export async function getSessionContext(db, sessionId, { limit = 10 } = {}) {
  const rows = await db.prepare(`
    SELECT *
    FROM anya_context
    WHERE session_id = ?
    ORDER BY relevance DESC, turn_number DESC
    LIMIT ?
  `).all(sessionId, limit)
  
  return rows
}

/**
 * Decay context relevance for older items
 */
export async function decayContextRelevance(db, sessionId, decayFactor = 0.9) {
  await db.prepare(`
    UPDATE anya_context
    SET relevance = relevance * ?
    WHERE session_id = ?
  `).run(decayFactor, sessionId)
}

/**
 * Track tool usage for learning
 */
export async function trackToolUsage(db, {
  toolName,
  sessionId = null,
  userId = null,
  profileId = null,
  parameters = {},
  success = true,
  errorMessage = null,
  executionTimeMs = null,
}) {
  const id = randomUUID()
  const paramsJson = JSON.stringify(parameters)
  
  const stmt = db.prepare(`
    INSERT INTO anya_tool_usage (
      id, tool_name, session_id, user_id, profile_id, parameters, success, error_message, execution_time_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  
  await stmt.run(id, toolName, sessionId, userId, profileId, paramsJson, success ? 1 : 0, errorMessage, executionTimeMs)
  
  return { id, tracked: true }
}

/**
 * Get tool usage statistics for learning optimal tool selection
 */
export async function getToolUsageStats(db, { toolName = null, userId = null, limit = 100 } = {}) {
  let query = `
    SELECT 
      tool_name,
      COUNT(*) as total_uses,
      SUM(success) as successful_uses,
      AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
      AVG(execution_time_ms) as avg_execution_time_ms
    FROM anya_tool_usage
    WHERE 1=1
  `
  const params = []
  
  if (toolName) {
    query += ` AND tool_name = ?`
    params.push(toolName)
  }
  
  if (userId) {
    query += ` AND user_id = ?`
    params.push(userId)
  }
  
  query += ` GROUP BY tool_name ORDER BY total_uses DESC LIMIT ?`
  params.push(limit)
  
  return await db.prepare(query).all(...params)
}

/**
 * Get Anya's brain summary for a user/profile
 */
export async function getBrainSummary(db, { userId = null, profileId = null } = {}) {
  const summary = {
    globalMemories: 0,
    userMemories: 0,
    profileMemories: 0,
    totalToolUsage: 0,
    recentToolUsage: [],
    topMemories: [],
  }
  
  // Count memories by scope
  summary.globalMemories = (await db.prepare(`
    SELECT COUNT(*) as count FROM anya_brain_memory WHERE scope = 'global'
  `).get())?.count || 0
  
  if (userId) {
    summary.userMemories = (await db.prepare(`
      SELECT COUNT(*) as count FROM anya_brain_memory WHERE scope = 'user' AND scope_id = ?
    `).get(userId))?.count || 0
  }
  
  if (profileId) {
    summary.profileMemories = (await db.prepare(`
      SELECT COUNT(*) as count FROM anya_brain_memory WHERE scope = 'profile' AND scope_id = ?
    `).get(profileId))?.count || 0
  }
  
  // Get tool usage stats
  summary.totalToolUsage = (await db.prepare(`
    SELECT COUNT(*) as count FROM anya_tool_usage
  `).get())?.count || 0
  
  // Get recent tool usage
  summary.recentToolUsage = await db.prepare(`
    SELECT tool_name, success, created_at
    FROM anya_tool_usage
    ORDER BY created_at DESC
    LIMIT 5
  `).all()
  
  // Get top memories
  summary.topMemories = await db.prepare(`
    SELECT memory_key, memory_type, access_count, updated_at
    FROM anya_brain_memory
    WHERE expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP
    ORDER BY access_count DESC
    LIMIT 10
  `).all()
  
  return summary
}

/**
 * Learn from user feedback on tool results
 */
export async function recordToolFeedback(db, { toolUsageId, rating, feedback }) {
  const result = await db.prepare(`
    UPDATE anya_tool_usage
    SET user_rating = ?, user_feedback = ?
    WHERE id = ?
  `).run(rating, feedback, toolUsageId)
  
  return { updated: result.changes > 0 }
}

/**
 * Cleanup expired memories and old context
 */
export async function cleanupBrain(db, { dryRun = false } = {}) {
  const rowsFromResult = (result) => Array.isArray(result) ? result : (result?.rows ?? [])
  const results = {
    dryRun: Boolean(dryRun),
    expiredMemories: 0,
    oldContext: 0,
    oldToolUsage: 0,
    removed_ids: {
      expiredMemories: [],
      oldContext: [],
      oldToolUsage: [],
    },
  }
  
  // Delete expired memories
  const expiredMemoryRows = rowsFromResult(await db.prepare(`
    SELECT id FROM anya_brain_memory
    WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
  `).all())
  results.expiredMemories = expiredMemoryRows.length
  results.removed_ids.expiredMemories = expiredMemoryRows.map((row) => row.id)
  if (!dryRun && expiredMemoryRows.length > 0) {
    await db.prepare(`
      DELETE FROM anya_brain_memory
      WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
    `).run()
  }
  
  // Delete old context (older than 30 days)
  const isPg = db?.dialect === 'postgres'
  const since30d = isPg ? "(NOW() - INTERVAL '30 days')" : "datetime('now', '-30 days')"
  const since90d = isPg ? "(NOW() - INTERVAL '90 days')" : "datetime('now', '-90 days')"

  const oldContextRows = rowsFromResult(await db.prepare(`
    SELECT id FROM anya_context
    WHERE created_at < ${since30d}
  `).all())
  results.oldContext = oldContextRows.length
  results.removed_ids.oldContext = oldContextRows.map((row) => row.id)
  if (!dryRun && oldContextRows.length > 0) {
    await db.prepare(`
      DELETE FROM anya_context
      WHERE created_at < ${since30d}
    `).run()
  }

  // Delete old tool usage (older than 90 days)
  const oldToolRows = rowsFromResult(await db.prepare(`
    SELECT id FROM anya_tool_usage
    WHERE created_at < ${since90d}
  `).all())
  results.oldToolUsage = oldToolRows.length
  results.removed_ids.oldToolUsage = oldToolRows.map((row) => row.id)
  if (!dryRun && oldToolRows.length > 0) {
    await db.prepare(`
      DELETE FROM anya_tool_usage
      WHERE created_at < ${since90d}
    `).run()
  }
  
  return results
}

/**
 * Safe JSON parse helper
 */
function safeParseJson(value, fallback = {}) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/**
 * Get safe fallback response when AI services are unavailable
 */
export function getSafeFallbackResponse(query, context = {}) {
  const lowerQuery = (query || '').toLowerCase()
  
  // Intent detection for fallback responses
  const intents = {
    greeting: ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening'],
    help: ['help', 'assist', 'support', 'how do i', 'how to'],
    grants: ['grant', 'funding', 'opportunity', 'scholarship'],
    profile: ['profile', 'organization', 'my account'],
    crawler: ['crawler', 'crawl', 'search', 'find'],
    status: ['status', 'health', 'working', 'check'],
  }
  
  let detectedIntent = 'unknown'
  for (const [intent, keywords] of Object.entries(intents)) {
    if (keywords.some(kw => lowerQuery.includes(kw))) {
      detectedIntent = intent
      break
    }
  }
  
  const userName = context.userName || 'there'
  
  const responses = {
    greeting: `Hello ${userName}! I'm Anya, your GrantFlow assistant. I'm currently operating in limited mode, but I can still help guide you through the app. What would you like to do?`,
    
    help: `Hi ${userName}! Here's how I can help:\n\n• **Discover Grants** - Browse funding opportunities\n• **Smart Matcher** - Get personalized recommendations\n• **Pipeline** - Track your applications\n• **Profile** - Manage your organization info\n\nWhat would you like to explore?`,
    
    grants: `To find grants:\n1. Click **'Discover Grants'** in the sidebar\n2. Use filters to narrow by category, deadline, or amount\n3. Try **'Smart Matcher'** for personalized recommendations\n\nNeed help with something specific?`,
    
    profile: `To manage your profile:\n1. Go to **'My Profiles'** in the sidebar\n2. Click on a profile to edit\n3. Complete all sections for better matching\n\nA complete profile helps find better grant matches!`,
    
    crawler: `Grant crawlers run automatically to find new opportunities. You can:\n1. Check **'Opportunities'** for latest results\n2. View crawler status in **Admin Panel** (admin only)\n3. Wait for Anya to notify you of new matches\n\nCrawlers typically run daily.`,
    
    status: `I'm operating in **limited mode** right now (AI services temporarily unavailable). Core features still work:\n✓ Browse grants\n✓ Manage profiles\n✓ Track applications\n\nFull AI assistance will resume shortly.`,
    
    unknown: `Hi ${userName}! I'm in limited mode right now, but I can still help you navigate GrantFlow.\n\nTry asking about:\n• Finding grants\n• Managing profiles\n• Tracking applications\n\nOr explore the sidebar menu for all features!`,
  }
  
  return {
    response: responses[detectedIntent],
    intent: detectedIntent,
    fallbackMode: true,
    capabilities: ['navigation', 'basic_help', 'feature_guidance'],
  }
}

// Export constants for use elsewhere
export { SCOPES, MEMORY_TYPES, CONTEXT_TYPES }
