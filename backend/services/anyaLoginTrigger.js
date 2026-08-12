/**
 * Anya Login Trigger
 * Automatically initializes Anya AI Assistant for ANY user on login.
 * Creates crawler jobs scoped to their profile and an Anya session.
 */

import { randomUUID } from 'crypto'
import { dispatchCrawlerJob } from './crawlerDispatcher.js'
import { isSupersededCrawlerType } from '../../shared/supersededCrawlerTypes.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaLoginTrigger')

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
  // CUTOVER GUARD: never enqueue a retired discovery crawler. Discovery now runs
  // synchronously through the Crawler OS; these rows were pure panel noise.
  if (isSupersededCrawlerType(crawlerType)) {
    log.info('[anyaLoginTrigger] Skipped retired discovery crawler (superseded by Crawler OS)', { crawlerType, profileId })
    return null
  }

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
      // No profile found: create a guidance-only session so the user gets
      // actionable feedback rather than silence (Goals 10, 14).
      try {
        const guidanceSessionId = await createAnyaSession(db, user?.id || null, null, 'Profile Setup Required')
        await addAnyaMessage(
          db,
          guidanceSessionId,
          'assistant',
          `Welcome! To find funding opportunities for you, I need a little more information. Please complete your profile â including your location, household needs, and applicant type â so I can start searching. Go to Profile to get started.`
        )
        return { sessionId: guidanceSessionId, jobIds: {}, profileId: null }
      } catch (guidanceErr) {
        console.error('[anyaLoginTrigger] Failed to create guidance session for profileless user:', guidanceErr)
        return null
      }
    }

    const admin = isAdmin(user)
    const sessionTitle = admin ? 'Admin Login Auto-Crawl Session' : 'Login Auto-Crawl Session'
    const sessionId = await createAnyaSession(db, user.id, profileId, sessionTitle)

    // Fetch profile data needed for profile-scoped crawl parameters
    const profileRow = db.prepare(
      `SELECT state, zip_code, needs, applicant_type,
              military, education, health, housing, business, family, emergency
       FROM profiles WHERE id = ? LIMIT 1`
    ).get(profileId)

    const profileContext = profileRow
      ? {
          state: profileRow.state || null,
          zip_code: profileRow.zip_code || null,
          needs: profileRow.needs || null,
          applicant_type: profileRow.applicant_type || null,
          military: profileRow.military || null,
          education: profileRow.education || null,
          health: profileRow.health || null,
          housing: profileRow.housing || null,
          business: profileRow.business || null,
          family: profileRow.family || null,
          emergency: profileRow.emergency || null,
        }
      : {}

    const coreDefs = [
      ['local', { radius_miles: 25, max_results: 100, ...profileContext }],
      ['scholarship', { max_results: 50, ...profileContext }],
      ['comprehensive', { max_results: 200, ...profileContext }],
    ]
    if (admin) {
      coreDefs.push(
        ['profile_enrichment', { ...profileContext }],
        ['government_funding', { ...profileContext }],
        ['special_needs', { ...profileContext }],
        ['ecf_hcbs', { ...profileContext }],
        ['student_grants', { ...profileContext }],
      )
    }

    // Drop retired discovery crawlers up front — only real automations
    // (e.g. profile_enrichment) still enqueue a job row. Discovery itself runs
    // synchronously via the Crawler OS elsewhere.
    const activeDefs = coreDefs.filter(([type]) => !isSupersededCrawlerType(type))

    const entries = (await Promise.all(
      activeDefs.map(async ([type, params]) => [type, await createCrawlerJob(db, profileId, type, params)])
    )).filter(([, jobId]) => Boolean(jobId))
    const jobIds = Object.fromEntries(entries)

    // Dispatch + welcome message in background — do NOT block login response
    setImmediate(() => {
      const dispatchResults = []

      for (const [type, jobId] of Object.entries(jobIds)) {
        try {
          const promise = dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI })
          if (promise && typeof promise.catch === 'function') {
            promise.catch(err => {
              console.error(`[anyaLoginTrigger] Job ${jobId} (${type}) dispatch failed:`, err)
              try {
                db.prepare(
                  `UPDATE crawler_jobs SET status = 'failed', error = ? WHERE id = ?`
                ).run(String(err?.message || err), jobId)
              } catch (dbErr) {
                console.error(`[anyaLoginTrigger] Failed to record dispatch failure for job ${jobId}:`, dbErr)
              }
            })
          }
          dispatchResults.push({ type, jobId, dispatched: true })
        } catch (err) {
          console.error(`[anyaLoginTrigger] Job ${jobId} (${type}) dispatch failed:`, err)
          dispatchResults.push({ type, jobId, dispatched: false, error: String(err?.message || err) })
          try {
            db.prepare(
              `UPDATE crawler_jobs SET status = 'failed', error = ? WHERE id = ?`
            ).run(String(err?.message || err), jobId)
          } catch (dbErr) {
            console.error(`[anyaLoginTrigger] Failed to record dispatch failure for job ${jobId}:`, dbErr)
          }
        }
      }

      const failedCount = dispatchResults.filter(r => !r.dispatched).length
      if (failedCount > 0) {
        console.warn(
          '[anyaLoginTrigger] %s/%s crawler jobs failed to dispatch for profileId=%s',
          failedCount,
          dispatchResults.length,
          profileId,
          dispatchResults.filter(r => !r.dispatched)
        )
      } else {
        log.info(
          `[anyaLoginTrigger] All ${dispatchResults.length} crawler jobs dispatched for profileId=${profileId}`
        )
      }

      const locationHint = profileContext.zip_code || profileContext.state
        ? ` near ${[profileContext.zip_code, profileContext.state].filter(Boolean).join(', ')}`
        : ''
      const needsHint = profileContext.needs
        ? ` focused on your needs (${String(profileContext.needs).split(',').slice(0, 3).join(', ')})`
        : ''
      const welcomeMessage = admin
        ? `Welcome back! I've automatically started background tasks: Local, Scholarship, Comprehensive, Profile Enrichment, Government Funding, Special Needs & ECF/HCBS, and Student Grants. A nationwide geo ZIP discovery sweep (all states, paced state-by-state) also queues in the background when due — check Automation or ask me about geo crawl status.`
        : `Welcome! I'm searching for local opportunities${locationHint}${needsHint}, plus scholarships and nationwide matches. Results will be ready shortly.`

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
