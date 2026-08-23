/**
 * profileSourceArchetypes.js — THE "GOOD SOURCE" ARCHETYPE REGISTRY.
 *
 * THE OWNER'S INSIGHT (2026-08-23). GrantFlow leans too hard on BLIND web
 * crawling and MISSES sources the models already KNOW. Asked about a small
 * holistic-wellness LLC seeking $50k for equipment (Olivia Beltran, ZERO
 * pipeline sources), the assistant instantly named SBA grants, Hello Alice,
 * the Amber Grant, IFundWomen, Comcast RISE, and the FedEx Small Business
 * Grant — none of which the crawler had ever found. The competition
 * (Instrumentl, Candid/Foundation Directory, Bold.org, Scholarships.com,
 * Grants.gov, Hello Alice) largely runs CURATED DATABASES + matching, not
 * blind crawling. So we SEED the known canonical sources per profile type/need
 * directly, and keep discovering.
 *
 * WHAT THIS MODULE IS.
 *   1. SOURCE_ARCHETYPES — for each applicant/profile type GrantFlow serves,
 *      the canonical CATEGORIES of real, applyable funding sources that fund
 *      that type, each with concrete KNOWN SOURCES (real orgs, real URLs) and
 *      query_patterns the discovery lane can run for that type + geo + need.
 *   2. resolveArchetypesForProfile(profile, sections) — maps a profile (its
 *      resolved type + declared needs/sector) to the applicable archetypes,
 *      rolling up the profile-type parent chain (a women_owned_business also
 *      gets the generic business archetypes; a college_student also gets the
 *      generic student archetypes).
 *   3. knownSeedSourcesForProfile(profile, sections) — the concrete known-source
 *      URLs to SEED into discovery for a profile, in the {url,title,snippet}
 *      shape runWebDiscoveryLane's `seedPages` consumes.
 *
 * A SEED IS A URL, NOT A VERDICT (the seed-page invariant, CLAUDE.md). Every URL
 * here enters the web lane at the SAME page stage a search hit does — fetched,
 * LLM-extracted, reality-gated, deduped, and scored by the canonical match
 * engine. Seeding a page lowers NO bar; it only removes a search's failure to
 * FIND it. A directory or an out-of-scope page is rejected by exactly the same
 * gates as everything else, which is why this can be automatic.
 *
 * DO NOT INVENT ORGS OR URLS. Every known_source below is a real funder /
 * scholarship hub / benefit portal with a real, verified URL. A wrong or dead
 * URL is worse than none (it wastes a fetch and can mislead). Prefer the
 * funder's own stable program/home page over a deep link that rots. When a
 * source retires, remove it — never leave a 404 in the registry.
 *
 * Pure data + pure functions. No DB, no network, no I/O. Safe to import
 * anywhere (mirrors config/nationalAssistanceFunders.js and config/profileItemNeeds.js).
 */

import {
  resolveProfileType,
  getParentChain,
} from '../services/profileTypeRegistry.js'

// ───────────────────────────────────────────────────────────────────────────
// Bounds. Seeding costs a fetch + an LLM extraction per page, so the seed list
// a single run receives is bounded like every other lane budget (the web
// parity gap queue uses GAP_SEED_LIMIT_PER_RUN = 8 for the same reason).
// ───────────────────────────────────────────────────────────────────────────
export const KNOWN_SEED_LIMIT_PER_RUN = 10

/**
 * SOURCE_ARCHETYPES — profileType → [{ category, known_sources, query_patterns }].
 *
 * Keys are canonical profile-type ids from `services/profileTypeRegistry.js`
 * (plus `farm`, a real applicant class the type registry does not enumerate).
 * Archetypes are keyed at the MOST GENERAL type that owns them and inherited by
 * children through the parent chain, so `student` carries the scholarship hubs
 * and `college_student`/`graduate_student`/`high_school_student` inherit them,
 * and `business` carries the federal/corporate small-business funders that
 * `women_owned_business`/`minority_owned_business`/`research_lab` inherit.
 *
 * query_patterns use `{geo}` (city/county+state phrase), `{state}`, `{need}`,
 * and `{sector}` placeholders a discovery-lane query builder can fill. They are
 * data the steering lane MAY consume; this module does not itself rewrite
 * `buildWebQueries` (that lives behind the per-run query cap the crawler-os
 * planner owns).
 */
