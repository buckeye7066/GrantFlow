/**
 * Anya Context Builder
 *
 * Builds a rich, data-grounded context snapshot that gets injected into Anya's
 * system prompt. This is what makes Anya context-aware: she reads real backend
 * data (profile, results, page state) and can explain, suggest, and detect gaps.
 *
 * The context is structured text appended to the system prompt so the LLM has
 * concrete facts to reference — no generic advice, only system-grounded guidance.
 */

import { loadProfileContext, buildProfileSignals } from './profileHelpers.js'
import { buildProfileFacets } from './profile/profileTaxonomy.js'
import { computeMatchDecision } from './matchDecisionEngine.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { assessOpportunityTrust } from './opportunityTrust.js'
import { getMemories } from './anyaBrainService.js'

// Section labels aligned with canonical keys from backend/config/profileSchema.js
const SECTION_LABELS = {
  basic_information: 'Basic Information (name, age, contact)',
  demographics: 'Demographics (race, ethnicity, gender)',
  financial_information: 'Financial (income, household size, poverty level)',
  health_medical: 'Health & Medical (conditions, disabilities, medications)',
  medical_insurance: 'Medical Insurance (provider, plan, coverage)',
  medical_history: 'Medical History (conditions, mobility, DME needs)',
  education: 'Education (level, GPA, field of study)',
  employment: 'Employment (status, employer, occupation)',
  occupation: 'Occupation & Skills (certifications, specializations)',
  military_service: 'Military / Veteran Status',
  family_life: 'Family Life (dependents, marital status, caregiving)',
  family: 'Family & Household (household size, children)',
  housing: 'Housing (type, cost, assistance)',
  government_assistance: 'Government Assistance (SNAP, SSI, Medicaid, etc.)',
  organization_details: 'Organization Details (nonprofit, church, school)',
  nonprofit_compliance: 'Nonprofit Compliance (audits, registrations)',
  small_business_details: 'Small Business Details',
  location_focus: 'Location & Service Area',
  university_applications: 'University Applications (targets, deadlines)',
  programs_services: 'Programs & Services',
  narrative: 'Narrative (personal statement, goals)',
  comprehensive_application: 'Comprehensive Application Data',
}

// Which missing sections unlock the most matches, by profile type
const HIGH_IMPACT_SECTIONS = {
  individual: ['financial_information', 'health_medical', 'government_assistance', 'housing', 'demographics'],
  student: ['education', 'financial_information', 'demographics', 'basic_information'],
  nonprofit: ['organization_details', 'financial_information', 'location_focus'],
  small_business: ['small_business_details', 'financial_information', 'location_focus'],
  business: ['small_business_details', 'financial_information', 'location_focus'],
  church: ['organization_details', 'location_focus', 'programs_services'],
  ministry: ['organization_details', 'location_focus', 'programs_services'],
  school: ['organization_details', 'education', 'location_focus'],
  veteran: ['military_service', 'health_medical', 'financial_information', 'government_assistance'],
  family: ['family_life', 'financial_information', 'health_medical', 'government_assistance'],
}

/**
 * Build a complete context snapshot for Anya's system prompt.
 *
 * @param {object} db
 * @param {object} user
 * @param {{ profileId?: string, currentPage?: string, pageContext?: object }} opts
 * @returns {Promise<string>} Formatted context block for the system prompt
 */
