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
  if ((value === null || value === undefined)) return fallback
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
 * Check if a profile is a volunteer fire department or EMS organization
 */
function checkFireDepartmentIndicators(profile) {
  if (!profile) return false
  const primaryType = normalizeString(profile.primary_type)
  const fireDeptTypes = ['volunteer_fire', 'fire_department', 'ems', 'emergency_services', 'fire_station']
  if (fireDeptTypes.some((t) => primaryType.includes(t))) return true
  const tags = safeParseJson(profile.tags, [])
  if (Array.isArray(tags)) {
    const tagsLower = tags.map((t) => normalizeString(t)).filter(Boolean)
    const fireKeywords = ['fire', 'ems', 'emergency', 'first responder', 'ambulance', 'rescue']
    if (fireKeywords.some((kw) => tagsLower.some((t) => t.includes(kw)))) return true
  }
  return false
}

/**
 * Check if a profile is a church or religious organization
 */
function checkChurchIndicators(profile) {
  if (!profile) return false
  const primaryType = normalizeString(profile.primary_type)
  const churchTypes = ['church', 'religious_organization', 'faith_based', 'congregation', 'ministry', 'mosque', 'synagogue', 'temple']
  if (churchTypes.some((t) => primaryType.includes(t))) return true
  const tags = safeParseJson(profile.tags, [])
  if (Array.isArray(tags)) {
    const tagsLower = tags.map((t) => normalizeString(t)).filter(Boolean)
    const churchKeywords = ['church', 'faith', 'religious', 'ministry', 'congregation', 'worship', 'diocese', 'parish']
    if (churchKeywords.some((kw) => tagsLower.some((t) => t.includes(kw)))) return true
  }
  return false
}

/**
 * Check if a profile indicates a single-parent household
 */
function checkSingleParentIndicators({ profile, sections }) {
  if (!profile) return false

  const family = safeParseJson(profile.family, {})

  // Must have children to qualify
  const hasChildren =
    family?.has_children ||
    sections?.family_information?.has_children ||
    false

  if (!hasChildren) return false

  // Single-parent indicators
  if (family?.single_parent) return true
  if (profile.household_size === 1) return true

  const maritalStatus = normalizeString(
    sections?.family_information?.marital_status ?? ''
  )
  if (['single', 'divorced', 'widowed'].includes(maritalStatus)) return true

  return false
}

/**
 * Check if a profile indicates a senior (age 60+)
 */
function checkSeniorIndicators({ profile, sections, signals }) {
  if (!profile) return false

  // Direct age field on profile
  if (typeof profile.age === 'number' && profile.age >= 60) return true
  if (typeof profile.age === 'string' && parseInt(profile.age, 10) >= 60) return true

  // Age in basic_information section
  const basicAge = sections?.basic_information?.age
  if (typeof basicAge === 'number' && basicAge >= 60) return true
  if (typeof basicAge === 'string' && parseInt(basicAge, 10) >= 60) return true

  // Age group in demographics section
  const ageGroup = normalizeString(sections?.demographics?.age_group ?? '')
  if (ageGroup === 'senior' || ageGroup === '65+') return true

  // Derived signals
  if (signals?.demographics?.has?.('senior')) return true
  if (signals?.demographics?.has?.('elderly')) return true

  return false
}

/**
 * Check if a profile is a rural organization, farm, or tribal entity
 */