export const SOURCE_ARCHETYPES = Object.freeze({
  // ─────────────────────────── People & households ──────────────────────────
  individual: [
    {
      category: 'safety_net_locators',
      known_sources: [
        { name: 'Benefits.gov', url: 'https://www.benefits.gov/' },
        { name: '211 (United Way)', url: 'https://www.211.org/' },
        { name: 'findhelp', url: 'https://www.findhelp.org/' },
      ],
      query_patterns: [
        'benefits.gov {state}',
        '211 community resources {geo}',
        '{need} assistance programs {geo}',
      ],
    },
    {
      category: 'hardship_and_emergency_funds',
      known_sources: [
        { name: 'Modest Needs Foundation', url: 'https://www.modestneeds.org/' },
      ],
      query_patterns: [
        'emergency hardship grant {geo}',
        'churches that help with {need} {geo}',
        '{geo} emergency assistance fund',
      ],
    },
  ],
  medical_need: [
    {
      category: 'patient_and_copay_assistance',
      known_sources: [
        { name: 'PAN Foundation', url: 'https://www.panfoundation.org/' },
        { name: 'HealthWell Foundation', url: 'https://www.healthwellfoundation.org/' },
        { name: 'Patient Advocate Foundation', url: 'https://www.patientadvocate.org/' },
        { name: 'NeedyMeds', url: 'https://www.needymeds.org/' },
        { name: 'CancerCare', url: 'https://www.cancercare.org/' },
      ],
      query_patterns: [
        '{need} patient assistance foundation',
        'copay assistance program {need}',
        'medical bills grant {geo}',
      ],
    },
  ],
  senior: [
    {
      category: 'senior_benefits',
      known_sources: [
        { name: 'BenefitsCheckUp (NCOA)', url: 'https://www.benefitscheckup.org/' },
        { name: 'Eldercare Locator', url: 'https://eldercare.acl.gov/' },
      ],
      query_patterns: [
        'Area Agency on Aging {state}',
        'senior assistance programs {geo}',
      ],
    },
  ],
  disabled_adult: [
    {
      category: 'disability_assistance',
      known_sources: [
        { name: 'The Arc', url: 'https://thearc.org/' },
        { name: 'ABLE National Resource Center', url: 'https://www.ablenrc.org/' },
        { name: 'AT3 Center (state assistive-tech programs)', url: 'https://www.at3center.net/' },
      ],
      query_patterns: [
        '{state} vocational rehabilitation services',
        'assistive technology funding {state}',
        'disability grants {geo}',
      ],
    },
  ],
  veteran: [
    {
      category: 'veteran_benefits_and_relief',
      known_sources: [
        { name: 'U.S. Department of Veterans Affairs', url: 'https://www.va.gov/' },
        { name: 'Operation Homefront', url: 'https://www.operationhomefront.org/' },
        { name: 'DAV (Disabled American Veterans)', url: 'https://www.dav.org/' },
        { name: "Semper Fi & America's Fund", url: 'https://thefund.org/' },
      ],
      query_patterns: [
        'veteran emergency financial assistance {geo}',
        'veteran grants {state}',
      ],
    },
  ],

  // ─────────────────────────────── Students ─────────────────────────────────
  student: [
    {
      category: 'federal_student_aid',
      known_sources: [
        { name: 'Federal Student Aid (FAFSA / Pell)', url: 'https://studentaid.gov/' },
      ],
      query_patterns: [
        '{state} state scholarship programs',
        'FAFSA state grant {state}',
      ],
    },
    {
      category: 'scholarship_hubs',
      known_sources: [
        { name: 'Fastweb', url: 'https://www.fastweb.com/' },
        { name: 'Scholarships.com', url: 'https://www.scholarships.com/' },
        { name: 'Bold.org', url: 'https://bold.org/' },
        { name: 'ScholarshipOwl', url: 'https://scholarshipowl.com/' },
        { name: 'CareerOneStop Scholarship Finder', url: 'https://www.careeronestop.org/toolkit/training/find-scholarships.aspx' },
        { name: 'College Board BigFuture Scholarships', url: 'https://bigfuture.collegeboard.org/scholarship-search' },
      ],
      query_patterns: [
        'scholarships for students {geo} {year}',
        '{sector} scholarships {year}',
        'local scholarships {geo}',
      ],
    },
  ],
  graduate_student: [
    {
      category: 'fellowships_and_research_funding',
      known_sources: [
        { name: 'ProFellow', url: 'https://www.profellow.com/' },
        { name: 'NSF Graduate Research Fellowship Program', url: 'https://www.nsfgrfp.org/' },
        { name: 'Grants.gov', url: 'https://www.grants.gov/' },
      ],
      query_patterns: [
        '{sector} graduate fellowship {year}',
        'research funding graduate students {sector}',
      ],
    },
  ],

  // ─────────────────────────────── Businesses ───────────────────────────────
  business: [
    {
      category: 'federal_small_business',
      known_sources: [
        { name: 'SBA Funding Programs', url: 'https://www.sba.gov/funding-programs/grants' },
        { name: 'Grants.gov', url: 'https://www.grants.gov/' },
      ],
      query_patterns: [
        'small business grants {state} {year}',
        'SBA {sector} small business grant',
      ],
    },
    {
      category: 'corporate_small_business_grants',
      known_sources: [
        { name: 'Hello Alice', url: 'https://helloalice.com/' },
        { name: 'FedEx Small Business Grant Contest', url: 'https://www.fedex.com/en-us/small-business/grant-contest.html' },
        { name: 'Comcast RISE', url: 'https://www.comcastrise.com/' },
        { name: 'Verizon Small Business Digital Ready', url: 'https://digitalready.verizonwireless.com/' },
      ],
      query_patterns: [
        'corporate small business grant {sector} {year}',
        'small business grant contest {year}',
      ],
    },
    {
      category: 'state_and_local_economic_development',
      known_sources: [
        { name: "America's SBDC (Small Business Development Centers)", url: 'https://americassbdc.org/' },
        { name: 'U.S. Economic Development Administration', url: 'https://www.eda.gov/' },
      ],
      query_patterns: [
        '{state} small business grant programs {year}',
        'chamber of commerce small business grants {geo}',
        'economic development grants {geo}',
      ],
    },
  ],
  women_owned_business: [
    {
      category: 'women_business_grant_funds',
      known_sources: [
        { name: 'Amber Grant for Women (WomensNet)', url: 'https://ambergrantsforwomen.com/' },
        { name: 'IFundWomen', url: 'https://ifundwomen.com/' },
        { name: 'Tory Burch Foundation', url: 'https://www.toryburchfoundation.org/' },
      ],
      query_patterns: [
        'grants for women owned business {sector} {year}',
        'women entrepreneur grant {year}',
      ],
    },
  ],
  minority_owned_business: [
    {
      category: 'minority_business_grant_funds',
      known_sources: [
        { name: 'Minority Business Development Agency (MBDA)', url: 'https://www.mbda.gov/' },
        { name: 'Hello Alice', url: 'https://helloalice.com/' },
      ],
      query_patterns: [
        'grants for minority owned business {sector} {year}',
        'minority business grant {state}',
      ],
    },
  ],
  research_lab: [
    {
      category: 'sbir_sttr_and_research_grants',
      known_sources: [
        { name: 'SBIR/STTR (America’s Seed Fund)', url: 'https://www.sbir.gov/' },
        { name: 'NIH Grants & Funding', url: 'https://grants.nih.gov/' },
        { name: 'NSF Funding', url: 'https://www.nsf.gov/funding' },
      ],
      query_patterns: [
        'SBIR STTR {sector} solicitation {year}',
        '{sector} research grants small business {year}',
        '{state} SBIR matching funds program',
      ],
    },
  ],

  // ─────────────────── Faith / nonprofit / community orgs ────────────────────
  nonprofit: [
    {
      category: 'foundation_and_990_funders',
      known_sources: [
        { name: 'Grants.gov', url: 'https://www.grants.gov/' },
        { name: 'Candid (Foundation Directory)', url: 'https://www.candid.org/' },
        { name: 'ProPublica Nonprofit Explorer (990 funders)', url: 'https://projects.propublica.org/nonprofits/' },
        { name: 'Council on Foundations Community Foundation Locator', url: 'https://www.cof.org/page/community-foundation-locator' },
      ],
      query_patterns: [
        'foundation grants {sector} nonprofit {geo}',
        'community foundation grants {geo}',
        'grants for nonprofits {sector} {year}',
      ],
    },
  ],
  church: [
    {
      category: 'faith_based_and_congregation_grants',
      known_sources: [
        { name: 'Lilly Endowment', url: 'https://lillyendowment.org/' },
        { name: 'National Fund for Sacred Places', url: 'https://fundforsacredplaces.org/' },
        { name: 'Partners for Sacred Places', url: 'https://sacredplaces.org/' },
      ],
      query_patterns: [
        'grants for churches {year}',
        'faith-based organization grants {state}',
        'historic church preservation grant {geo}',
      ],
    },
  ],

  // ─────────────────────────────── Public safety ────────────────────────────
  volunteer_fire_department: [
    {
      category: 'fire_ems_grants',
      known_sources: [
        { name: 'FEMA Assistance to Firefighters Grants (AFG)', url: 'https://www.fema.gov/grants/preparedness/firefighters' },
        { name: 'Firehouse Subs Public Safety Foundation', url: 'https://grants.firehousesubs.com/' },
        { name: 'National Volunteer Fire Council', url: 'https://www.nvfc.org/' },
      ],
      query_patterns: [
        'Assistance to Firefighters Grant {year}',
        'volunteer fire department equipment grants {state}',
      ],
    },
  ],

  // ─────────────────── Local government / public agency ──────────────────────
  local_government: [
    {
      category: 'federal_and_state_local_government_grants',
      known_sources: [
        { name: 'Grants.gov', url: 'https://www.grants.gov/' },
        { name: 'SAM.gov Assistance Listings', url: 'https://sam.gov/' },
        { name: 'USDA Rural Development', url: 'https://www.rd.usda.gov/' },
        { name: 'U.S. Economic Development Administration', url: 'https://www.eda.gov/' },
        { name: 'FEMA Grants', url: 'https://www.fema.gov/grants' },
      ],
      query_patterns: [
        'USDA community facilities grant {state}',
        '{state} municipal grants {year}',
        'community development block grant {state}',
      ],
    },
  ],
  tribal_government: [
    {
      category: 'tribal_grants',
      known_sources: [
        { name: 'Bureau of Indian Affairs', url: 'https://www.bia.gov/' },
        { name: 'First Nations Development Institute', url: 'https://www.firstnations.org/' },
        { name: 'Native American Agriculture Fund', url: 'https://nativeamericanagriculturefund.org/' },
        { name: 'Grants.gov', url: 'https://www.grants.gov/' },
      ],
      query_patterns: [
        'tribal government grants {year}',
        'Native American community grants {state}',
      ],
    },
  ],

  // ─────────────────────── Schools / educators ──────────────────────────────
  school: [
    {
      category: 'school_and_classroom_grants',
      known_sources: [
        { name: 'DonorsChoose', url: 'https://www.donorschoose.org/' },
        { name: 'NEA Foundation', url: 'https://www.neafoundation.org/' },
        { name: 'AdoptAClassroom.org', url: 'https://www.adoptaclassroom.org/' },
        { name: 'U.S. Department of Education Grants', url: 'https://www.ed.gov/grants-and-programs' },
      ],
      query_patterns: [
        '{state} education grants for schools {year}',
        'teacher classroom grants {year}',
      ],
    },
  ],

  // Educators (teacher / classroom_teacher roll up to `educator`, so keying the
  // classroom-grant sources here covers all three; `school` above does NOT roll
  // up to educator, so it keeps its own copy).
  educator: [
    {
      category: 'classroom_and_teacher_grants',
      known_sources: [
        { name: 'DonorsChoose', url: 'https://www.donorschoose.org/' },
        { name: 'NEA Foundation', url: 'https://www.neafoundation.org/' },
        { name: 'AdoptAClassroom.org', url: 'https://www.adoptaclassroom.org/' },
        { name: 'Toshiba America Foundation', url: 'https://www.toshiba.com/taf/' },
      ],
      query_patterns: [
        'teacher classroom grants {year}',
        '{sector} classroom grant {year}',
      ],
    },
  ],

  // ─────────────────────────────── Farms ────────────────────────────────────
  farm: [
    {
      category: 'agricultural_producer_grants',
      known_sources: [
        { name: 'USDA Rural Development', url: 'https://www.rd.usda.gov/' },
        { name: 'USDA Farm Service Agency', url: 'https://www.fsa.usda.gov/' },
        { name: 'SARE (Sustainable Agriculture Research & Education) Grants', url: 'https://www.sare.org/grants/' },
      ],
      query_patterns: [
        'USDA value-added producer grant {year}',
        '{state} department of agriculture grants {year}',
        'beginning farmer grants {state}',
      ],
    },
  ],
})