export async function buildAnyaContext(db, user, opts = {}) {
  const { profileId, currentPage, pageContext } = opts
  const sections = []

  // Load profile data once and share across sub-builders
  let profileContext = null
  if (db && profileId) {
    try {
      const baseContext = await loadProfileContext(db, profileId)
      if (baseContext?.profile) {
        profileContext = buildProfileFacets(baseContext)
      }
    } catch (e) {
      console.warn('[AnyaContext] Profile load failed:', e?.message)
    }
  }

  // ── 1. Profile snapshot ──
  const profileBlock = buildProfileSnapshot(profileContext)
  if (profileBlock) sections.push(profileBlock)

  // ── 1b. What Anya remembers about THIS profile (cross-session, profile-scoped
  // brain memory) — lets her be personable and pick up where they left off. ──
  const memoryBlock = await buildProfileMemoryBlock(db, profileId)
  if (memoryBlock) sections.push(memoryBlock)

  // ── 2. Available results / matching snapshot ──
  const resultsBlock = await buildResultsSnapshot(db, profileContext)
  if (resultsBlock) sections.push(resultsBlock)

  // ── 3. Pipeline status ──
  const pipelineBlock = await buildPipelineSnapshot(db, profileId)
  if (pipelineBlock) sections.push(pipelineBlock)

  // ── 3b. Recent submission warnings (partial-failure surfacing) ──
  const submissionWarningsBlock = await buildSubmissionWarningsSnapshot(db, profileId)
  if (submissionWarningsBlock) sections.push(submissionWarningsBlock)

  // ── 4. Page-specific context ──
  const pageBlock = buildPageContext(currentPage, pageContext)
  if (pageBlock) sections.push(pageBlock)

  // ── 5. Missing data detection + suggestions ──
  const gapsBlock = buildProfileGaps(profileContext)
  if (gapsBlock) sections.push(gapsBlock)

  // ── 6. Housing funding guidance (students / individuals needing off-campus help) ──
  const housingBlock = buildHousingGuidance(profileContext, db, profileId)
  if (housingBlock) sections.push(housingBlock)

  if (!profileContext) {
    return [
      '## Live Context',
      'No profile is currently selected. Guide the user to select or create a profile first.',
      'Without a profile, Anya cannot provide personalized recommendations.',
      '',
      pageBlock || '',
    ].join('\n')
  }

  return ['## Live Context (grounded in real data — use this, not generic advice)', '', ...sections].join('\n')
}

/**
 * Profile-scoped brain memory — the things Anya has remembered about THIS
 * profile across sessions (preferences, context, personal notes). Loaded into
 * the prompt so she can be personable and continue naturally. Best-effort.
 */
async function buildProfileMemoryBlock(db, profileId) {
  if (!db || !profileId) return null
  let memories = []
  try {
    memories = await getMemories(db, { scope: 'profile', scopeId: String(profileId), limit: 25 })
  } catch {
    return null // table may not exist yet
  }
  if (!Array.isArray(memories) || memories.length === 0) return null
  const summarize = (content) => {
    if (content === null || content === undefined) return ''
    if (typeof content === 'string') return content.slice(0, 240)
    if (typeof content === 'object') {
      const v = content.text ?? content.value ?? content.note ?? content.summary
      if (typeof v === 'string') return v.slice(0, 240)
      try { return JSON.stringify(content).slice(0, 240) } catch { return '' }
    }
    return String(content).slice(0, 240)
  }
  const lines = ['### What I remember about this profile']
  for (const m of memories) {
    const key = String(m.memory_key || m.memory_type || 'note').replace(/_/g, ' ')
    const text = summarize(m.content)
    if (text) lines.push(`- **${key}:** ${text}`)
  }
  lines.push('')
  return lines.length > 2 ? lines.join('\n') : null
}

/**
 * Build profile completeness and key facts snapshot.
 */
function buildProfileSnapshot(profileContext) {
  if (!profileContext?.profile) return null

  try {
    const profile = profileContext.profile
    const sectionData = profileContext?.sectionsByKey || profileContext?.sections || {}
    const signals = profileContext?.signals || {}

    const lines = ['### User Profile Snapshot']

    // Identity
    const name = profile.display_name || profile.full_name || '(unnamed)'
    const type = profile.applicant_type || profile.primary_type || 'individual'
    lines.push(`- **Name:** ${name}`)
    lines.push(`- **Profile type:** ${type}`)

    // Location
    const loc = signals?.location || {}
    const state = loc.state || profile.state || null
    const city = loc.city || profile.city || null
    const zip = loc.zip || profile.postal_code || profile.zip_code || null
    if (state || city || zip) {
      lines.push(`- **Location:** ${[city, state, zip].filter(Boolean).join(', ')}`)
    } else {
      lines.push('- **Location:** Not set (this limits geographic matching)')
    }

    // Key attributes
    const attrs = []
    if (signals.military instanceof Set && signals.military.has('veteran')) attrs.push('veteran')
    if (signals.health instanceof Set && signals.health.size > 0) attrs.push(`health conditions: ${[...signals.health].slice(0, 3).join(', ')}`)
    if (signals.demographic instanceof Set && signals.demographic.size > 0) attrs.push(`demographics: ${[...signals.demographic].slice(0, 3).join(', ')}`)
    if (signals.financial?.householdIncome) attrs.push(`income: $${signals.financial.householdIncome}`)
    if (signals.education?.level) attrs.push(`education: ${signals.education.level}`)
    if (attrs.length > 0) {
      lines.push(`- **Key attributes:** ${attrs.join(' | ')}`)
    }

    // Needs
    const needs = signals.needs instanceof Set ? [...signals.needs] : []
    if (needs.length > 0) {
      lines.push(`- **Detected needs:** ${needs.slice(0, 8).join(', ')}`)
    }

    // Section completeness
    const filled = Object.keys(sectionData).filter((k) => {
      const val = sectionData[k]
      if (!val || typeof val !== 'object') return false
      return Object.values(val).some((v) => v !== null && v !== undefined && v !== '')
    })
    const total = Object.keys(SECTION_LABELS).length
    const pct = Math.round((filled.length / total) * 100)
    lines.push(`- **Profile completeness:** ${filled.length}/${total} sections (${pct}%)`)
    lines.push(`- **Filled sections:** ${filled.map((k) => k.replace(/_/g, ' ')).join(', ') || '(none)'}`)

    lines.push('')
    return lines.join('\n')
  } catch (e) {
    console.warn('[AnyaContext] Profile snapshot failed:', e?.message)
    return null
  }
}

