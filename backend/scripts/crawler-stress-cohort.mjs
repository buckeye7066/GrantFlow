/**
 * crawler-stress-cohort.mjs — owner-directed crawler stress-test cohort.
 *
 * Creates 10 PERSISTENT synthetic personas engineered to stress under-covered
 * crawler lanes (tribal business, foster-youth ETV, Puerto Rico geo, dislocated
 * worker + dementia caregiver, reentry entrepreneur, disability self-employment,
 * kinship grandfamilies, Appalachian recovery workforce, refugee student minor,
 * Black beginning farmer / heirs' property), runs live Crawler OS discovery on
 * them, and rebuilds the fleet gap scoreboard so Amy / Sam / Anya see the gaps.
 *
 * DELIBERATE PROVENANCE CHOICE: rows carry created_by 'crawler-stress-test',
 * NOT 'agent:amy' —
 *   - Amy's reaper (cleanupAmyProfiles/enforceAmySyntheticExpiry) only ever
 *     deletes 'agent:amy' rows, so this cohort PERSISTS until purged here.
 *   - coverageGapScoreboard.loadActiveProfileRows only excludes 'agent:amy'
 *     rows, so this cohort's gaps DO feed the fleet scoreboard → Amy's
 *     gap-weighted training, Sam's coverage.gapScoreboard check, and Anya's
 *     morning "Coverage gaps" section.
 * They are still clearly synthetic: tagged + stress_cohort_metadata section +
 * "SYNTHETIC" notes; emails are owner plus-addresses; phones are 555-01xx.
 *
 * In-container usage (Railway: railway ssh "node backend/scripts/crawler-stress-cohort.mjs ..."):
 *   --create               create/refresh the 10 personas (idempotent upsert)
 *   --discover             run Crawler OS live discovery per cohort profile
 *   --report               matches + pipeline + coverage-evidence gap report
 *   --scoreboard           rebuild + print the fleet gap scoreboard
 *   --purge --yes          hard-delete the cohort (created_by-scoped)
 *   --only=<slug>          restrict --discover/--report to one persona
 * Modes compose: --create --discover --report --scoreboard runs the full pass.
 */

import { randomUUID } from 'node:crypto'
import { getDb } from '../db/index.js'
import { supportedSectionKeys, getDefaultSectionData } from '../config/profileSchema.js'
import { runProfileDiscoveryLive } from '../services/crawlerOsService.js'
import { buildCoverageEvidence } from '../services/coverageEvidenceService.js'
import { buildFleetGapScoreboard, readGapScoreboard } from '../services/coverageGapScoreboard.js'

const CREATED_BY = 'crawler-stress-test'
const COHORT_ID = 'crawler-stress-2026-07'
const METADATA_SECTION_KEY = 'stress_cohort_metadata'
const SECTION_WRITER = 'crawler-stress-cohort'
const TAGS = ['synthetic', 'crawler_stress_cohort', 'test_cohort']
const SYNTHETIC_NOTE =
  'SYNTHETIC crawler stress-test persona (owner-directed cohort 2026-07-12). Not a real person or organization. Persistent test cohort — purge only via crawler-stress-cohort.mjs --purge.'

/**
 * The 10 personas. Sections use ONLY schema-accurate structured fields
 * (backend/config/profileSchema.js) — narrative/prose is drafting-only and
 * unscored, so eligibility is expressed through flags, enums, and the
 * controlled focus-tag vocabulary (backend/constants/needCategories.js ids).
 */