// ───────────────────────────────────────────────────────────────────────────
// Profile-type + refinement resolution (structured signals only — a denial or
// prose is never a declaration; MISSING = NEUTRAL).
// ───────────────────────────────────────────────────────────────────────────

const GENERIC_TYPE_TOKENS = new Set(['individual', 'other', 'unspecified', 'unknown', ''])

function normType(v) {
  return String(v ?? '').toLowerCase().trim().replace(/[^a-z0-9_]/g, '_')
}

/**
 * Infer a canonical archetype-registry type id from a FREE-TEXT descriptor a
 * profile stores in `organization_type` / `profile_type` / `profile_category`
 * (e.g. "Biotechnology / research organization", "Small business — LLC",
 * "Baptist congregation"). `resolveProfileType` only matches exact ids/aliases,
 * so a descriptive phrase resolves to nothing and the profile is seeded no known
 * sources — which is exactly the "GrantFlow misses sources it should find" gap
 * (Axiom BioLabs, a real biotech org, resolved to nothing). Ordered
 * MOST-SPECIFIC first so "research organization" is a research lab, not the
 * generic org fallback. Returns null when nothing distinctive is stated.
 */
export function inferTypeFromDescriptor(value) {
  const t = String(value ?? '').toLowerCase()
  if (!t.trim()) return null
  // Specific identities first.
  if (/\b(research|biotech|biotechnolog|laborator|\blab\b|clinical|life scien|genomic|pharmaceutical|bioscience|r&d)\b/.test(t)) return 'research_lab'
  if (/\b(volunteer fire|fire depart|fire district|rescue squad|\bems\b|ambulance)\b/.test(t)) return 'volunteer_fire_department'
  if (/\b(church|parish|congregation|synagogue|mosque|temple|diocese|faith[- ]based|ministry|missions?)\b/.test(t)) return 'church'
  if (/\b(tribe|tribal|native american nation|indian nation)\b/.test(t)) return 'tribal_government'
  if (/\b(farm|ranch|agricultur|orchard|dairy|livestock|producer|grower)\b/.test(t)) return 'farm'
  if (/\b(school|k-?12|academy|isd|校|classroom|educator|teacher|district)\b/.test(t)) return 'school'
  if (/\b(county|municipal|city of|town of|village of|borough|township|government|public agency|state agency|authority)\b/.test(t)) return 'local_government'
  if (/\b(women[- ]?owned)\b/.test(t)) return 'women_owned_business'
  if (/\b(minority[- ]?owned|mbe\b|dbe\b)\b/.test(t)) return 'minority_owned_business'
  if (/\b(small business|for[- ]?profit|startup|\bllc\b|\binc\b|corporation|company|enterprise|sole proprietor)\b/.test(t)) return 'business'
  // Broad org catch-alls last (foundation/990/community-foundation funders serve any org type).
  if (/\b(nonprofit|non[- ]profit|not[- ]for[- ]profit|501\(?c\)?3?|charity|foundation|organization|association|coalition|institute)\b/.test(t)) return 'nonprofit'
  return null
}