/**
 * Build a snapshot of matching results (top opportunities + why they matched).
 */
async function buildResultsSnapshot(db, profileContext) {
  if (!db || !profileContext?.profile) return null

  try {
    const profile = profileContext.profile
    const profileState = profileContext?.signals?.location?.state || profile?.state

    // Fetch a sample of active opportunities
    const isPostgres = db?.dialect === 'postgres'
    const activeVal = isPostgres ? 'TRUE' : '1'
    const stateClause = profileState
      ? `AND (state = ? OR state IS NULL OR state = 'nationwide')`
      : ''
    const params = profileState ? [profileState] : []

    const rows = await db
      .prepare(
        `SELECT * FROM funding_opportunities
         WHERE is_active = ${activeVal}
           AND ${trustedSourceClause()}
           AND ${trustedOriginClause()}
           ${stateClause}
         ORDER BY updated_at DESC
         LIMIT 100`,
      )
      .all(...params)

    if (!rows || rows.length === 0) {
      return [
        '### Available Results',
        '- **No opportunities found** in the database for this profile\'s geographic area.',
        '- Suggest the user: check if crawlers have been run, or try the Discover Grants page.',
        '',
      ].join('\n')
    }

    // Score the top candidates and attach canonical trust assessments so
    // Anya can explain *why* a result is lower-trust or directory-only.
    // Anya MUST explain only what the canonical matcher would actually
    // accept or send for review. Use computeMatchDecision (the same path
    // Discover and the pipeline use) rather than raw scoreOpportunity().
    const rawProfileForDecision = profileContext?.profile ?? profileContext
    const profileSectionsForDecision = profileContext?.sections ?? null
    const signalsForDecision = profileContext?.signals ?? null

    const scored = rows.map((opp) => {
      const decision = computeMatchDecision(rawProfileForDecision, opp, {
        profileSections: profileSectionsForDecision,
        signals: signalsForDecision,
      })
      const trust = assessOpportunityTrust(opp, { allowDirectory: true, allowExpired: false })
      return { opp, trust, ...decision }
    })
    // Drop items the canonical trust layer would never display AND items the
    // canonical decision engine rejected — Anya must not reference dead,
    // placeholder, or ineligible opportunities.
    const displayable = scored.filter((s) =>
      s.trust?.display !== false && s.decision !== 'REJECT'
    )
    displayable.sort((a, b) => b.score - a.score)

    const top5 = displayable.slice(0, 5)
    const totalAbove50 = displayable.filter((s) => s.score >= 50).length
    const totalAbove30 = displayable.filter((s) => s.score >= 30).length
    const droppedByTrust = scored.length - displayable.length

    const lines = ['### Available Results (from real matching)']
    lines.push(
      `- **${displayable.length}** displayable of **${rows.length}** opportunities evaluated ` +
      `(**${totalAbove50}** strong ≥50, **${totalAbove30}** moderate+ ≥30` +
      (droppedByTrust > 0 ? `, **${droppedByTrust}** dropped by trust layer` : '') +
      `)`,
    )
    lines.push('')
    lines.push('**Top 5 matches (explain these to the user when asked about results):**')

    for (const item of top5) {
      const opp = item.opp
      const title = (opp.title || opp.program_name || '').substring(0, 60)
      const reasons = (item.reasons || []).slice(0, 3).join('; ')
      const state = opp.state || (opp.is_national ? 'National' : 'Unknown')
      const tt = item.trust?.trustTier || 'unknown'
      const flags = []
      if (item.trust?.flags?.directory) flags.push('directory')
      if (item.trust?.flags?.expired) flags.push('expired')
      if (item.trust?.flags?.loan) flags.push('loan')
      if (item.trust?.downgrade) flags.push('downgraded')
      const flagStr = flags.length ? ` [${flags.join(',')}]` : ''
      lines.push(`  ${item.score}pts — "${title}" (${state}) [trust:${tt}]${flagStr} — ${reasons}`)
    }

    // Why these results appear
    lines.push('')
    lines.push('**When explaining results, reference:**')
    if (profileState) lines.push(`  - Geographic match: user is in ${profileState}`)
    const needs = profileContext?.signals?.needs instanceof Set ? [...profileContext.signals.needs] : []
    if (needs.length > 0) lines.push(`  - Need alignment: ${needs.slice(0, 5).join(', ')}`)
    const kws = profileContext?.signals?.keywordSet instanceof Set ? [...profileContext.signals.keywordSet].slice(0, 8) : []
    if (kws.length > 0) lines.push(`  - Profile keywords: ${kws.join(', ')}`)

    lines.push('')
    lines.push('**Trust vocabulary (use these exact meanings when the user asks "is this legit?"):**')
    lines.push('- `trust:trusted` = official or verified source with a real URL — highest confidence.')
    lines.push('- `trust:standard` = directory or community source that passed display checks — useful, but verify details before applying.')
    lines.push('- `trust:low` = lower-trust or partially unverified — tell the user to double-check before applying.')
    lines.push('- `source_trust:official|verified|directory|community|unknown` explains why the source received its trust tier.')
    lines.push('- `[directory]` = this is a directory/referral resource, not a direct funder. Suggest the user browse it to find specific programs.')
    lines.push('- `[loan]` = this is a loan, not a grant. Mention that repayment is required.')
    lines.push('- `[expired]` = the posted deadline has passed. Suggest watching for the next cycle.')
    lines.push('- `[downgraded]` = the source tier was lowered at runtime (e.g., link marked broken). Suggest verifying before applying.')
    return lines.join('\n')
  } catch (e) {
    console.warn('[AnyaContext] Results snapshot failed:', e?.message)
    return null
  }
}

