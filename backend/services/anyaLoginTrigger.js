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
  
  await stmt.run(
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
      const row = await db.prepare(`
        SELECT id FROM profiles WHERE user_id = ? LIMIT 1
      `).get(user.id)
      profileId = row?.id || null
    }

    // Admins: fall back to any profile if theirs isn't linked
    if (!profileId && isAdmin(user)) {
      const row = await db.prepare(`
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

    // Core crawlers — every user gets these
    const jobIds = {
      local: await createCrawlerJob(db, profileId, 'local', {
        radius_miles: 25,
        max_results: 100,
      }),
      scholarship: await createCrawlerJob(db, profileId, 'scholarship', {
        max_results: 50,
      }),
      comprehensive: await createCrawlerJob(db, profileId, 'comprehensive', {
        max_results: 200,
      }),
    }

    // Admin-only crawlers (heavier workload)
    if (admin) {
      jobIds.profile_enrichment = await createCrawlerJob(db, profileId, 'profile_enrichment', {})
      jobIds.government_funding = await createCrawlerJob(db, profileId, 'government_funding', {})
      jobIds.special_needs = await createCrawlerJob(db, profileId, 'special_needs', {})
      jobIds.ecf_hcbs = await createCrawlerJob(db, profileId, 'ecf_hcbs', {})
      jobIds.student_grants = await createCrawlerJob(db, profileId, 'student_grants', {})
    }

    // Dispatch all jobs (fire-and-forget)
    Object.entries(jobIds).forEach(([type, jobId]) => {
      try {
        const promise = dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI })
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

    const welcomeMessage = admin
      ? `Welcome back! I've automatically started the following background tasks:

1. **Local Opportunities** - Searching within 25 miles
2. **Scholarship Opportunities** - Finding relevant scholarships
3. **Comprehensive Match** - Scanning the opportunity catalog for strong nationwide matches
4. **Profile Enrichment** - Updating profile data
5. **Government Funding** - Federal / state programs
6. **Special Needs & ECF/HCBS** - Specialized programs

I'll notify you when these crawlers complete. You can check their progress anytime by asking me about crawler status.

How can I help you today?`
      : `Welcome! I'm searching for funding opportunities that match your profile:

1. **Local Opportunities** - Searching near you
2. **Scholarships** - Finding relevant scholarships
3. **Nationwide Match** - Scanning the full catalog

I'll have results ready shortly. How can I help you today?`

    await addAnyaMessage(db, sessionId, 'assistant', welcomeMessage)

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