/** A positive, DECLARED organization signal (never inferred from silence). */
function hasOrgSignal(basic, org, profile) {
  const bt = normType(basic.profile_type || basic.profile_category)
  if (bt === 'organization' || bt === 'org' || bt === 'nonprofit' || bt === 'business') return true
  if (String(org.organization_type || '').trim()) return true
  const biz = org.business_name || (profile && profile.business_name)
  if (String(biz || '').trim()) return true
  return false
}

function sec(sections, key) {
  const v = sections && sections[key]
  if (!v) return {}
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} }
  }
  return typeof v === 'object' ? v : {}
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes'
}

/**
 * Resolve the profile's canonical type id (registry id) from structured
 * profile/section fields, preferring a specific org/type value over a generic
 * "individual" default. Kept minimal + self-contained so this config module
 * does not import the heavy service layer; the candidate fields mirror
 * `services/profileHelpers.resolveEffectiveProfileType`.
 */
export function resolveArchetypeType(profile, sections = {}) {
  const p = profile || {}
  const basic = sec(sections, 'basic_information')
  const org = sec(sections, 'organization_details')
  const biz = sec(sections, 'small_business_details')
  // Descriptor fields carry free text ("Biotechnology / research organization");
  // the person/primary-type fields carry ids/aliases.
  const descriptors = [org.organization_type, basic.profile_type, basic.profile_category, p.type]
  const candidates = [
    org.organization_type,
    basic.profile_type,
    basic.profile_category,
    p.applicant_type,
    p.primary_type,
    p.primary_profile_type,
    p.type,
  ]
  // 1. Exact registry id/alias, specific (non-generic) value first.
  for (const c of candidates) {
    const norm = normType(c)
    if (norm && !GENERIC_TYPE_TOKENS.has(norm)) {
      const resolved = resolveProfileType(norm)
      if (resolved) return resolved
    }
  }
  // 2. Free-text descriptor inference — a real org whose type is a phrase, not
  //    an id (the Axiom BioLabs "research organization" -> research_lab gap).
  for (const c of descriptors) {
    const inferred = inferTypeFromDescriptor(c)
    if (inferred) return inferred
  }
  // 3. Any resolvable candidate (including a generic "individual").
  for (const c of candidates) {
    const resolved = resolveProfileType(normType(c))
    if (resolved) return resolved
  }
  // 4. A DECLARED organization we could not type precisely still gets the broad
  //    org (foundation / 990 / community-foundation) funders — those serve every
  //    org type. Silence (no org signal at all) stays neutral -> null.
  if (hasOrgSignal(basic, { ...org, business_name: org.business_name || biz.business_name }, p)) return 'nonprofit'
  return null
}

