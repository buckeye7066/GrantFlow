/**
 * Search Plan Generator — Phase 4
 *
 * Converts normalized profile intelligence + inferred needs into targeted
 * search plans. Each plan is self-contained and actionable.
 *
 * A search plan includes:
 *   need_code, search_lane, search_terms[], boosted_terms[], entity_constraints[],
 *   geography_constraints, exclusions[], priority_weight, expected_funding_type,
 *   search_scope (local|state|federal|private|denominational|all)
 */

import { getNeed, isValidNeedCode } from './needsTaxonomy.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plan(needCode, opts = {}) {
  return {
    need_code: needCode,
    search_lane: opts.search_lane ?? 'general',
    search_terms: opts.search_terms ?? [],
    boosted_terms: opts.boosted_terms ?? [],
    entity_constraints: opts.entity_constraints ?? [],
    geography_constraints: opts.geography_constraints ?? {},
    exclusions: opts.exclusions ?? [],
    priority_weight: opts.priority_weight ?? 0.5,
    expected_funding_type: opts.expected_funding_type ?? 'grant',
    search_scope: opts.search_scope ?? ['federal', 'state', 'private'],
  }
}

// ---------------------------------------------------------------------------
// Per-need plan generators
// ---------------------------------------------------------------------------

function planFacilitiesRepair(intel, need) {
  const state = intel.state
  const isChurch = intel.is_faith_based || intel.entity_types?.includes('church')
  const isRural = intel.is_rural

  const searchTerms = [
    'facility repair grant',
    'building rehabilitation grant',
    'capital improvement grant',
  ]
  const boostedTerms = []

  if (isChurch) {
    searchTerms.push('church building repair grant', 'religious facility repair grant')
    boostedTerms.push('faith-based', 'church', 'religious organization')
  }
  if (isRural) {
    searchTerms.push('USDA community facilities grant', 'rural facility repair grant', 'rural building improvement grant')
    boostedTerms.push('rural', 'underserved community')
  }
  if (state) {
    searchTerms.push(`${state} facility repair grant`, `${state} building improvement grant`)
  }

  const exclusions = []
  if (isChurch) {
    exclusions.push('public-use required', 'secular use only')
  }

  return plan(need.code, {
    search_lane: 'capital_facilities',
    search_terms: searchTerms,
    boosted_terms: boostedTerms,
    entity_constraints: intel.entity_types ?? [],
    geography_constraints: { state, is_rural: isRural },
    exclusions,
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['federal', 'state', 'private', ...(isChurch ? ['denominational'] : [])],
  })
}

function planPublicSafetyEquipment(intel, need) {
  const state = intel.state
  const isRural = intel.is_rural
  const isFireDept = intel.entity_types?.includes('volunteer_fire_dept')

  const searchTerms = [
    'public safety equipment grant',
    'AFG grant',
    'FEMA fire department grant',
    'Assistance to Firefighters Grant',
  ]
  if (isFireDept) {
    searchTerms.push(
      'volunteer fire department equipment grant',
      'rural fire department PPE grant',
      'fire department communications grant',
      'AFG equipment grant',
    )
  }
  if (isRural) {
    searchTerms.push('rural fire department grant', 'rural EMS equipment grant')
  }
  if (state) {
    searchTerms.push(`${state} fire department grant`, `${state} public safety grant`)
  }

  return plan(need.code, {
    search_lane: 'public_safety',
    search_terms: searchTerms,
    boosted_terms: ['volunteer fire', 'rural fire', 'turnout gear', 'SCBA', 'apparatus'],
    entity_constraints: ['volunteer_fire_dept', 'local_government'],
    geography_constraints: { state, is_rural: isRural },
    exclusions: ['individuals', 'for-profit'],
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['federal', 'state', 'private'],
  })
}

function planPPE(intel, need) {
  const state = intel.state
  const isFireDept = intel.entity_types?.includes('volunteer_fire_dept')

  const searchTerms = ['PPE grant', 'personal protective equipment grant']
  if (isFireDept) {
    searchTerms.push('AFG PPE grant', 'turnout gear grant', 'fire department PPE', 'SCBA grant', 'helmet grant')
  }
  if (state) {
    searchTerms.push(`${state} PPE grant`, `${state} fire department equipment`)
  }

  return plan(need.code, {
    search_lane: 'public_safety',
    search_terms: searchTerms,
    boosted_terms: ['turnout gear', 'SCBA', 'self-contained breathing apparatus', 'helmets'],
    entity_constraints: intel.entity_types ?? [],
    geography_constraints: { state },
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['federal', 'state'],
  })
}

function planVehicles(intel, need) {
  const state = intel.state
  const isFireDept = intel.entity_types?.includes('volunteer_fire_dept')
  const isRural = intel.is_rural

  const searchTerms = ['vehicle grant nonprofit', 'emergency vehicle grant']
  if (isFireDept) {
    searchTerms.push(
      'fire apparatus grant',
      'AFG vehicle grant',
      'fire truck grant',
      'tanker grant',
      'ambulance grant',
    )
  }
  if (isRural) {
    searchTerms.push('rural fire apparatus grant', 'rural emergency vehicle grant')
  }
  if (state) {
    searchTerms.push(`${state} fire apparatus grant`)
  }

  return plan(need.code, {
    search_lane: 'capital_equipment',
    search_terms: searchTerms,
    boosted_terms: ['apparatus', 'engine', 'tanker', 'rescue truck'],
    entity_constraints: ['volunteer_fire_dept', 'nonprofit', 'local_government'],
    geography_constraints: { state, is_rural: isRural },
    exclusions: ['individuals'],
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['federal', 'state'],
  })
}