/**
 * Build pipeline status (saved grants, applications in progress).
 */
async function buildPipelineSnapshot(db, profileId) {
  if (!db || !profileId) return null

  try {
    const rows = await db
      .prepare(
        `SELECT g.status, COUNT(*) as cnt
         FROM grants g
         WHERE g.profile_id = ?
         GROUP BY g.status`,
      )
      .all(profileId)

    if (!rows || rows.length === 0) return null

    const statusMap = {}
    for (const r of rows) {
      statusMap[r.status || 'unknown'] = Number(r.cnt || 0)
    }

    const total = Object.values(statusMap).reduce((a, b) => a + b, 0)
    if (total === 0) return null

    const lines = ['### Pipeline Status']
    lines.push(`- **${total}** grants in pipeline`)
    for (const [status, count] of Object.entries(statusMap)) {
      lines.push(`  - ${status}: ${count}`)
    }

    // Check for upcoming deadlines
    const isPostgres = db?.dialect === 'postgres'
    try {
      const deadlineQuery = isPostgres
        ? `SELECT g.id, fo.title, fo.deadline
           FROM grants g
           JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
           WHERE g.profile_id = ?
             AND fo.deadline IS NOT NULL
             AND fo.deadline >= CURRENT_DATE
             AND fo.deadline <= CURRENT_DATE + INTERVAL '14 days'
           ORDER BY fo.deadline ASC
           LIMIT 3`
        : `SELECT g.id, fo.title, fo.deadline
           FROM grants g
           JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
           WHERE g.profile_id = ?
             AND fo.deadline IS NOT NULL
             AND fo.deadline >= date('now')
             AND fo.deadline <= date('now', '+14 days')
           ORDER BY fo.deadline ASC
           LIMIT 3`
      const upcoming = await db
        .prepare(deadlineQuery)
        .all(profileId)

      if (upcoming && upcoming.length > 0) {
        const valid = upcoming.filter((d) => d.title && d.deadline)
        if (valid.length > 0) {
          lines.push('')
          lines.push('**Upcoming deadlines (mention these proactively):**')
          for (const d of valid) {
            lines.push(`  - "${d.title.substring(0, 50)}" — deadline: ${d.deadline}`)
          }
        }
      }
    } catch {
      // Deadline query may fail if grants table doesn't join properly
    }

    lines.push('')
    return lines.join('\n')
  } catch {
    return null
  }
}

