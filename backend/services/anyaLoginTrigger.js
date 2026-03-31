/**
 * Anya Login Trigger
 * Automatically initializes Anya AI Assistant for ANY user on login.
 * Creates crawler jobs scoped to their profile and an Anya session.
 */

import { randomUUID } from 'crypto'
import { dispatchCrawlerJob } from './crawlerDispatcher.js'

function isAdmin(user) {
  return Boolean(user?.role === 'admin' || user?.is_admin === true || user?.is_admin === 1)
}

async function createAnyaSession(db, userId, profileId, title) {
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
    title || 'Login Auto-Crawl Session',
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
  
  stmt.run(
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
  
  stmt.run(
    messageId,
    sessionId,
    role,
    content
  )
  
  return messageId
}

/**
 * Initialize Anya for ANY user on login.
 * Regular users get core crawlers for their profile.
 * Admins get additional crawlers (profile_enrichment, government_funding, etc.).
 *
 * The legacy name is kept as an alias so existing call-sites don't break.
 */
export async function initializeAnyaOnLogin(db, user, profileId = null, { uploadDir, getOpenAI } = {}) {
  try {
    // Resolve profile for this user
    if (!profileId && user?.id) {
      const row = db.prepare(`
        SELECT id FROM profiles WHERE user_id = ? LIMIT 1
      `).get(user.id)
      profileId = row?.id || null
    }

    // Admins: fall back to any profile if theirs isn't linked
    if (!profileId && isAdmin(user)) {
      const row = db.prepare(`
        SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1
      `).get()
      profileId = row?.id || null
    }

    if (!profileId) {
      return null
    }

    const admin = isAdmin(user)
    const sessionTitle = admin ? 'Admin Login Auto-Crawl Session' : 'Login Auto-Crawl Session'
    const sessionId = await createAnyaSession(db, user.id, profileId, sessionTitle)

    const coreDefs = [
      ['local', { radius_miles: 25, max_results: 100 }],
      ['scholarship', { max_results: 50 }],
      ['comprehensive', { max_results: 200 }],
    ]
    if (admin) {
      coreDefs.push(
        ['profile_enrichment', {}],
        ['government_funding', {}],
        ['special_needs', {}],
        ['ecf_hcbs', {}],
        ['student_grants', {}],
      )
    }

    const entries = await Promise.all(
      coreDefs.map(async ([type, params]) => [type, await createCrawlerJob(db, profileId, type, params)])
    )
    const jobIds = Object.fromEntries(entries)

    // Dispatch + welcome message in background — do NOT block login response
    setImmediate(() => {
      for (const [type, jobId] of Object.entries(jobIds)) {
        try {
          const promise = dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI })
          if (promise && typeof promise.catch === 'function') {
            promise.catch(err => console.error(`[anyaLoginTrigger] Job ${jobId} (${type}) dispatch failed:`, err))
          }
        } catch (err) {
          console.error(`[anyaLoginTrigger] Job ${jobId} (${type}) dispatch failed:`, err)
        }
      }

      const welcomeMessage = admin
        ? `Welcome back! I've automatically started background tasks: Local, Scholarship, Comprehensive, Profile Enrichment, Government Funding, Special Needs & ECF/HCBS, and Student Grants. Ask me about crawler status anytime.`
        : `Welcome! I'm searching for local opportunities, scholarships, and nationwide matches for your profile. Results will be ready shortly.`

      addAnyaMessage(db, sessionId, 'assistant', welcomeMessage).catch(err =>
        console.error('[anyaLoginTrigger] Failed to add welcome message:', err)
      )
    })

    return { sessionId, jobIds, profileId }
  } catch (error) {
    console.error('[anyaLoginTrigger] Failed to initialize Anya:', error)
    return null
  }
}

// Backward-compatible alias
export const initializeAnyaForAdmin = initializeAnyaOnLogin

/**
 * Get Anya session info for response
 */
export async function getAnyaSessionInfo(db, sessionId) {
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