function planScholarships(intel, need) {
  const state = intel.state
  const religion = intel.demographic_flags?.find(f => f.startsWith('religion:'))
  const isVeteran = intel.is_veteran
  const hasDisability = intel.hardship_flags?.includes('disability')
  const raceFlags = (intel.demographic_flags ?? []).filter(f => f.startsWith('race:'))

  const searchTerms = [
    'college scholarship',
    'undergraduate scholarship',
    'tuition assistance program',
    'financial aid for college',
  ]
  if (state) {
    searchTerms.push(`${state} scholarship program`, `${state} college grant`)
  }
  if (religion) {
    const rel = religion.replace('religion:', '')
    searchTerms.push(`${rel} scholarship`, `faith-based scholarship ${rel}`)
  }
  if (isVeteran) {
    searchTerms.push('veteran scholarship', 'GI Bill dependent scholarship', 'military family scholarship')
  }
  if (hasDisability) {
    searchTerms.push('disability scholarship', 'students with disabilities scholarship')
  }
  for (const rf of raceFlags) {
    const race = rf.replace('race:', '').replace(/_/g, ' ')
    searchTerms.push(`${race} scholarship`)
  }

  return plan(need.code, {
    search_lane: 'education_scholarships',
    search_terms: searchTerms,
    boosted_terms: ['enrolled student', 'undergraduate', 'financial need'],
    entity_constraints: ['individual_student', 'individual'],
    geography_constraints: { state },
    exclusions: ['organizations', 'nonprofits', 'businesses'],
    priority_weight: need.weight,
    expected_funding_type: 'scholarship',
    search_scope: ['federal', 'state', 'private'],
  })
}

function planUtilitiesSupport(intel, need) {
  const state = intel.state
  const isChurch = intel.is_faith_based || intel.entity_types?.includes('church')
  const isIndividual = intel.entity_types?.includes('individual') || !intel.entity_types?.length

  const searchTerms = ['utility assistance program', 'energy assistance program']
  if (isIndividual) {
    searchTerms.push('LIHEAP', 'heating assistance', 'cooling assistance', 'electric bill help', 'low income energy assistance')
  }
  if (isChurch) {
    searchTerms.push('church utility grant', 'faith-based energy assistance', 'community facility utility grant')
  }
  if (intel.is_rural) {
    searchTerms.push('rural energy assistance program', 'USDA energy program')
  }
  if (state) {
    searchTerms.push(`${state} utility assistance`, `${state} energy program`, `${state} LIHEAP`)
  }

  return plan(need.code, {
    search_lane: 'utilities_energy',
    search_terms: searchTerms,
    boosted_terms: ['low income', 'heating', 'cooling', 'electric'],
    entity_constraints: intel.entity_types?.length ? intel.entity_types : ['individual'],
    geography_constraints: { state },
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['federal', 'state', 'local', 'private'],
  })
}

function planHousingSupport(intel, need) {
  const state = intel.state
  const isVeteran = intel.is_veteran
  const isIndividual = !intel.entity_types?.some(t => ['nonprofit', 'church', 'school_district'].includes(t))

  const searchTerms = ['rental assistance program', 'housing assistance', 'emergency housing help']
  if (isVeteran) {
    searchTerms.push('VASH voucher', 'HUD-VASH housing', 'veteran housing assistance')
  }
  if (isIndividual) {
    searchTerms.push('eviction prevention grant', 'rent assistance program', 'emergency rental help')
  }
  if (state) {
    searchTerms.push(`${state} rental assistance`, `${state} housing assistance`)
  }

  return plan(need.code, {
    search_lane: 'housing',
    search_terms: searchTerms,
    boosted_terms: ['rental', 'eviction', 'housing stability'],
    entity_constraints: intel.entity_types?.length ? intel.entity_types : ['individual'],
    geography_constraints: { state },
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['federal', 'state', 'local', 'private'],
  })
}

function planArtsEquipment(intel, need) {
  const state = intel.state
  const isSchool = intel.entity_types?.includes('school_district')

  const searchTerms = ['arts education grant', 'school arts program grant']
  if (isSchool) {
    searchTerms.push(
      'musical instruments grant for schools',
      'band equipment grant',
      'orchestra instruments donation',
      'music program school grant',
      'school arts equipment grant',
    )
  }
  if (state) {
    searchTerms.push(`${state} arts education grant`, `${state} school music grant`)
  }

  return plan(need.code, {
    search_lane: 'arts_education',
    search_terms: searchTerms,
    boosted_terms: ['musical instruments', 'band', 'orchestra', 'choir'],
    entity_constraints: ['school_district', 'nonprofit', 'arts_org'],
    geography_constraints: { state },
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['federal', 'state', 'private'],
  })
}