const COHORT = [
  {
    slug: 'aiyana-begay',
    display_name: 'Aiyana Begay (Stress Cohort)',
    primary_type: 'small_business',
    expected: 'tribal/Native-owned business, women entrepreneurs, rural broadband (ReConnect/BEAD), artisan funding, Navajo Nation programs',
    sections: {
      basic_information: {
        age: 34, gender: 'female', city: 'Window Rock', state: 'AZ', zip: '86515',
        location: { city: 'Window Rock', state: 'AZ', county: 'Apache County', zip_code: '86515' },
      },
      organization_details: { organization_type: 'small business', is_rural_serving: true, broadband_unserved: true },
      small_business_details: { business_name: 'Begay Weaving Studio', years_in_business: 3, employee_count: 1, annual_revenue: 28000 },
      occupation: { small_business_owner: true, minority_owned_business: true, women_owned_business: true },
      demographics: { native_american: true, tribal_affiliation: 'Navajo Nation' },
      family_life: { single_parent: true },
      location_focus: { rural_resident: true, geographic_focus: 'Window Rock, AZ (Navajo Nation)' },
      financial_information: { low_income: true, financial_need_level: 'high', household_size: 3, funding_needs: '$5,000–$50,000' },
      programs_services: {
        focus_areas: ['business', 'tribal', 'technology_equipment'],
        interests: ['women', 'rural', 'minority'],
        keywords: ['Native American business grant', 'artisan', 'broadband', 'e-commerce', 'tribal enterprise'],
      },
      narrative: {
        mission: 'Navajo single mother selling traditional woven goods.',
        primary_goal: 'Equipment, reliable internet access, and an online store for a Native artisan business.',
        funding_amount_needed: '$25,000',
      },
    },
  },
  {
    slug: 'isaiah-brooks',
    display_name: 'Isaiah Brooks (Stress Cohort)',
    primary_type: 'college_student',
    expected: 'former-foster-youth scholarships/ETV (Chafee), emergency housing, trade-school and welding tool grants, transportation',
    sections: {
      basic_information: {
        age: 19, gender: 'male', city: 'Detroit', state: 'MI', zip: '48201',
        location: { city: 'Detroit', state: 'MI', county: 'Wayne County', zip_code: '48201' },
      },
      education: {
        highest_level: 'undergraduate (in progress)', current_institution: 'Wayne County Community College District',
        intended_major: 'Welding Technology', cte_pathway: 'Welding', gpa: 3.1,
        pell_grant_eligible: true, fafsa_completed: true, first_generation_college_student: true,
      },
      family_life: { foster_youth: true, homeless: true },
      housing: { status: 'at_risk', type: 'temporary' },
      financial_information: { low_income: true, financial_need_level: 'urgent', household_income: 14000, household_size: 1 },
      employment: { current_status: 'employed_part_time' },
      programs_services: {
        focus_areas: ['education', 'housing', 'employment'],
        interests: ['children_youth', 'transportation'],
        keywords: ['foster youth scholarship', 'education and training voucher', 'ETV', 'trade school', 'welding certification'],
      },
      narrative: {
        mission: 'Former foster youth pursuing a welding credential.',
        primary_goal: 'Tuition, emergency housing, tools, and transportation while completing community college.',
      },
    },
  },
  {
    slug: 'marisol-vega',
    display_name: 'Marisol Vega (Stress Cohort)',
    primary_type: 'small_business',
    expected: 'Puerto Rico/territorial eligibility, disaster recovery, childcare stabilization (CCDF), generators/resilience, Spanish-language programs',
    sections: {
      basic_information: {
        age: 47, gender: 'female', city: 'Ponce', state: 'PR', zip: '00730',
        location: { city: 'Ponce', state: 'PR', county: 'Ponce Municipio', zip_code: '00730' },
      },
      organization_details: { organization_type: 'childcare center', in_fema_disaster_area: true },
      small_business_details: { business_name: 'Centro Infantil Sol y Mar', years_in_business: 12, employee_count: 6, annual_revenue: 180000 },
      occupation: { small_business_owner: true, women_owned_business: true },
      demographics: { hispanic_latino: true },
      family_life: { disaster_survivor: true },
      financial_information: { financial_need_level: 'high', funding_needs: '$15,000–$100,000' },
      programs_services: {
        focus_areas: ['business', 'emergency', 'family_life'],
        interests: ['children_youth', 'community_development'],
        keywords: ['hurricane recovery', 'childcare stabilization', 'CCDF', 'Puerto Rico', 'backup generator'],
      },
      narrative: {
        mission: 'Childcare-center owner in Ponce rebuilding after hurricane damage.',
        primary_goal: 'Building repairs, a backup generator, and stabilization funding to keep serving low-income families.',
        funding_amount_needed: '$60,000',
      },
    },
  },
  {
    slug: 'david-kim',
    display_name: 'David Kim (Stress Cohort)',
    primary_type: 'individual',
    expected: 'dislocated-worker/WIOA retraining, family-caregiver + dementia support (alzheimers lane), short-term credential funding, multilingual resources',
    sections: {
      basic_information: {
        age: 52, gender: 'male', city: 'Fort Lee', state: 'NJ', zip: '07024',
        location: { city: 'Fort Lee', state: 'NJ', county: 'Bergen County', zip_code: '07024' },
      },
      financial_information: { displaced_worker: true, unemployed: 'unemployed_seeking', financial_need_level: 'moderate', household_size: 2 },
      employment: { current_status: 'unemployed_seeking', career_goal: 'Retrain and certify in medical coding after a layoff.' },
      family_life: { caregiver: true },
      family: { household_size: 2, responsibilities: 'Full-time caregiver for his mother, who has dementia.' },
      demographics: { asian_american: true, immigrant_status: 'us_citizen' },
      education: { highest_level: "bachelor's degree", intended_major: 'Medical Billing and Coding', cte_pathway: 'Healthcare' },
      programs_services: {
        focus_areas: ['employment', 'family_life', 'health_medical'],
        interests: ['education', 'senior'],
        keywords: ['dislocated worker', 'WIOA', 'medical coding certification', 'caregiver respite', 'dementia', 'Korean American'],
      },
      narrative: {
        mission: 'Laid-off worker and full-time dementia caregiver retraining for a healthcare career.',
        primary_goal: 'Retraining funds for medical coding plus caregiver respite support.',
      },
    },
  },
  {
    slug: 'tasha-reynolds',
    display_name: 'Tasha Reynolds (Stress Cohort)',
    primary_type: 'individual',
    expected: 'reentry/justice-impacted entrepreneur funding, women-owned microgrants, food-business incubators, licensing + vehicle/equipment help',
    sections: {
      basic_information: {
        age: 36, gender: 'female', city: 'Pine Bluff', state: 'AR', zip: '71601',
        location: { city: 'Pine Bluff', state: 'AR', county: 'Jefferson County', zip_code: '71601' },
      },
      family_life: { formerly_incarcerated: true },
      occupation: { small_business_owner: true, women_owned_business: true },
      financial_information: { low_income: true, financial_need_level: 'high', unemployed: 'self_employed' },
      employment: { current_status: 'self_employed', career_goal: 'Launch a licensed mobile catering business.' },
      programs_services: {
        focus_areas: ['business', 'employment', 'legal'],
        interests: ['women', 'transportation', 'cash_assistance'],
        keywords: ['reentry', 'second chance', 'justice-impacted entrepreneur', 'food business incubator', 'microgrant', 'catering license'],
      },
      narrative: {
        mission: 'Returning citizen building a mobile catering business two years after release.',
        primary_goal: 'Licensing, kitchen equipment, and a dependable vehicle to launch a catering business.',
        funding_amount_needed: '$20,000',
      },
    },
  },
  {
    slug: 'eli-morgan',
    display_name: 'Eli Morgan (Stress Cohort)',
    primary_type: 'disabled_adult',
    expected: 'vocational rehabilitation self-employment, disability-owned business, assistive technology, Alaska-specific resources, accessible home workspace',
    sections: {
      basic_information: {
        age: 28, gender: 'male', city: 'Anchorage', state: 'AK', zip: '99501',
        location: { city: 'Anchorage', state: 'AK', county: 'Anchorage Municipality', zip_code: '99501' },
      },
      health_medical: {
        hearing_impairment: true, neurodivergent: true,
        disability_type: ['deaf', 'autism'],
        support_needs: ['assistive technology', 'equipment'],
        support_needs_level: 'moderate',
      },
      government_assistance: { ssi_recipient_self: true },
      occupation: { small_business_owner: true },
      employment: { current_status: 'self_employed', career_goal: 'Grow a freelance graphic design practice into a full business.' },
      programs_services: {
        focus_areas: ['disability', 'business', 'technology_equipment'],
        interests: ['employment'],
        keywords: ['vocational rehabilitation', 'self-employment plan', 'assistive technology', 'deaf entrepreneur', 'accessible home office'],
      },
      narrative: {
        mission: 'Deaf, autistic graphic designer in Anchorage building self-employment.',
        primary_goal: 'Adaptive technology, business coaching, and an accessible home workspace.',
      },
    },
  },
  {
    slug: 'ruth-alvarez',
    display_name: 'Ruth Alvarez (Stress Cohort)',
    primary_type: 'senior',
    expected: 'kinship-care/grandfamilies support, senior home repair + weatherization + LIHEAP, county programs, after-school tutoring help',
    sections: {
      basic_information: {
        age: 73, gender: 'female', city: 'Las Cruces', state: 'NM', zip: '88001',
        location: { city: 'Las Cruces', state: 'NM', county: 'Doña Ana County', zip_code: '88001' },
      },
      family_life: { widow_widower: true, grandparent_raising_grandchildren: true },
      family: { household_size: 3, responsibilities: 'Raising two grandchildren on Social Security income.' },
      government_assistance: { medicare_recipient_self: true, snap_recipient_household: true },
      financial_information: { low_income: true, financial_need_level: 'high', household_income: 21000, household_size: 3 },
      housing: { status: 'at_risk', type: 'own' },
      demographics: { hispanic_latino: true },
      programs_services: {
        focus_areas: ['senior', 'housing', 'utilities', 'family_life'],
        interests: ['education', 'children_youth'],
        keywords: ['kinship care', 'grandfamilies', 'home repair', 'weatherization', 'LIHEAP', 'tutoring'],
      },
      narrative: {
        mission: 'Widowed grandmother raising two grandchildren on a fixed income.',
        primary_goal: 'Roof repair, utility/heating help, and after-school tutoring for a grandchild.',
      },
    },
  },
  {
    slug: 'caleb-hart',
    display_name: 'Caleb Hart (Stress Cohort)',
    primary_type: 'individual',
    expected: 'Appalachian redevelopment (ARC/POWER), displaced-miner workforce funding, recovery-friendly employment, HVAC training, transportation',
    sections: {
      basic_information: {
        age: 44, gender: 'male', city: 'Beckley', state: 'WV', zip: '25801',
        location: { city: 'Beckley', state: 'WV', county: 'Raleigh County', zip_code: '25801' },
      },
      financial_information: { displaced_worker: true, low_income: true, financial_need_level: 'high', unemployed: 'unemployed_seeking' },
      health_medical: { substance_recovery: true, support_needs: ['transportation'] },
      location_focus: { rural_resident: true, appalachian_region: true, geographic_focus: 'Raleigh County, WV' },
      demographics: { appalachian_heritage: true },
      education: { highest_level: 'high school diploma', cte_pathway: 'HVAC' },
      employment: { current_status: 'unemployed_seeking', career_goal: 'Earn HVAC certification after coal-industry layoff.' },
      programs_services: {
        focus_areas: ['employment', 'substance_recovery', 'transportation', 'rural'],
        interests: ['education'],
        keywords: ['displaced coal miner', 'Appalachian', 'POWER grant', 'recovery-friendly workplace', 'HVAC certification'],
      },
      narrative: {
        mission: 'Displaced coal miner in long-term recovery retraining for HVAC.',
        primary_goal: 'HVAC certification funding and transportation to the training center.',
      },
    },
  },
  {
    slug: 'noor-hassan',
    display_name: 'Noor Hassan (Stress Cohort)',
    primary_type: 'high_school_student',
    expected: 'refugee-student scholarships (ORR lane), programs for minors, STEM/biotech summer enrichment, laptop/technology access, local Lewiston scholarships',
    sections: {
      basic_information: {
        age: 17, gender: 'female', city: 'Lewiston', state: 'ME', zip: '04240',
        location: { city: 'Lewiston', state: 'ME', county: 'Androscoggin County', zip_code: '04240' },
      },
      demographics: { immigrant_status: 'refugee', african_american: true },
      education: {
        highest_level: 'high school (in progress)', current_institution: 'Lewiston High School',
        intended_major: 'Biotechnology', gpa: 3.9, first_generation_college_student: true,
      },
      financial_information: { low_income: true, financial_need_level: 'high' },
      programs_services: {
        focus_areas: ['education', 'immigrant_refugee', 'technology_equipment'],
        interests: ['research_arts', 'children_youth'],
        keywords: ['refugee student scholarship', 'STEM summer program', 'biotechnology', 'laptop grant', 'travel stipend'],
      },
      narrative: {
        mission: 'Somali refugee student excelling in science.',
        primary_goal: 'Tuition, travel, and a laptop for a summer biotechnology program.',
      },
    },
  },
  {
    slug: 'omar-reed',
    display_name: 'Omar Reed (Stress Cohort)',
    primary_type: 'individual',
    expected: 'beginning-farmer + socially disadvantaged farmer programs, heirs-property legal assistance, USDA conservation (EQIP), irrigation/equipment',
    sections: {
      basic_information: {
        age: 29, gender: 'male', city: 'Hayneville', state: 'AL', zip: '36040',
        location: { city: 'Hayneville', state: 'AL', county: 'Lowndes County', zip_code: '36040' },
      },
      occupation: { farmer: true, small_business_owner: true, minority_owned_business: true },
      demographics: { african_american: true },
      location_focus: { rural_resident: true, geographic_focus: 'Lowndes County, AL' },
      financial_information: { financial_need_level: 'moderate', funding_needs: '$10,000–$150,000' },
      employment: { current_status: 'self_employed', career_goal: 'Develop a regenerative vegetable farm on inherited land.' },
      programs_services: {
        focus_areas: ['agriculture', 'legal', 'rural', 'business'],
        interests: ['minority', 'environment'],
        keywords: ['beginning farmer', 'heirs property', 'regenerative agriculture', 'irrigation', 'EQIP', 'socially disadvantaged farmer'],
      },
      narrative: {
        mission: 'Beginning Black farmer developing 15 inherited acres of heirs’ property.',
        primary_goal: 'Legal assistance to clear title, irrigation, and startup equipment for a regenerative vegetable farm.',
      },
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (p) => {
  const a = args.find((x) => x.startsWith(`${p}=`))
  return a ? a.split('=').slice(1).join('=') : null
}

function personaEmail(slug) {
  return `buckeye7066+stress-${slug}@gmail.com`
}

async function upsertSection(db, profileId, sectionKey, data, nowIso) {
  await db
    .prepare(
      `INSERT INTO profile_sections (profile_id, section_key, data, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, section_key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(profileId, sectionKey, JSON.stringify(data), SECTION_WRITER, nowIso, nowIso)
}

async function findCohortProfiles(db) {
  const rows = await db
    .prepare(`SELECT id, display_name, primary_type, status, created_at FROM profiles WHERE created_by = ? ORDER BY display_name`)
    .all(CREATED_BY)
  return Array.isArray(rows) ? rows : []
}

function slugOfDisplayName(displayName) {
  const p = COHORT.find((c) => c.display_name === displayName)
  return p ? p.slug : null
}

async function createCohort(db) {
  const existing = await findCohortProfiles(db)
  const byName = new Map(existing.map((r) => [r.display_name, r.id]))
  const nowIso = new Date().toISOString()
  const created = []
  const refreshed = []

  for (let i = 0; i < COHORT.length; i++) {
    const persona = COHORT[i]
    let profileId = byName.get(persona.display_name)
    const isNew = !profileId
    if (isNew) {
      profileId = randomUUID()
      await db
        .prepare(
          `INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(profileId, persona.display_name, persona.primary_type, JSON.stringify(TAGS), CREATED_BY, nowIso, nowIso)
    }

    // Seed every supported section with schema defaults, overlay persona data.
    const overrides = persona.sections || {}
    for (const sectionKey of supportedSectionKeys) {
      const defaults = getDefaultSectionData(sectionKey) || {}
      const merged = overrides[sectionKey] ? { ...defaults, ...overrides[sectionKey] } : defaults
      if (sectionKey === 'basic_information') {
        merged.full_name = persona.display_name.replace(' (Stress Cohort)', '')
        merged.email = personaEmail(persona.slug)
        merged.phone = `555-01${String(51 + i).padStart(2, '0')}`
        merged.notes = SYNTHETIC_NOTE
      }
      await upsertSection(db, profileId, sectionKey, merged, nowIso)
    }

    // Cohort metadata contract: synthetic + traceable, but NOT Amy-reapable.
    await upsertSection(db, profileId, METADATA_SECTION_KEY, {
      synthetic: true,
      cohort: COHORT_ID,
      slug: persona.slug,
      allow_sam_cleanup: false,
      persistent: true,
      purpose: 'Owner-directed crawler stress test: force the crawlers/matchers to prove themselves on hard persona shapes; gaps feed Amy/Sam/Anya.',
      expected_coverage: persona.expected,
      created_at: nowIso,
    }, nowIso)

    ;(isNew ? created : refreshed).push(`${persona.slug}=${profileId}`)
    console.log(`[cohort] ${isNew ? 'created' : 'refreshed'} ${persona.slug} → ${profileId}`)
  }
  console.log(`[cohort] create done — created=${created.length} refreshed=${refreshed.length}`)
}

async function discoverCohort(db, only) {
  const rows = await findCohortProfiles(db)
  const targets = rows.filter((r) => !only || slugOfDisplayName(r.display_name) === only)
  console.log(`[cohort] discovery over ${targets.length} profile(s)`)
  let ok = 0
  let failed = 0
  for (const row of targets) {
    const slug = slugOfDisplayName(row.display_name) || row.id
    const t0 = Date.now()
    try {
      const { run, persisted } = await runProfileDiscoveryLive({ db, profileId: row.id })
      ok += 1
      console.log(
        `[cohort] ok ${slug}: stored=${run.stored} matches=${persisted.matches} recs=${run.recommendations?.length ?? 0} pruned=${persisted.pipelinePruned || 0} (${Math.round((Date.now() - t0) / 1000)}s)`,
      )
    } catch (err) {
      failed += 1
      console.error(`[cohort] FAIL ${slug}: ${err?.message || err}`)
    }
  }
  console.log(`[cohort] discovery done — ok=${ok} failed=${failed}`)
  return { ok, failed }
}

async function reportCohort(db, only) {
  const rows = await findCohortProfiles(db)
  const targets = rows.filter((r) => !only || slugOfDisplayName(r.display_name) === only)
  const summary = []
  for (const row of targets) {
    const slug = slugOfDisplayName(row.display_name) || row.id
    const persona = COHORT.find((c) => c.slug === slug)
    let matchCount = 0
    let top = []
    try {
      const m = await db
        .prepare(
          `SELECT m.match_score, m.match_decision, f.title, f.sponsor, f.source
           FROM profile_opportunity_matches m
           JOIN funding_opportunities f ON f.id = m.opportunity_id
           WHERE m.profile_id = ?
           ORDER BY m.match_score DESC
           LIMIT 10`,
        )
        .all(row.id)
      top = Array.isArray(m) ? m : []
      const c = await db.prepare(`SELECT COUNT(*) AS n FROM profile_opportunity_matches WHERE profile_id = ?`).get(row.id)
      matchCount = Number(c?.n || 0)
    } catch (err) {
      console.error(`[cohort] match read failed for ${slug}: ${err?.message}`)
    }
    let pipelineCount = 0
    try {
      const g = await db.prepare(`SELECT COUNT(*) AS n FROM grants WHERE profile_id = ?`).get(row.id)
      pipelineCount = Number(g?.n || 0)
    } catch { /* table shape varies in tests */ }

    let gaps = []
    let lanesSearched = null
    try {
      const ev = await buildCoverageEvidence(db, row.id)
      gaps = (ev?.gaps || []).map((g) => `${g.lane || g.gap_class || 'gap'}: ${g.statement || g.suggested_action || ''}`.trim())
      const lanes = ev?.lanes || ev?.source_lanes || null
      if (Array.isArray(lanes)) lanesSearched = lanes.length
    } catch (err) {
      gaps = [`coverage-evidence failed: ${err?.message}`]
    }

    console.log(`\n=== ${slug} (${row.id}) — ${persona?.expected || ''}`)
    console.log(`matches=${matchCount} pipeline=${pipelineCount}${lanesSearched != null ? ` lanes=${lanesSearched}` : ''}`)
    for (const t of top) console.log(`  [${t.match_score}] ${t.match_decision || ''} ${t.title} — ${t.sponsor || '?'} (${t.source || '?'})`)
    if (gaps.length) {
      console.log(`  gaps (${gaps.length}):`)
      for (const g of gaps.slice(0, 12)) console.log(`   - ${g}`)
    }
    summary.push({ slug, profile_id: row.id, matches: matchCount, pipeline: pipelineCount, top_score: top[0]?.match_score ?? null, gap_count: gaps.length })
  }
  console.log(`\n[cohort] REPORT_JSON ${JSON.stringify(summary)}`)
}

async function rebuildScoreboard(db) {
  console.log('[cohort] rebuilding fleet gap scoreboard…')
  await buildFleetGapScoreboard(db, {})
  const sb = await readGapScoreboard(db)
  if (!sb) {
    console.log('[cohort] scoreboard read back EMPTY')
    return
  }
  const gaps = sb.gaps || sb.top_gaps || []
  const wishlist = sb.adapter_wishlist || []
  console.log(`[cohort] scoreboard generated_at=${sb.generated_at || sb.updated_at || '?'} profiles=${sb.profiles_scanned ?? sb.profile_count ?? '?'} gaps=${Array.isArray(gaps) ? gaps.length : '?'}`)
  const cohortIds = new Set((await findCohortProfiles(db)).map((r) => r.id))
  let cohortTouched = 0
  for (const g of Array.isArray(gaps) ? gaps : []) {
    const affected = [g.affected_profile_ids, g.affected_profiles, g.profile_ids].find(Array.isArray) || []
    const hit = affected.filter((id) => cohortIds.has(id)).length
    if (hit > 0) cohortTouched += 1
    console.log(`  gap [${g.gap_class || g.class || '?'}] ${g.lane || ''} fleet=${affected.length} cohort_hits=${hit} — ${g.statement || g.label || ''}`)
  }
  for (const w of Array.isArray(wishlist) ? wishlist : []) {
    console.log(`  wishlist: ${typeof w === 'string' ? w : JSON.stringify(w)}`)
  }
  console.log(`[cohort] scoreboard gaps naming cohort profiles: ${cohortTouched}`)
}

async function purgeCohort(db) {
  if (!has('--yes')) {
    console.error('[cohort] --purge requires --yes (hard delete of the cohort)')
    process.exit(1)
  }
  const rows = await findCohortProfiles(db)
  const dependents = [
    ['profile_documents', 'profile_id'],
    ['documents', 'profile_id'],
    ['grants', 'profile_id'],
    ['crawler_jobs', 'profile_id'],
    ['profile_opportunity_matches', 'profile_id'],
    ['profile_sections', 'profile_id'],
  ]
  for (const row of rows) {
    for (const [table, col] of dependents) {
      try {
        await db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(row.id)
      } catch { /* table may not exist on this dialect */ }
    }
    await db.prepare(`DELETE FROM profiles WHERE id = ? AND created_by = ?`).run(row.id, CREATED_BY)
    console.log(`[cohort] purged ${row.display_name} (${row.id})`)
  }
  console.log(`[cohort] purge done — ${rows.length} profile(s) removed`)
}

async function main() {
  const db = getDb()
  const only = val('--only')
  const ran = []
  if (has('--create')) { await createCohort(db); ran.push('create') }
  if (has('--discover')) { await discoverCohort(db, only); ran.push('discover') }
  if (has('--report')) { await reportCohort(db, only); ran.push('report') }
  if (has('--scoreboard')) { await rebuildScoreboard(db); ran.push('scoreboard') }
  if (has('--purge')) { await purgeCohort(db); ran.push('purge') }
  if (ran.length === 0) {
    console.log('usage: node backend/scripts/crawler-stress-cohort.mjs [--create] [--discover] [--report] [--scoreboard] [--purge --yes] [--only=<slug>]')
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('[cohort] ERROR', e)
  process.exit(1)
})
