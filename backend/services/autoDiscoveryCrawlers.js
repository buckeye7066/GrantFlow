import { dispatchCrawlerJob } from './crawlerDispatcher.js'
import { randomUUID } from 'crypto'
import { buildProfileSignals, computeProfileDigest, resolveEffectiveProfileType } from './profileHelpers.js'

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
  const displayName = normalizeString(profile.display_name)
  if (displayName) {
    const churchNameKeywords = ['church', 'congregation', 'parish', 'diocese', 'synagogue', 'mosque', 'temple', 'faith community']
    if (churchNameKeywords.some((kw) => displayName.includes(kw))) return true
  }
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
 * Check whether a profile represents an organization (nonprofit, business, or
 * other registered entity) rather than an individual / student / household.
 *
 * Used to gate the foundation_990 crawler: private-foundation discovery is only
 * relevant to entities that can RECEIVE foundation grants. We must NOT fire it
 * for individuals or students (a corporation gets foundation 990s; a student
 * does not — canonical relevance gating, see docs/canonical_rules.md G4).
 */
function checkOrganizationIndicators({ profile, sections }) {
  if (!profile) return false

  // Individuals / households / students are explicitly NOT organizations even if
  // a stray keyword leaks into a tag. Exclude these first so the foundation_990
  // gate can never fire for them.
  const INDIVIDUAL_TYPES = [
    'individual', 'student', 'high_school_student', 'college_student',
    'graduate_student', 'family', 'household', 'caregiver', 'senior',
    'veteran', 'patient',
  ]
  const ORG_TYPES = [
    'nonprofit', 'non_profit', 'non-profit', 'charity', 'charitable', 'foundation',
    'organization', 'org', 'business', 'company', 'corporation', 'corp',
    'llc', 'enterprise', 'small_business', 'medium_corporation', 'large_corporation',
    'church', 'religious_organization', 'faith_based', 'ministry', 'school',
    'public_school', 'school_district', 'university', 'college', 'municipality',
    'government', 'tribal', 'cooperative', 'food_pantry', 'food_bank',
    'homeless_shelter', 'animal_rescue', 'fire_department', 'volunteer_fire_department',
  ]

  const primaryType = normalizeString(profile.primary_type)
  if (primaryType) {
    // Exact individual types short-circuit to false.
    if (INDIVIDUAL_TYPES.includes(primaryType)) return false
    if (ORG_TYPES.some((t) => primaryType.includes(t))) return true
  }

  // organization_details section is the canonical org marker when present.
  const orgDetails = sections?.organization_details
  if (orgDetails && typeof orgDetails === 'object') {
    const orgType = normalizeString(orgDetails.organization_type)
    if (orgType && !INDIVIDUAL_TYPES.includes(orgType)) return true
    if (orgDetails.ein || orgDetails.tax_id || orgDetails.is_501c3) return true
  }

  // An explicitly set organization_id linkage indicates an entity profile.
  if (profile.organization_id) return true

  return false
}

/**
 * Check whether a profile has explicit MEDICAL CONDITIONS (not just generic
 * health indicators). Required — together with consent_for_studies — to gate the
 * clinical_trials crawler so it only fires for opted-in profiles that actually
 * have a condition a trial could match.
 */
function checkMedicalConditions({ sections, signals }) {
  const health = sections?.health_medical
  if (health && typeof health === 'object') {
    if (Array.isArray(health.conditions) && health.conditions.length > 0) return true
    if (Array.isArray(health.disability_type) && health.disability_type.length > 0) return true
    if (
      health.chronic_illness ||
      health.dialysis_patient ||
      health.organ_transplant ||
      health.hiv_aids ||
      health.cancer ||
      health.rare_disease
    ) {
      return true
    }
  }
  if (signals?.health?.size && signals.health.size > 0) return true
  return false
}

/**
 * Automatically trigger discovery crawlers for a user profile on login
 * @param {object} db - Database instance
 * @param {string} profileId - Profile ID to discover opportunities for
 * @param {object} options - Additional options (uploadDir, getOpenAI for dispatcher)
 * @returns {Promise<void>}
 */
function withDiscoveryMetadata(parameters, { profileDigest, trigger }) {
  const merged = { ...(parameters && typeof parameters === 'object' ? parameters : {}) }
  if (profileDigest) merged._profile_digest = profileDigest
  if (trigger) merged._trigger = trigger
  return merged
}