function checkRuralOrganizationIndicators(profile) {
  if (!profile) return false
  const primaryType = normalizeString(profile.primary_type)
  const ruralTypes = ['farm', 'agriculture', 'rural', 'tribal', 'tribe', 'rancher', 'cooperative', 'rural_org']
  if (ruralTypes.some((t) => primaryType.includes(t))) return true
  const tags = safeParseJson(profile.tags, [])
  if (Array.isArray(tags)) {
    const tagsLower = tags.map((t) => normalizeString(t)).filter(Boolean)
    const ruralKeywords = ['rural', 'farm', 'agriculture', 'tribal', 'usda', 'ranching', 'cooperative']
    if (ruralKeywords.some((kw) => tagsLower.some((t) => t.includes(kw)))) return true
  }
  return false
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

      // 2a. Student bridge funding (off-campus living + move-in + emergency
      // bridge funds tied to the student's actual Fall enrollment cycle).
      // Idempotent — safe to enqueue on every auto-discovery cycle.
      jobs.push({
        id: randomUUID(),
        type: 'student_bridge_funding',
        profile_id: profileId,
        parameters: {},
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

        // 4. Government Funding crawler (federal and state grants)
        jobs.push({
                id: randomUUID(),
                type: 'government_funding',
                profile_id: profileId,
                parameters: {}
        })

        // 5. Student Grants crawler (scholarships, tuition assistance)
        // Always queue — even non-students may qualify for education-adjacent grants
        if (isStudent) {
                jobs.push({
                          id: randomUUID(),
                          type: 'student_grants',
                          profile_id: profileId,
                          parameters: {}
                })
        }

        // 6. Special Needs crawler (disability services, adaptive equipment)
        jobs.push({
                id: randomUUID(),
                type: 'special_needs',
                profile_id: profileId,
                parameters: {}
        })

        // 7. ECF / HCBS Benefits crawler (Medicaid waivers, community-based services)
        jobs.push({
                id: randomUUID(),
                type: 'ecf_hcbs',
                profile_id: profileId,
                parameters: {}
        })

        // 8. Volunteer fire department / EMS grants
        const isFireDept = checkFireDepartmentIndicators(profile)
        if (isFireDept) {
          jobs.push({
            id: randomUUID(),
            type: 'government_funding',
            profile_id: profileId,
            parameters: {
              focus_areas: ['fire_department', 'afg', 'safer', 'fema_grants', 'volunteer_fire'],
              keywords: ['Assistance to Firefighters Grant', 'SAFER grant', 'volunteer fire department', 'EMS grant', 'FEMA AFG'],
            }
          })
        }

        // 9. Church / faith-based organization grants
        const isChurch = checkChurchIndicators(profile)
        if (isChurch) {
          jobs.push({
            id: randomUUID(),
            type: 'government_funding',
            profile_id: profileId,
            parameters: {
              focus_areas: ['faith_based', 'church', 'community_development', 'social_services'],
              keywords: ['faith-based organization grant', 'community development church', 'CDBG faith based', 'HHS faith based'],
            }
          })
        }

        // 10. Rural organization / farm / tribal grants
        const isRuralOrg = checkRuralOrganizationIndicators(profile)
        if (isRuralOrg) {
          jobs.push({
            id: randomUUID(),
            type: 'government_funding',
            profile_id: profileId,
            parameters: {
              focus_areas: ['rural', 'agriculture', 'usda', 'tribal'],
              keywords: ['USDA rural development', 'tribal grant', 'agriculture grant', 'rural community', 'rural cooperative'],
            }
          })
        }

        // 11. Single-parent household benefits
        const isSingleParent = checkSingleParentIndicators({ profile, sections })
        if (isSingleParent) {
          jobs.push({
            id: randomUUID(),
            type: 'curated_benefits',
            profile_id: profileId,
            parameters: {
              focus_areas: ['single_parent', 'childcare', 'tanf', 'child_support', 'wic', 'head_start', 'ccap'],
              priority: 'high',
            }
          })
        }

        // 12. Senior (age 60+) benefits
        const isSenior = checkSeniorIndicators({ profile, sections, signals })
        if (isSenior) {
          jobs.push({
            id: randomUUID(),
            type: 'curated_benefits',
            profile_id: profileId,
            parameters: {
              focus_areas: ['senior', 'medicare', 'medicaid_senior', 'meals_on_wheels', 'senior_nutrition', 'property_tax_relief', 'senior_housing', 'aaa', 'ship_counseling'],
              priority: 'high',
            }
          })
        }

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