/**
 * Pull the most recent submission-related warnings off applications.snapshot_json
 * (see applyEngine.markSubmitted). Surfaces partial-failure context so Anya
 * can tell the user, in plain language, what actually happened after submit.
 */
async function buildSubmissionWarningsSnapshot(db, profileId) {
  if (!db || !profileId) return null
  try {
    const rows = await db
      .prepare(
        `SELECT a.id, a.status, a.submission_method, a.submitted_at, a.snapshot_json, g.title
         FROM applications a
         LEFT JOIN grants g ON g.id = a.grant_id
         WHERE a.status = 'submitted' AND g.profile_id = ?
         ORDER BY a.submitted_at DESC
         LIMIT 10`,
      )
      .all(String(profileId))
    if (!rows || rows.length === 0) return null

    const items = []
    for (const row of rows) {
      let parsed = null
      try {
        parsed = row.snapshot_json ? JSON.parse(row.snapshot_json) : null
      } catch {
        parsed = null
      }
      const warnings = parsed?.submitted?.warnings
      if (Array.isArray(warnings) && warnings.length > 0) {
        items.push({
          id: row.id,
          title: row.title || '(unknown grant)',
          submitted_at: row.submitted_at,
          method: row.submission_method,
          warnings,
        })
      }
    }
    if (items.length === 0) return null

    const lines = ['### Recent Submission Warnings']
    lines.push(
      `- **${items.length}** recent submission(s) recorded non-fatal issues. ` +
      'Anya MUST mention these if the user asks "did my submission go through?" or similar.',
    )
    lines.push('')
    for (const it of items.slice(0, 5)) {
      lines.push(`- **"${String(it.title).slice(0, 60)}"** (submitted ${it.submitted_at || 'recently'} via ${it.method || 'unknown'}):`)
      for (const w of it.warnings.slice(0, 3)) {
        const step = w?.step || 'unknown_step'
        const errMsg = w?.error ? ` — ${String(w.error).slice(0, 120)}` : ''
        lines.push(`  - partial failure at ${step}${errMsg}`)
      }
    }
    lines.push('')
    lines.push('When explaining: the application *was* submitted, but a side-effect (status mirror, milestone, etc.) did not succeed. Suggest the user re-check the pipeline status or retry the affected step.')
    lines.push('')
    return lines.join('\n')
  } catch (e) {
    console.warn('[AnyaContext] Submission warnings snapshot failed:', e?.message)
    return null
  }
}

/**
 * Build enhanced page-specific context with actionable guidance.
 */