export async function triggerAutoDiscoveryCrawlers(db, profileId, options = {}) {
  try {
    if (!profileId) {
      console.warn('[auto-discovery] No profileId provided, skipping auto-discovery')
      return
    }

    const requestedBy = options.requestedBy || 'auto-discovery'
    let profileDigest = options.profileDigest
    if (!profileDigest) {
      try {
        profileDigest = await computeProfileDigest(db, profileId)
      } catch (digestErr) {
        console.warn('[auto-discovery] Unable to compute profile digest:', digestErr?.message || digestErr)
      }
    }
    const discoveryMeta = { profileDigest, trigger: options.trigger || null }

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

    const effectivePrimaryType = resolveEffectiveProfileType(profile, sections)
    const profileForDiscovery = {
      ...profile,
      primary_type: effectivePrimaryType ?? profile.primary_type,
    }

    // Derive signals (mirrors crawler matching logic).
    const signals = buildProfileSignals({ profile: profileForDiscovery, sections })

    const jobs = []
    
    // 1. Local crawler (profile zip + 25 mile radius)
    // Always queue local crawler for personalized geographic opportunities
    jobs.push({
      id: randomUUID(),
      type: 'local',
      profile_id: profileId,
      parameters: withDiscoveryMetadata({ radius: 25 }, discoveryMeta),
    })
    
    // 2. Scholarship crawler (if student indicators exist)
    const isStudent = checkStudentIndicators(profileForDiscovery)
    if (isStudent) {
      jobs.push({
        id: randomUUID(),
        type: 'scholarship',
        profile_id: profileId,
        parameters: withDiscoveryMetadata({}, discoveryMeta),
      })

      // 2a. Student bridge funding (off-campus living + move-in + emergency
      // bridge funds tied to the student's actual Fall enrollment cycle).
      // Idempotent — safe to enqueue on every auto-discovery cycle.
      jobs.push({
        id: randomUUID(),
        type: 'student_bridge_funding',
        profile_id: profileId,
        parameters: withDiscoveryMetadata({}, discoveryMeta),
      })
    }

    // 2b. Health resources crawler (if health indicators exist)
    const isHealth = checkHealthIndicators({ profile: profileForDiscovery, sections, signals })
    const consentForStudies = Boolean(sections?.health_medical?.consent_for_studies)
    if (isHealth) {
      jobs.push({
        id: randomUUID(),
        type: 'health_resources',
        profile_id: profileId,
        parameters: withDiscoveryMetadata({ include_trials: consentForStudies }, discoveryMeta),
      })
    }

    // 2c. Clinical trials crawler — ONLY when the profile EXPLICITLY opted in
    // (health_medical.consent_for_studies) AND actually has a medical condition
    // a trial could match. Discovery/display only; never enrolls. The connector
    // re-checks the opt-in gate, but we also gate here so we never enqueue a
    // guaranteed-no-op job for non-consenting / no-condition profiles.
    const hasMedicalConditions = checkMedicalConditions({ sections, signals })
    if (consentForStudies && hasMedicalConditions) {
      jobs.push({
        id: randomUUID(),
        type: 'clinical_trials',
        profile_id: profileId,
        parameters: withDiscoveryMetadata({}, discoveryMeta),
      })
    }
    
    // 3. Comprehensive crawler (nationwide, all templates)
    // No limit_per_zip - process ALL templates
    jobs.push({
      id: randomUUID(),
      type: 'comprehensive',
      profile_id: profileId,
      parameters: withDiscoveryMetadata(
        {
          fallback_zip_limit: 100, // Start with 100 zips, expand over time
        },
        discoveryMeta,
      ),
    })

        // 4. Government Funding crawler (federal and state grants)
        jobs.push({
                id: randomUUID(),
                type: 'government_funding',
                profile_id: profileId,
                parameters: withDiscoveryMetadata({}, discoveryMeta),
        })

        // 5. Student Grants crawler (scholarships, tuition assistance)
        // Always queue — even non-students may qualify for education-adjacent grants
        if (isStudent) {
                jobs.push({
                          id: randomUUID(),
                          type: 'student_grants',
                          profile_id: profileId,
                          parameters: withDiscoveryMetadata({}, discoveryMeta),
                })
        }

        // 6. Special Needs crawler (disability services, adaptive equipment)
        jobs.push({
                id: randomUUID(),
                type: 'special_needs',
                profile_id: profileId,
                parameters: withDiscoveryMetadata({}, discoveryMeta),
        })

        // 7. ECF / HCBS Benefits crawler (Medicaid waivers, community-based services)
        jobs.push({
                id: randomUUID(),
                type: 'ecf_hcbs',
                profile_id: profileId,
                parameters: withDiscoveryMetadata({}, discoveryMeta),
        })

        // 8. Volunteer fire department / EMS grants
        const isFireDept = checkFireDepartmentIndicators(profileForDiscovery)
        if (isFireDept) {
          jobs.push({
            id: randomUUID(),
            type: 'government_funding',
            profile_id: profileId,
            parameters: withDiscoveryMetadata({
              focus_areas: ['fire_department', 'afg', 'safer', 'fema_grants', 'volunteer_fire'],
              keywords: ['Assistance to Firefighters Grant', 'SAFER grant', 'volunteer fire department', 'EMS grant', 'FEMA AFG'],
            }, discoveryMeta),
          })
        }

        // 9. Church / faith-based organization grants
        const isChurch = checkChurchIndicators(profileForDiscovery)
        if (isChurch) {
          jobs.push({
            id: randomUUID(),
            type: 'government_funding',
            profile_id: profileId,
            parameters: withDiscoveryMetadata({
              focus_areas: ['faith_based', 'church', 'community_development', 'social_services'],
              keywords: ['faith-based organization grant', 'community development church', 'CDBG faith based', 'HHS faith based'],
            }, discoveryMeta),
          })
        }

        // 10. Rural organization / farm / tribal grants
        const isRuralOrg = checkRuralOrganizationIndicators(profileForDiscovery)
        if (isRuralOrg) {
          jobs.push({
            id: randomUUID(),
            type: 'government_funding',
            profile_id: profileId,
            parameters: withDiscoveryMetadata({
              focus_areas: ['rural', 'agriculture', 'usda', 'tribal'],
              keywords: ['USDA rural development', 'tribal grant', 'agriculture grant', 'rural community', 'rural cooperative'],
            }, discoveryMeta),
          })
        }

        // 11. Single-parent household benefits
        const isSingleParent = checkSingleParentIndicators({ profile: profileForDiscovery, sections })
        if (isSingleParent) {
          jobs.push({
            id: randomUUID(),
            type: 'curated_benefits',
            profile_id: profileId,
            parameters: withDiscoveryMetadata({
              focus_areas: ['single_parent', 'childcare', 'tanf', 'child_support', 'wic', 'head_start', 'ccap'],
              priority: 'high',
            }, discoveryMeta),
          })
        }

        // 12. Senior (age 60+) benefits
        const isSenior = checkSeniorIndicators({ profile: profileForDiscovery, sections, signals })
        if (isSenior) {
          jobs.push({
            id: randomUUID(),
            type: 'curated_benefits',
            profile_id: profileId,
            parameters: withDiscoveryMetadata({
              focus_areas: ['senior', 'medicare', 'medicaid_senior', 'meals_on_wheels', 'senior_nutrition', 'property_tax_relief', 'senior_housing', 'aaa', 'ship_counseling'],
              priority: 'high',
            }, discoveryMeta),
          })
        }

        // 13. Private-foundation (IRS Form 990) discovery — ONLY for
        // organization/nonprofit/business entities that can RECEIVE foundation
        // grants. Gated OUT for individuals/students/households (a corporation
        // gets foundation 990s; a student does not — canonical relevance gating).
        const isOrganization = checkOrganizationIndicators({ profile: profileForDiscovery, sections })
        if (isOrganization) {
          jobs.push({
            id: randomUUID(),
            type: 'foundation_990',
            profile_id: profileId,
            parameters: withDiscoveryMetadata({}, discoveryMeta),
          })
        }

    // Insert all jobs into database
    const insertStmt = db.prepare(`
      INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `)

    for (const job of jobs) {
      await insertStmt.run(job.id, job.type, job.profile_id, JSON.stringify(job.parameters), requestedBy)
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

    // Return an honest summary so on-demand callers (and tests) can report
    // exactly which relevant crawlers were enqueued for this profile. The
    // crawler_types list preserves enqueue order but de-duplicates so the UI
    // can show distinct types fired.
    const crawlerTypes = [...new Set(jobs.map((job) => job.type))]
    return {
      jobs_enqueued: jobs.length,
      crawler_types: crawlerTypes,
      job_ids: jobs.map((job) => job.id),
    }
  } catch (error) {
    console.error('[auto-discovery] Failed to trigger crawlers:', error)
    // Don't throw - we don't want to block login if auto-discovery fails
    return { jobs_enqueued: 0, crawler_types: [], job_ids: [], error: error?.message || String(error) }
  }
}