/** Structured refinement keys layered on top of the resolved type chain. */
function refinementKeys(profile, sections, resolvedType) {
  const keys = new Set()
  const biz = sec(sections, 'small_business_details')
  const org = sec(sections, 'organization_details')
  const demo = sec(sections, 'demographics')

  // Is this an org that is business-shaped? (women/minority refinements only
  // apply to a business.)
  const chain = new Set([resolvedType, ...getParentChain(resolvedType)])
  const isBusiness = chain.has('business')

  if (isBusiness) {
    if (truthy(biz.women_owned) || truthy(biz.woman_owned) || truthy(org.women_owned) ||
        truthy(demo.women_owned_business)) {
      keys.add('women_owned_business')
    }
    if (truthy(biz.minority_owned) || truthy(org.minority_owned) ||
        truthy(demo.minority_owned_business)) {
      keys.add('minority_owned_business')
    }
  }

  // Agriculture / farm refinement, read from a structured sector/industry value.
  const sectorText = [
    biz.industry, biz.sector, biz.business_type, org.sector, org.industry,
    profile?.sector, profile?.industry,
  ].map((v) => String(v ?? '').toLowerCase()).join(' ')
  if (/\b(agricultur|farm|farming|ranch|livestock|crop|dairy|orchard|producer)\b/.test(sectorText)) {
    keys.add('farm')
  }

  return keys
}

