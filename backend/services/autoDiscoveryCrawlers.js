import { dispatchCrawlerJob } from './crawlerDispatcher.js'
import { randomUUID } from 'crypto'
import { buildProfileSignals } from './profileHelpers.js'

/**
 * Check if a profile has student indicators
 * @param {object} profile - Profile object from database
 * @returns {boolean} True if profile indicates student status
 */
function checkStudentIndicators(profile) {
  if (!profile) return false
  
  // Check primary_type for student indicators
  const studentTypes = ['high_school_student', 'college_student', 'graduate_student', 'student']
  if (profile.primary_type) {
    const primaryTypeLower = profile.primary_type.toLowerCase()
    if (studentTypes.some(type => primaryTypeLower.includes(type))) {
      return true
    }
  }
  
  // Check tags for student indicators (parse once)
  if (profile.tags) {
    try {
      const tags = typeof profile.tags === 'string' ? JSON.parse(profile.tags) : profile.tags
      if (Array.isArray(tags) && tags.length > 0) {
        const studentKeywords = ['student', 'education', 'scholarship', 'college', 'university', 'school']
        // Convert tags to lowercase once for efficiency
        const tagsLower = tags.map(tag => String(tag).toLowerCase())
        return studentKeywords.some(keyword => 
          tagsLower.some(tag => tag.includes(keyword))
        )
      }
    } catch (error) {
      console.warn('[auto-discovery] Failed to parse profile tags:', error)
    }
  }
  
  return false
}

function safeParseJson(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  try {
    return JSON.parse(trimmed)
  } catch {
    return fallback
  }
}

function normalizeString(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return v || ''
}

/**
 * Check if a profile has health/medical indicators
 * Mirrors the student pattern, but consults sections + derived signals when available.
 */
function checkHealthIndicators({ profile, sections, signals }) {
  if (!profile) return false

  const primaryType = normalizeString(profile.primary_type)
  if (primaryType) {
    const tokens = ['health', 'medical', 'patient', 'disability', 'caregiver']
    if (tokens.some((t) => primaryType.includes(t))) return true
  }

  // Tags can be stringified JSON or array depending on caller.
  const tags = safeParseJson(profile.tags, [])
  if (Array.isArray(tags) && tags.length > 0) {
    const healthKeywords = ['health', 'medical', 'patient', 'disability', 'dialysis', 'transplant', 'cancer', 'hiv', 'tbi']
    const tagsLower = tags.map((tag) => normalizeString(tag)).filter(Boolean)
    if (healthKeywords.some((kw) => tagsLower.some((t) => t.includes(kw)))) return true
  }

  const health = sections?.health_medical ?? {}
  if (health && typeof health === 'object') {
    if (health.chronic_illness || health.dialysis_patient || health.organ_transplant || health.hiv_aids) return true
    if (health.tbi_survivor || health.amputee || health.neurodivergent || health.mental_health_condition) return true
    if (health.wheelchair_user || health.visual_impairment || health.hearing_impairment) return true
    if (Array.isArray(health.disability_type) && health.disability_type.length > 0) return true
    if (Array.isArray(health.support_needs) && health.support_needs.length > 0) return true
    if (Array.isArray(health.conditions) && health.conditions.length > 0) return true
    if (typeof health.notes === 'string' && health.notes.trim().length > 0) return true
  }

  // Signals are the "use all profile data" derived form used by crawlers.
  if (signals?.health?.size && signals.health.size > 0) return true
  if (signals?.assistance?.has?.('medicaid') || signals?.assistance?.has?.('medicare')) return true

  return false
}

/**
 * Automatically trigger discovery crawlers for a user profile on login
 * @param {object} db - Database instance
 * @param {string} profileId - Profile ID to discover opportunities for
 * @param {object} options - Additional options (uploadDir, getOpenAI for dispatcher)
 * @returns {Promise<void>}
 */
export async function triggerAutoDiscoveryCrawlers(db, profileId, options = {}) {
  try {
    if (!profileId) {
      console.warn('[auto-discovery] No profileId provided, skipping auto-discovery')
      return
    }

    const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profile) {
      console.warn('[auto-discovery] Profile not found:', profileId)
      return
    }

    // Load sections once (for health indicators + signals). Safe if table is missing.
    let sections = {}
    try {
      const rows = await db
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(profileId)
      for (const row of rows || []) {
        if (!row?.section_key) continue
        const data = safeParseJson(row.data, {})
        sections[String(row.section_key)] = data && typeof data === 'object' ? data : {}
      }
    } catch (error) {
      // Keep auto-discovery non-blocking even on schema drift.
      sections = {}
      console.warn('[auto-discovery] Unable to load profile_sections (continuing):', error?.message || String(error))
    }

    // Derive signals (mirrors crawler matching logic).
    const signals = buildProfileSignals({ profile, sections })

    const jobs = []
    
    // 1. Local crawler (profile zip + 25 mile radius)
    // Always queue local crawler for personalized geographic opportunities
    jobs.push({
      id: randomUUID(),
      type: 'local',
      profile_id: profileId,
      parameters: { radius: 25 }
    })
    
    // 2. Scholarship crawler (if student indicators exist)
    const isStudent = checkStudentIndicators(profile)
    if (isStudent) {
      jobs.push({
        id: randomUUID(),
        type: 'scholarship',
        profile_id: profileId,
        parameters: {}
      })
    }

    // 2b. Health resources crawler (if health indicators exist)
    const isHealth = checkHealthIndicators({ profile, sections, signals })
    if (isHealth) {
      const consent = Boolean(sections?.health_medical?.consent_for_studies)
      jobs.push({
        id: randomUUID(),
        type: 'health_resources',
        profile_id: profileId,
        parameters: { include_trials: consent }
      })
    }
    
    // 3. Comprehensive crawler (nationwide, all templates)
    // No limit_per_zip - process ALL templates
    jobs.push({
      id: randomUUID(),
      type: 'comprehensive',
      profile_id: profileId,
      parameters: {
        fallback_zip_limit: 100 // Start with 100 zips, expand over time
      }
    })
    
    // Insert all jobs into database
    const insertStmt = db.prepare(`
      INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by)
      VALUES (?, ?, 'queued', ?, ?, 'auto-discovery')
    `)

    for (const job of jobs) {
      await insertStmt.run(job.id, job.type, job.profile_id, JSON.stringify(job.parameters))
    }

    // Dispatch jobs asynchronously (fire and forget)
    for (const job of jobs) {
      dispatchCrawlerJob({
        db,
        jobId: job.id,
        uploadDir: options.uploadDir,
        getOpenAI: options.getOpenAI,
      }).catch((err) => {
        console.error(`[auto-discovery] Job ${job.id} dispatch failed:`, err)
      })
    }
  } catch (error) {
    console.error('[auto-discovery] Failed to trigger crawlers:', error)
    // Don't throw - we don't want to block login if auto-discovery fails
  }
}
