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
async function createAnyaSession(db, userId, profileId) {
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
  
  await stmt.run(
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
async function createCrawlerJob(db, profileId, crawlerType, parameters = {}) {
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
  
  await stmt.run(
    jobId,
    profileId,
    crawlerType,
    'queued',
    JSON.stringify(parameters)
  )
  
  return jobId
}

/**
 * Add a message to Anya session
 */
async function addAnyaMessage(db, sessionId, role, content) {
  const messageId = randomUUID()
  
  const stmt = db.prepare(`
    INSERT INTO anya_messages (
      id,
      session_id,
      role,
      content
    ) VALUES (?, ?, ?, ?)
  `)
  
  await stmt.run(
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
export async function initializeAnyaForAdmin(db, user, profileId = null, { uploadDir, getOpenAI } = {}) {
  // Only initialize for admin users
  if (!isAdmin(user)) {
    return null
  }
  
  try {
    // Get the admin's profile if not provided
    if (!profileId && user.id) {
      const row = await db.prepare(`
        SELECT id FROM profiles WHERE user_id = ? LIMIT 1
      `).get(user.id)
      
      profileId = row?.id || null
    }
    
    // If still no profile, get the first profile as fallback
    if (!profileId) {
      const row = await db.prepare(`
        SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1
      `).get()
      
      profileId = row?.id || null
    }
    
    if (!profileId) {
      return null
    }
    
    // Create Anya session
    const sessionId = await createAnyaSession(db, user.id, profileId)
    
    // Create crawler jobs
    const jobIds = {
      local: await createCrawlerJob(db, profileId, 'local', {
        radius_miles: 50,
        max_results: 100,
      }),
      scholarship: await createCrawlerJob(db, profileId, 'scholarship', {
        max_results: 50,
      }),
      comprehensive: await createCrawlerJob(db, profileId, 'comprehensive', {
        max_results: 200,
      }),
      profile_enrichment: await createCrawlerJob(db, profileId, 'profile_enrichment', {}),
    }
    
    // Dispatch each crawler job to actually start them (fire and forget)
    Object.entries(jobIds).forEach(([type, jobId]) => {
      try {
        const promise = dispatchCrawlerJob({
          db,
          jobId,
          uploadDir,
          getOpenAI
        })
        // If it returns a Promise, handle errors
        if (promise && typeof promise.catch === 'function') {
          promise.catch(err => {
            console.error(`[anyaLoginTrigger] Job ${jobId} (${type}) dispatch failed:`, err)
          })
        }
        console.log(`[anyaLoginTrigger] Dispatched ${type} crawler job: ${jobId}`)
      } catch (err) {
        console.error(`[anyaLoginTrigger] Job ${jobId} (${type}) dispatch failed:`, err)
      }
    })
    
    // Add welcome message from Anya
    const welcomeMessage = `Welcome back! I've automatically started the following background tasks for you:

1. **Local Opportunities** - Searching within 50 miles
2. **Scholarship Opportunities** - Finding relevant scholarships
3. **Geo Crawl** - Scanning nationwide funding sources by geography
4. **Profile Enrichment** - Updating profile data

I'll notify you when these crawlers complete. You can check their progress anytime by asking me about crawler status.

How can I help you today?`
    
    await addAnyaMessage(db, sessionId, 'assistant', welcomeMessage)
    
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
export async function getAnyaSessionInfo(db, sessionId) {
  if (!sessionId) return null
  
  const session = await db.prepare(`
    SELECT * FROM anya_sessions WHERE id = ? LIMIT 1
  `).get(sessionId)
  
  if (!session) return null
  
  return {
    session_id: session.id,
    status: session.status,
    title: session.title,
  }
}