/**
 * resolveArchetypesForProfile — the applicable archetypes for a profile.
 *
 * Returns a flat, de-duplicated array of `{ type, category, known_sources,
 * query_patterns }` (the archetype rows plus the profile-type key they were
 * resolved under), unioned across the resolved type, its parent chain, and any
 * structured refinements (women/minority-owned business, farm). An unknown /
 * unresolvable type returns [] — MISSING = NEUTRAL, never a wrong archetype.
 */
export function resolveArchetypesForProfile(profile, sections = {}) {
  const resolved = resolveArchetypeType(profile, sections)
  const typeKeys = []
  const pushKey = (k) => { if (k && !typeKeys.includes(k)) typeKeys.push(k) }

  if (resolved) {
    pushKey(resolved)
    for (const parent of getParentChain(resolved)) pushKey(parent)
  }
  for (const k of refinementKeys(profile, sections, resolved)) pushKey(k)

  const rows = []
  const seenCategory = new Set()
  for (const typeKey of typeKeys) {
    const archetypes = SOURCE_ARCHETYPES[typeKey]
    if (!Array.isArray(archetypes)) continue
    for (const a of archetypes) {
      const dedupeKey = `${typeKey}:${a.category}`
      if (seenCategory.has(dedupeKey)) continue
      seenCategory.add(dedupeKey)
      rows.push({
        type: typeKey,
        category: a.category,
        known_sources: a.known_sources,
        query_patterns: a.query_patterns,
      })
    }
  }
  return rows
}