function planAthleticsEquipment(intel, need) {
  const state = intel.state
  const isSchool = intel.entity_types?.includes('school_district')

  const searchTerms = ['athletics equipment grant', 'sports equipment for youth']
  if (isSchool) {
    searchTerms.push(
      'school sports equipment grant',
      'youth sports gear donation',
      'school athletics grant',
      'Title IX sports equipment',
    )
  }
  if (state) {
    searchTerms.push(`${state} school athletics grant`, `${state} youth sports grant`)
  }

  return plan(need.code, {
    search_lane: 'athletics_education',
    search_terms: searchTerms,
    boosted_terms: ['uniforms', 'helmets', 'athletic gear', 'sports equipment'],
    entity_constraints: ['school_district', 'nonprofit', 'youth_org'],
    geography_constraints: { state },
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['state', 'private'],
  })
}

function planTechnology(intel, need) {
  const state = intel.state
  const isSchool = intel.entity_types?.includes('school_district')
  const isRural = intel.is_rural

  const searchTerms = ['technology grant', 'digital equity grant', 'computer equipment grant']
  if (isSchool) {
    searchTerms.push('E-rate program', 'school technology grant', 'educational technology grant', 'classroom technology grant')
  }
  if (isRural) {
    searchTerms.push('rural technology grant', 'rural digital inclusion grant')
  }
  if (state) {
    searchTerms.push(`${state} technology grant`, `${state} digital equity program`)
  }

  return plan(need.code, {
    search_lane: 'technology',
    search_terms: searchTerms,
    boosted_terms: ['computers', 'devices', 'software', 'IT infrastructure'],
    entity_constraints: intel.entity_types ?? [],
    geography_constraints: { state, is_rural: isRural },
    priority_weight: need.weight,
    expected_funding_type: 'grant',
    search_scope: ['federal', 'state', 'private'],
  })
}

function planGenericNeed(intel, need) {
  const needDef = getNeed(need.code)
  if (!needDef) return null
  const state = intel.state

  const searchTerms = [...(needDef.exampleSearchTerms ?? [])]
  if (state) {
    searchTerms.push(`${state} ${needDef.description.toLowerCase().split('.')[0]}`)
  }

  return plan(need.code, {
    search_lane: need.code,
    search_terms: searchTerms,
    boosted_terms: needDef.synonyms?.slice(0, 5) ?? [],
    entity_constraints: needDef.relatedEntityTypes ?? [],
    geography_constraints: { state },
    priority_weight: need.weight,
    expected_funding_type: needDef.preferredFundingTypes?.[0] ?? 'grant',
    search_scope: ['federal', 'state', 'private'],
  })
}

// ---------------------------------------------------------------------------
// Router: dispatch to the right generator
// ---------------------------------------------------------------------------

const PLAN_GENERATORS = {
  facilities_repair: planFacilitiesRepair,
  facilities_preservation: (intel, need) => planGenericNeed(intel, need),
  public_safety_equipment: planPublicSafetyEquipment,
  ppe: planPPE,
  vehicles: planVehicles,
  scholarships_tuition: planScholarships,
  utilities_support: planUtilitiesSupport,
  housing_support: planHousingSupport,
  arts_equipment: planArtsEquipment,
  athletics_equipment: planAthleticsEquipment,
  technology: planTechnology,
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate search plans from a profile intelligence object (with inferred needs).
 *
 * @param {Object} intel - Output of annotateWithInferredNeeds() or similar
 * @param {Object} [opts]
 * @param {number} [opts.maxPlans=15]      - Maximum plans to return
 * @param {number} [opts.minNeedWeight=0.4] - Minimum need weight to generate a plan
 * @returns {Object[]} Array of search plans sorted by priority_weight descending
 */
export function generateSearchPlans(intel, opts = {}) {
  const maxPlans = opts.maxPlans ?? 15
  const minNeedWeight = opts.minNeedWeight ?? 0.4

  const allNeeds = [
    ...(intel.likely_needs ?? []),
    ...(intel.explicit_requested_needs ?? []),
  ]

  const seenCodes = new Set()
  const plans = []

  for (const need of allNeeds) {
    if (seenCodes.has(need.code)) continue
    if ((need.weight ?? 0) < minNeedWeight) continue
    if (!isValidNeedCode(need.code)) continue
    seenCodes.add(need.code)

    const generator = PLAN_GENERATORS[need.code] ?? planGenericNeed
    const generated = generator(intel, need)
    if (generated) {
      // Inject geo context from intel
      generated.geography_constraints = {
        ...generated.geography_constraints,
        state: intel.state ?? generated.geography_constraints?.state ?? null,
        city: intel.city ?? null,
        zip: intel.zip ?? null,
        is_rural: intel.is_rural ?? generated.geography_constraints?.is_rural ?? false,
      }
      plans.push(generated)
    }
  }

  return plans
    .sort((a, b) => (b.priority_weight ?? 0) - (a.priority_weight ?? 0))
    .slice(0, maxPlans)
}

export default { generateSearchPlans }
