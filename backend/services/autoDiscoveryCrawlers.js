import { dispatchCrawlerJob } from './crawlerDispatcher.js'

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

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profile) {
      console.warn('[auto-discovery] Profile not found:', profileId)
      return
    }

    // TODO: Remove debug log - console.log(`[auto-discovery] Triggering crawlers for profile ${profileId} (${profile.display_name})`)

    const jobs = []
    
    // 1. Local crawler (profile zip + 50 mile radius)
    // Always queue local crawler for personalized geographic opportunities
    jobs.push({
      type: 'local',
      profile_id: profileId,
      parameters: { radius: 50 }
    })
    
    // 2. Scholarship crawler (if student indicators exist)
    const isStudent = checkStudentIndicators(profile)
    if (isStudent) {
      // TODO: Remove debug log - console.log(`[auto-discovery] Profile ${profileId} has student indicators, queuing scholarship crawler`)
      jobs.push({
        type: 'scholarship',
        profile_id: profileId,
        parameters: {}
      })
    }
    
    // 3. Comprehensive crawler (nationwide, all templates)
    // No limit_per_zip - process ALL templates
    jobs.push({
      type: 'comprehensive',
      profile_id: profileId,
      parameters: {
        fallback_zip_limit: 100 // Start with 100 zips, expand over time
      }
    })
    
    // Insert all jobs into database
    const insertStmt = db.prepare(`
      INSERT INTO crawler_jobs (type, status, profile_id, parameters, requested_by)
      VALUES (?, 'queued', ?, ?, 'auto-discovery')
    `)
    
    const jobIds = []
    jobs.forEach(job => {
      const result = insertStmt.run(job.type, job.profile_id, JSON.stringify(job.parameters))
      jobIds.push(result.lastInsertRowid)
    })
    
    // TODO: Remove debug log - console.log(`[auto-discovery] Queued ${jobs.length} jobs for profile ${profileId}:`, jobIds)
    
    // Dispatch jobs asynchronously (fire and forget)
    // Query only the fields needed for dispatch
    const queuedJobs = db.prepare(`
      SELECT id, type, profile_id, parameters
      FROM crawler_jobs 
      WHERE profile_id = ? AND status = 'queued' AND requested_by = 'auto-discovery'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(profileId, jobs.length)
    
    // Dispatch each job asynchronously
    queuedJobs.forEach(job => {
      dispatchCrawlerJob({ 
        db, 
        jobId: job.id, 
        uploadDir: options.uploadDir,
        getOpenAI: options.getOpenAI
      }).catch(err => {
        console.error(`[auto-discovery] Job ${job.id} dispatch failed:`, err)
      })
    })
    
    // TODO: Remove debug log - console.log(`[auto-discovery] Dispatched ${queuedJobs.length} crawler jobs`)
  } catch (error) {
    console.error('[auto-discovery] Failed to trigger crawlers:', error)
    // Don't throw - we don't want to block login if auto-discovery fails
  }
}