/**
 * knownSeedSourcesForProfile — the concrete known-source URLs to SEED into a
 * profile's next discovery run, in the {url,title,snippet} shape
 * runWebDiscoveryLane's `seedPages` consumes.
 *
 * This is the "seed what the model already knows" fix. These become seed URLs
 * the existing web lane fetches → extracts → reality-gates → matches, exactly
 * like the web-parity gap-queue seeds already do. They bypass NO gate.
 *
 * De-duplicated by normalized URL, bounded to `limit` (KNOWN_SEED_LIMIT_PER_RUN
 * by default), ordered by archetype specificity (a women-owned business's
 * women-business funds come before the generic federal small-business ones, so
 * the most on-point sources survive the bound).
 *
 * @returns {Array<{url:string, title:string, snippet:string}>}
 */
export function knownSeedSourcesForProfile(profile, sections = {}, { limit = KNOWN_SEED_LIMIT_PER_RUN } = {}) {
  const rows = resolveArchetypesForProfile(profile, sections)
  const out = []
  const seen = new Set()
  for (const row of rows) {
    for (const src of Array.isArray(row.known_sources) ? row.known_sources : []) {
      const url = String(src?.url || '').trim()
      if (!/^https?:\/\//i.test(url)) continue
      const key = url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        url,
        title: String(src?.name || '').trim() || null,
        snippet: `known source for ${row.type} / ${row.category}`,
      })
    }
  }
  return out.slice(0, Math.max(0, limit))
}

export default {
  KNOWN_SEED_LIMIT_PER_RUN,
  SOURCE_ARCHETYPES,
  inferTypeFromDescriptor,
  resolveArchetypeType,
  resolveArchetypesForProfile,
  knownSeedSourcesForProfile,
}