function buildPageContext(currentPage, pageContext) {
  const page = currentPage || 'Unknown'
  const lines = ['### Current Page Context']
  lines.push(`- **Page:** ${page}`)

  // Map pages to specific, actionable guidance
  const guidance = {
    Dashboard: [
      'The user sees their overview dashboard with pipeline stats and recent activity.',
      'SUGGEST: review top matches, check upcoming deadlines, or fill missing profile sections.',
      'If pipeline is empty, suggest going to Discover Grants.',
    ],
    DiscoverGrants: [
      'The user is browsing funding opportunities matched to their profile.',
      'EXPLAIN: why each result appears (reference score, geographic match, need alignment from the Results section above).',
      'SUGGEST: click a grant for details, save promising ones to pipeline, or improve profile for better matches.',
      'If results are few, suggest filling more profile sections to improve matching.',
    ],
    Pipeline: [
      'The user is viewing their saved grants and application progress.',
      'EXPLAIN: what each status means (discovered → interested → drafting → application_prep → submitted).',
      'SUGGEST: advance the next pipeline item, prepare application documents, or check deadlines.',
      'Mention upcoming deadlines from the Pipeline Status section above.',
    ],
    Proposals: [
      'The user is working on grant proposals/applications.',
      'SUGGEST: use Anya to draft needs statements, LOIs, or full applications.',
      'Reference their profile data to write compelling narratives.',
    ],
    Profile: [
      'The user is viewing/editing their profile.',
      'EXPLAIN: which sections are most impactful for their profile type (reference the Profile Gaps section below).',
      'SUGGEST: fill the highest-impact missing sections first.',
      'After they add data, mention that their matches will improve.',
    ],
    Settings: [
      'The user is managing account settings.',
      'Help with notification preferences or account management.',
    ],
  }

  const pageLines = guidance[page] || ['Provide contextual help based on what the user asks.']
  for (const line of pageLines) {
    lines.push(`- ${line}`)
  }

  // Include frontend-pushed page context if available
  if (pageContext) {
    if ((pageContext.resultCount !== null && pageContext.resultCount !== undefined)) {
      lines.push(`- **Results visible on screen:** ${pageContext.resultCount}`)
    }
    if (pageContext.selectedGrant) {
      lines.push(`- **Selected grant:** ${pageContext.selectedGrant}`)
    }
    if ((pageContext.pipelineCount !== null && pageContext.pipelineCount !== undefined)) {
      lines.push(`- **Pipeline items:** ${pageContext.pipelineCount}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Detect missing profile data and suggest what to fill next.
 */
function buildProfileGaps(profileContext) {
  if (!profileContext?.profile) return null

  try {
    const profile = profileContext.profile
    const sectionData = profileContext.sectionsByKey || profileContext.sections || {}
    const type = (profile.applicant_type || profile.primary_type || 'individual').toLowerCase()

    // Find empty sections
    const emptySections = []
    for (const [key, label] of Object.entries(SECTION_LABELS)) {
      const val = sectionData[key]
      const isEmpty = !val || typeof val !== 'object' || Object.values(val).every((v) => v === null || v === undefined || v === '')
      if (isEmpty) emptySections.push(key)
    }

    if (emptySections.length === 0) return null

    // Prioritize by impact for this profile type
    const impactOrder = HIGH_IMPACT_SECTIONS[type] || HIGH_IMPACT_SECTIONS.individual
    const prioritized = []
    for (const key of impactOrder) {
      if (emptySections.includes(key)) {
        prioritized.push(key)
      }
    }
    // Add remaining empties
    for (const key of emptySections) {
      if (!prioritized.includes(key)) prioritized.push(key)
    }

    const top3 = prioritized.slice(0, 3)

    const lines = ['### Missing Profile Data (prompt the user about these)']
    lines.push(`- **${emptySections.length}** sections are empty`)
    lines.push('')
    lines.push('**Highest-impact missing sections (suggest these first):**')

    const impactExplanations = {
      financial_information: 'Unlocks need-based grants, poverty-level programs, and income-qualified assistance',
      health_medical: 'Unlocks patient assistance, disability programs, and medical-specific grants',
      medical_insurance: 'Improves insurance-linked program eligibility (Medicaid waivers, marketplace subsidies)',
      medical_history: 'Unlocks condition-specific programs and DME/mobility assistance',
      education: 'Unlocks scholarships, Pell Grants, and education-specific funding',
      government_assistance: 'Unlocks complementary programs (e.g., SNAP recipients qualify for LIHEAP)',
      military_service: 'Unlocks VA benefits, veteran-specific grants, and military family programs',
      organization_details: 'Required for nonprofit, church, and school grant eligibility',
      nonprofit_compliance: 'Required for federal grants (SAM.gov, audits, NICRA rates)',
      small_business_details: 'Required for SBA grants, SBIR/STTR, and business programs',
      housing: 'Unlocks rental assistance, emergency housing, and Section 8 programs',
      demographics: 'Unlocks minority-focused grants, women-owned business programs, and tribal funding',
      family_life: 'Unlocks family support programs, single-parent assistance, and dependent care',
      family: 'Unlocks household-size-based eligibility and children-focused programs',
      location_focus: 'Improves geographic matching — ensures local and state opportunities are found',
      occupation: 'Improves workforce training, certification, and career program matches',
      programs_services: 'Documents org services for funder alignment',
      narrative: 'Strengthens application narratives and demonstrates mission fit',
    }

    top3.forEach((key, i) => {
      const label = SECTION_LABELS[key] || key.replace(/_/g, ' ')
      const why = impactExplanations[key] || 'Improves match quality'
      lines.push(`  ${i + 1}. **${label}** — ${why}`)
    })

    lines.push('')
    lines.push('IMPORTANT: When suggesting profile improvements, be specific about WHAT data to add and WHY it helps.')
    lines.push('Do NOT just say "fill out your profile" — name the exact section and the funding it unlocks.')
    lines.push('')
    return lines.join('\n')
  } catch (e) {
    console.warn('[AnyaContext] Profile gaps failed:', e?.message)
    return null
  }
}

/**
 * Build housing funding guidance context for student/individual profiles.
 * Explains HOW funding can be used for off-campus living expenses.
 * Suggests actionable next steps: COA adjustment, RA programs, stackable awards.
 */
function buildHousingGuidance(profileContext, _db, _profileId) {
  if (!profileContext?.profile) return null

  try {
    const profile = profileContext.profile
    const type = (profile.applicant_type || profile.primary_type || 'individual').toLowerCase()

    // Only relevant for students and individuals
    if (!['student', 'individual', 'individual_need', 'family'].some((t) => type.includes(t))) {
      return null
    }

    const sectionData = profileContext?.sectionsByKey || profileContext?.sections || {}
    const eduSection = sectionData?.education ?? sectionData?.education_information ?? null
    const eduAnswers = eduSection?.answers ?? eduSection ?? {}
    const gpa = Number(eduAnswers?.gpa ?? 0)
    const state = (profileContext?.signals?.location?.state || profile.state || '').toUpperCase()
    const isStudent = type.includes('student') || Boolean(eduAnswers?.is_student) ||
      Boolean(eduAnswers?.currently_enrolled) || Boolean(eduAnswers?.school_name)

    if (!isStudent) return null

    const lines = ['### Housing Funding Guidance']
    lines.push('The following information helps Anya explain how funding can cover off-campus living expenses.')
    lines.push('')

    lines.push('**How scholarships and grants can pay for off-campus housing:**')
    lines.push('- **Refund-eligible awards:** When a scholarship covers more than tuition + fees, the college refunds the excess directly to the student — usually within 2 weeks of semester start. Students use these refunds for rent, utilities, and groceries.')
    lines.push('- **Stipends:** Some programs pay the student directly (monthly or per semester) with no restrictions. The full amount can go toward housing.')
    lines.push('- **COA Adjustments:** Students can appeal to their financial aid office to increase the official Cost of Attendance to reflect real off-campus housing costs, unlocking more grant/work-study eligibility.')
    lines.push('- **RA (Resident Assistant) positions:** Students who become RAs receive free or heavily discounted campus housing in exchange for community management duties — freeing cash for other expenses.')
    lines.push('')

    lines.push('**Actionable next steps Anya should suggest:**')
    lines.push('1. "Request a COA (Cost of Attendance) adjustment from your financial aid office — bring documentation of your actual rent and utility costs."')
    lines.push('2. "Apply for an RA (Resident Assistant) position at your campus — it provides free housing and a stipend."')
    lines.push('3. "Stack the Federal Pell Grant on top of your state scholarship — the combined refund can cover off-campus rent."')

    if (state === 'TN') {
      lines.push('')
      lines.push('**Tennessee-specific housing funding (profile is in TN):**')
      lines.push('- **Tennessee HOPE Scholarship:** Merit scholarship (3.0+ GPA) that generates a refund check for COA expenses. Direct the user to: https://www.tn.gov/collegepays')
      lines.push('- **HOPE Access Grant:** Supplement for low-income HOPE recipients; refund applies to housing costs.')
      lines.push('- **TSAC Programs:** Tennessee Student Assistance Corporation manages all state aid. Visit: https://www.tn.gov/collegepays/money-for-college')
      if (gpa >= 3.0) {
        lines.push(`- **Profile GPA: ${gpa}** — Qualifies for Tennessee HOPE Scholarship (requires 3.0+).`)
      }
    }

    lines.push('')
    lines.push('**When a user asks "can I use this for rent?" Anya should:**')
    lines.push('- Check the funding_category field: refund_eligible, stipend, or housing_direct all mean YES.')
    lines.push('- Explain the mechanism: "This scholarship pays directly to your school. If it exceeds your tuition, the school refunds the balance to you — you can use that refund for rent, utilities, and food."')
    lines.push('- Suggest stacking: "You can combine this with Federal Work-Study earnings, which are paid directly to you as a paycheck and can go toward housing."')
    lines.push('')
    lines.push('IMPORTANT: Always tell the user HOW the money reaches them, not just that they qualify.')

    lines.push('')
    return lines.join('\n')
  } catch (e) {
    console.warn('[AnyaContext] Housing guidance failed:', e?.message)
    return null
  }
}

export default { buildAnyaContext }
