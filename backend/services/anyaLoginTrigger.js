/**
 * Anya Login Trigger
 * Automatically initializes Anya AI Assistant for admin users on login
 * Creates crawler jobs and Anya session to monitor the work
 */

import { randomUUID } from 'crypto'
import { dispatchCrawlerJob } from './crawlerDispatcher.js'

const ADMIN_EMAIL = 'buckeye7066@gmail.com'

/**
 * Check if user is the admin
 * Checks both primary_email (from database) and email (for compatibility)
 */
function isAdmin(user) {
  return Boolean(user?.is_admin) || user?.primary_email === ADMIN_EMAIL || user?.email === ADMIN_EMAIL || user?.role === 'admin'
}

/**
 * Create an Anya session for the admin user
 */
function createAnyaSession(db, userId, profileId) {
  const sessionId = randomUUID()
  
  const stmt = db.prepare(`
    INSERT INTO anya_sessions (
      id,
      user_id,
      profile_id,
      status,
      title,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  
  stmt.run(
    sessionId,
    userId || null,
    profileId || null,
    'open',
    'Admin Login Auto-Crawl Session',
    JSON.stringify({
      auto_created: true,
      created_on_login: true,
      timestamp: new Date().toISOString(),
    })
  )
  
  return sessionId
}

/**
 * Create a crawler job
 */
function createCrawlerJob(db, profileId, crawlerType, parameters = {}) {
  const jobId = randomUUID()
  
  const stmt = db.prepare(`
    INSERT INTO crawler_jobs (
      id,
      profile_id,
      type,
      status,
      parameters
    ) VALUES (?, ?, ?, ?, ?)
  `)
  
  stmt.run(
    jobId,
    profileId,
    crawlerType,
    'queued',
    JSON.stringify(parameters)
  )
  
  // TODO: Remove debug log - console.log(`[anyaLoginTrigger] Created ${crawlerType} crawler job:`, jobId)
  
  return jobId
}

/**
 * Add a message to Anya session
 */
function addAnyaMessage(db, sessionId, role, content) {
  const messageId = randomUUID()
  
  const stmt = db.prepare(`
    INSERT INTO anya_messages (
      id,
      session_id,
      role,
      content
    ) VALUES (?, ?, ?, ?)
  `)
  
  stmt.run(
    messageId,
    sessionId,
    role,
    content
  )
  
  return messageId
}

/**
 * Initialize Anya for admin user on login
 * Creates crawler jobs and Anya session
 * @param {object} options - Options object with db, user, profileId, uploadDir, getOpenAI
 */
export function initializeAnyaForAdmin(db, user, profileId = null, { uploadDir, getOpenAI } = {}) {
  // Only initialize for admin users
  if (!isAdmin(user)) {
    // TODO: Remove debug log - console.log('[anyaLoginTrigger] User is not admin, skipping Anya initialization')
    return null
  }
  
  // TODO: Remove debug log - console.log('[anyaLoginTrigger] Initializing Anya for admin login:', user.email || user.id)
  
  try {
    // Get the admin's profile if not provided
    if (!profileId && user.id) {
      const row = db.prepare(`
        SELECT id FROM profiles WHERE user_id = ? LIMIT 1
      `).get(user.id)
      
      profileId = row?.id || null
    }
    
    // If still no profile, get the first profile as fallback
    if (!profileId) {
      const row = db.prepare(`
        SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1
      `).get()
      
      profileId = row?.id || null
    }
    
    if (!profileId) {
      // TODO: Remove debug log - console.log('[anyaLoginTrigger] No profile found, cannot create crawler jobs')
      return null
    }
    
    // Create Anya session
    const sessionId = createAnyaSession(db, user.id, profileId)
    
    // Create crawler jobs
    const jobIds = {
      local: createCrawlerJob(db, profileId, 'local', {
        radius_miles: 50,
        max_results: 100,
      }),
      scholarship: createCrawlerJob(db, profileId, 'scholarship', {
        max_results: 50,
      }),
      comprehensive: createCrawlerJob(db, profileId, 'comprehensive', {
        max_results: 200,
      }),
      profile_enrichment: createCrawlerJob(db, profileId, 'profile_enrichment', {}),
    }
    
    // Dispatch each crawler job
    Object.entries(jobIds).forEach(([type, jobId]) => {
      try {
        dispatchCrawlerJob({
          db,
          jobId,
          uploadDir,
          getOpenAI
        })
        console.log(`[anyaLoginTrigger] Dispatched ${type} crawler job: ${jobId}`)
      } catch (err) {
        console.error(`[anyaLoginTrigger] Job ${jobId} (${type}) dispatch failed:`, err)
      }
    })
    
    // Add welcome message from Anya
    const welcomeMessage = `Welcome back! I've automatically started the following background tasks for you:

1. **Local Opportunities** - Searching within 50 miles
2. **Scholarship Opportunities** - Finding relevant scholarships
3. **Comprehensive National Search** - Scanning nationwide funding sources
4. **Profile Enrichment** - Updating profile data

I'll notify you when these crawlers complete. You can check their progress anytime by asking me about crawler status.

How can I help you today?`
    
    addAnyaMessage(db, sessionId, 'assistant', welcomeMessage)
    
    // TODO: Remove debug log - console.log('[anyaLoginTrigger] Anya initialized successfully')
    // TODO: Remove debug log - console.log('[anyaLoginTrigger] Session ID:', sessionId)
    // TODO: Remove debug log - console.log('[anyaLoginTrigger] Job IDs:', jobIds)
    
    return {
      sessionId,
      jobIds,
      profileId,
    }
  } catch (error) {
    console.error('[anyaLoginTrigger] Failed to initialize Anya:', error)
    return null
  }
}

/**
 * Get Anya session info for response
 */
export function getAnyaSessionInfo(db, sessionId) {
  if (!sessionId) return null
  
  const session = db.prepare(`
    SELECT * FROM anya_sessions WHERE id = ? LIMIT 1
  `).get(sessionId)
  
  if (!session) return null
  
  return {
    session_id: session.id,
    status: session.status,
    title: session.title,
  }
}
