/**
 * Needs Taxonomy — Phase 2
 *
 * Versioned, centralized taxonomy of fundable need types.
 * Every inferred or explicit need should be mapped to one of these codes.
 *
 * Each entry defines:
 *  - code:                unique identifier
 *  - description:         human-readable summary
 *  - synonyms:            alternate keywords / phrases
 *  - relatedEntityTypes:  which entity types commonly have this need
 *  - disallowedEntityTypes: entity types that should NOT match this need
 *  - preferredFundingTypes: how this need is typically funded
 *  - exampleSearchTerms:  search strings to use for discovery
 *  - scoringHints:        notes for the relevance scorer
 *  - fundability:         'grant'|'donor'|'rebate'|'contract'|'scholarship'|'not_fundable'|'mixed'
 */

export const TAXONOMY_VERSION = '1.0.0'

/** @type {Map<string, Object>} */
export const NEEDS_TAXONOMY = new Map([

  ['facilities_repair', {
    code: 'facilities_repair',
    description: 'Physical repair, renovation, or restoration of an existing building or facility.',
    synonyms: ['building repair', 'roof repair', 'structural repair', 'renovation', 'rehabilitation', 'restore building'],
    relatedEntityTypes: ['church', 'nonprofit', 'local_government', 'school_district', 'volunteer_fire_dept', 'housing_authority'],
    disallowedEntityTypes: ['individual', 'for_profit_business'],
    preferredFundingTypes: ['grant', 'loan', 'rebate'],
    exampleSearchTerms: ['facility repair grant', 'building rehabilitation grant', 'capital improvement grant', 'USDA community facilities grant'],
    scoringHints: 'Strong signal when organization owns or occupies a building; weak signal for individuals.',
    fundability: 'grant',
  }],

  ['facilities_preservation', {
    code: 'facilities_preservation',
    description: 'Preservation of historic or culturally significant buildings and structures.',
    synonyms: ['historic preservation', 'heritage building', 'landmark restoration', 'cultural preservation'],
    relatedEntityTypes: ['church', 'nonprofit', 'local_government', 'school_district', 'tribal_government'],
    disallowedEntityTypes: ['individual', 'for_profit_business'],
    preferredFundingTypes: ['grant'],
    exampleSearchTerms: ['historic preservation grant', 'National Register of Historic Places', 'SHPO grant', 'heritage fund'],
    scoringHints: 'Boosted when building is historic or listed; requires documentation of significance.',
    fundability: 'grant',
  }],

  ['accessibility_upgrades', {
    code: 'accessibility_upgrades',
    description: 'ADA compliance, ramps, elevators, accessible restrooms, and other accessibility improvements.',
    synonyms: ['ADA compliance', 'wheelchair ramp', 'accessibility retrofit', 'handicap access', 'barrier removal'],
    relatedEntityTypes: ['church', 'nonprofit', 'local_government', 'school_district', 'volunteer_fire_dept'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'rebate'],
    exampleSearchTerms: ['ADA accessibility grant', 'barrier removal grant', 'disability access improvement grant'],
    scoringHints: 'Strong match when profile mentions accessibility barriers or older building stock.',
    fundability: 'grant',
  }],

  ['safety_upgrades', {
    code: 'safety_upgrades',
    description: 'Fire safety, alarm systems, security systems, emergency egress, code compliance.',
    synonyms: ['fire safety', 'sprinkler system', 'alarm installation', 'emergency egress', 'building code'],
    relatedEntityTypes: ['church', 'nonprofit', 'school_district', 'volunteer_fire_dept', 'local_government'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'rebate'],
    exampleSearchTerms: ['fire safety grant', 'school safety grant', 'building code compliance grant'],
    scoringHints: 'Boosted when profile mentions safety concerns, aging facility, or compliance requirements.',
    fundability: 'grant',
  }],

  ['utilities_support', {
    code: 'utilities_support',
    description: 'Assistance with electricity, gas, water, heating, or cooling costs.',
    synonyms: ['utility assistance', 'LIHEAP', 'heating assistance', 'cooling assistance', 'electric bill help', 'water bill help'],
    relatedEntityTypes: ['individual', 'family', 'church', 'nonprofit'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'rebate', 'benefit_program'],
    exampleSearchTerms: ['utility assistance program', 'LIHEAP', 'heating assistance grant', 'energy assistance program'],
    scoringHints: 'Strongest for low-income profiles with utility hardship signals.',
    fundability: 'mixed',
  }],

  ['energy_efficiency', {
    code: 'energy_efficiency',
    description: 'Energy efficiency upgrades: insulation, HVAC, weatherization, solar panels.',
    synonyms: ['weatherization', 'insulation', 'HVAC upgrade', 'solar panels', 'energy audit', 'WAP'],
    relatedEntityTypes: ['individual', 'church', 'nonprofit', 'local_government', 'school_district'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'rebate', 'loan'],
    exampleSearchTerms: ['weatherization assistance program', 'energy efficiency grant', 'WAP program', 'green building rebate'],
    scoringHints: 'Triggered by old building, high utility costs, or explicit mention of weatherization.',
    fundability: 'mixed',
  }],

  ['technology', {
    code: 'technology',
    description: 'Computers, software, IT infrastructure, devices, and digital tools.',
    synonyms: ['computers', 'IT equipment', 'software', 'devices', 'digital tools', 'tech upgrade', 'STEM equipment'],
    relatedEntityTypes: ['school_district', 'nonprofit', 'library', 'community_action_agency', 'individual'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'donation'],
    exampleSearchTerms: ['technology grant for schools', 'computer equipment grant', 'E-rate program', 'digital equity grant'],
    scoringHints: 'Especially strong for school and library profiles.',
    fundability: 'grant',
  }],

  ['broadband', {
    code: 'broadband',
    description: 'Internet access, broadband connectivity, and digital inclusion.',
    synonyms: ['internet access', 'broadband access', 'digital divide', 'connectivity', 'WiFi', 'rural internet'],
    relatedEntityTypes: ['local_government', 'nonprofit', 'school_district', 'tribal_government', 'individual'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant'],
    exampleSearchTerms: ['broadband access grant', 'rural broadband program', 'USDA ReConnect program', 'digital equity grant'],
    scoringHints: 'Strong for rural or low-income profiles mentioning internet access.',
    fundability: 'grant',
  }],

  ['vehicles', {
    code: 'vehicles',
    description: 'Vehicles: emergency vehicles, passenger vans, utility trucks, ambulances.',
    synonyms: ['fire truck', 'ambulance', 'van', 'vehicle grant', 'transportation vehicle', 'apparatus'],
    relatedEntityTypes: ['volunteer_fire_dept', 'nonprofit', 'community_action_agency', 'local_government'],
    disallowedEntityTypes: ['individual'],
    preferredFundingTypes: ['grant'],
    exampleSearchTerms: ['fire apparatus grant', 'emergency vehicle grant', 'AFG vehicle', 'volunteer fire department truck grant'],
    scoringHints: 'Specific to volunteer fire/EMS and transit nonprofits; very weak for general nonprofits.',
    fundability: 'grant',
  }],

  ['equipment', {
    code: 'equipment',
    description: 'General equipment, tools, machinery, and specialized gear.',
    synonyms: ['equipment grant', 'tools', 'machinery', 'gear', 'apparatus', 'instruments'],
    relatedEntityTypes: ['school_district', 'nonprofit', 'volunteer_fire_dept', 'tribal_government', 'agricultural_org'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'donation'],
    exampleSearchTerms: ['equipment grant', 'tools and equipment grant', 'capital equipment grant'],
    scoringHints: 'Boosted by explicit equipment requests in story/funding ask.',
    fundability: 'grant',
  }],

  ['ppe', {
    code: 'ppe',
    description: 'Personal protective equipment: turnout gear, helmets, gloves, masks.',
    synonyms: ['turnout gear', 'protective gear', 'safety equipment', 'PPE grant', 'helmets', 'gloves'],
    relatedEntityTypes: ['volunteer_fire_dept', 'healthcare_org', 'school_district', 'nonprofit'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant'],
    exampleSearchTerms: ['PPE grant', 'AFG PPE', 'turnout gear grant', 'first responder equipment grant'],
    scoringHints: 'Very strong for volunteer fire/EMS profiles; moderate for healthcare.',
    fundability: 'grant',
  }],

  ['training', {
    code: 'training',
    description: 'Job training, professional development, certification courses, and skills training.',
    synonyms: ['job training', 'workforce training', 'professional development', 'certification', 'skills', 'retraining'],
    relatedEntityTypes: ['individual', 'nonprofit', 'workforce_board', 'community_action_agency'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'scholarship'],
    exampleSearchTerms: ['job training grant', 'workforce training grant', 'certification assistance program'],
    scoringHints: 'Strong for unemployed, underemployed, career-changers, and first responder profiles.',
    fundability: 'mixed',
  }],

  ['staffing_salary', {
    code: 'staffing_salary',
    description: 'Staff salaries, pastor compensation, staffing costs, and human resources funding.',
    synonyms: ['salary support', 'pastor salary', 'staff funding', 'personnel costs', 'payroll assistance', 'position funding'],
    relatedEntityTypes: ['church', 'nonprofit', 'community_action_agency', 'volunteer_fire_dept'],
    disallowedEntityTypes: ['individual', 'for_profit_business'],
    preferredFundingTypes: ['grant', 'denomination_support'],
    exampleSearchTerms: ['salary support grant', 'staffing grant for nonprofits', 'staff funding grant'],
    scoringHints: 'Rare and hard to fund via grants; stronger via denominational/private donor channels.',
    fundability: 'donor',
  }],

  ['program_operations', {
    code: 'program_operations',
    description: 'General operating costs, program expenses, administrative costs.',
    synonyms: ['operating costs', 'program expenses', 'general operations', 'administrative', 'overhead'],
    relatedEntityTypes: ['church', 'nonprofit', 'community_action_agency', 'school_district'],
    disallowedEntityTypes: ['individual'],
    preferredFundingTypes: ['grant', 'donor'],
    exampleSearchTerms: ['general operating grant', 'program support grant', 'operational funding nonprofit'],
    scoringHints: 'Common need for nonprofits; boosted when story explicitly requests operating support.',
    fundability: 'mixed',
  }],

  ['food_programs', {
    code: 'food_programs',
    description: 'Food pantry, soup kitchen, community meals, food distribution programs.',
    synonyms: ['food pantry', 'food bank', 'community meals', 'food distribution', 'soup kitchen', 'hunger relief'],
    relatedEntityTypes: ['church', 'nonprofit', 'community_action_agency', 'food_bank'],
    disallowedEntityTypes: ['for_profit_business'],
    preferredFundingTypes: ['grant', 'donation'],
    exampleSearchTerms: ['food pantry grant', 'hunger relief grant', 'community food program grant', 'USDA food assistance'],
    scoringHints: 'Strong for faith-based and community organizations running food programs.',
    fundability: 'grant',
  }],

  ['housing_support', {
    code: 'housing_support',
    description: 'Rental assistance, mortgage help, eviction prevention, housing stability.',
    synonyms: ['rental assistance', 'housing assistance', 'eviction prevention', 'mortgage help', 'homeless shelter', 'housing voucher'],
    relatedEntityTypes: ['individual', 'family', 'housing_authority', 'nonprofit', 'community_action_agency'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'benefit_program', 'loan'],
    exampleSearchTerms: ['rental assistance program', 'eviction prevention grant', 'emergency housing assistance', 'HUD housing grant'],
    scoringHints: 'Strong for housing-insecure individuals; also for nonprofits providing housing services.',
    fundability: 'mixed',
  }],

  ['health_medical_support', {
    code: 'health_medical_support',
    description: 'Medical bills, prescriptions, dental, vision, mental health, and healthcare access.',
    synonyms: ['medical bills', 'prescription assistance', 'healthcare access', 'mental health', 'dental care', 'vision care'],
    relatedEntityTypes: ['individual', 'nonprofit', 'clinic', 'fqhc', 'tribal_government'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'benefit_program', 'donation'],
    exampleSearchTerms: ['medical bill assistance', 'prescription assistance program', 'healthcare access grant', 'mental health grant'],
    scoringHints: 'Very broad; boosted by specific medical conditions, disability, or uninsured status.',
    fundability: 'mixed',
  }],

  ['emergency_assistance', {
    code: 'emergency_assistance',
    description: 'Crisis help, emergency funds, disaster relief, and immediate financial assistance.',
    synonyms: ['emergency help', 'crisis assistance', 'emergency fund', 'disaster relief', 'hardship relief'],
    relatedEntityTypes: ['individual', 'family', 'nonprofit', 'community_action_agency'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'benefit_program'],
    exampleSearchTerms: ['emergency financial assistance', 'crisis assistance program', 'FEMA disaster assistance', 'hardship grant'],
    scoringHints: 'Triggered by hardship flags, crisis language, or disaster context.',
    fundability: 'mixed',
  }],

  ['scholarships_tuition', {
    code: 'scholarships_tuition',
    description: 'Scholarships, tuition grants, educational awards, and financial aid for students.',
    synonyms: ['scholarship', 'tuition grant', 'financial aid', 'college grant', 'education award', 'FAFSA'],
    relatedEntityTypes: ['individual_student', 'individual'],
    disallowedEntityTypes: ['nonprofit', 'local_government', 'for_profit_business'],
    preferredFundingTypes: ['scholarship', 'grant'],
    exampleSearchTerms: ['college scholarship', 'tuition assistance program', 'undergraduate scholarship', 'graduate fellowship'],
    scoringHints: 'Requires student status; boosted by major, demographics, financial need.',
    fundability: 'scholarship',
  }],

  ['debt_relief', {
    code: 'debt_relief',
    description: 'Help with debt, debt forgiveness, student loan relief, and financial recovery.',
    synonyms: ['debt forgiveness', 'student loan forgiveness', 'debt relief', 'financial recovery', 'credit counseling'],
    relatedEntityTypes: ['individual'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['benefit_program', 'grant'],
    exampleSearchTerms: ['student loan forgiveness', 'debt relief program', 'financial counseling assistance'],
    scoringHints: 'Weak for grants but strong for benefit programs; especially student loan forgiveness.',
    fundability: 'not_fundable',
  }],

  ['childcare_support', {
    code: 'childcare_support',
    description: 'Childcare subsidies, daycare cost assistance, and child development programs.',
    synonyms: ['childcare subsidy', 'daycare assistance', 'Head Start', 'child development', 'after school care'],
    relatedEntityTypes: ['individual', 'family'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['benefit_program', 'grant'],
    exampleSearchTerms: ['childcare subsidy program', 'Head Start enrollment', 'childcare assistance', 'CCAP'],
    scoringHints: 'Requires children in household; boosted by low income and single-parent indicators.',
    fundability: 'mixed',
  }],

  ['transportation_support', {
    code: 'transportation_support',
    description: 'Vehicle repair assistance, bus passes, transportation subsidies.',
    synonyms: ['car repair help', 'bus pass', 'transit assistance', 'transportation voucher', 'vehicle assistance'],
    relatedEntityTypes: ['individual', 'nonprofit'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'benefit_program'],
    exampleSearchTerms: ['transportation assistance program', 'car repair grant', 'transit subsidy', 'Wheels to Work'],
    scoringHints: 'Strong when transportation barrier is explicitly mentioned.',
    fundability: 'mixed',
  }],

  ['arts_equipment', {
    code: 'arts_equipment',
    description: 'Musical instruments, art supplies, theater equipment for school programs.',
    synonyms: ['instruments', 'band equipment', 'orchestra instruments', 'art supplies', 'music equipment', 'drama props'],
    relatedEntityTypes: ['school_district', 'nonprofit', 'arts_org'],
    disallowedEntityTypes: ['individual'],
    preferredFundingTypes: ['grant', 'donation'],
    exampleSearchTerms: ['musical instruments grant', 'band equipment grant', 'arts education grant', 'school music program grant'],
    scoringHints: 'Very specific to school music/arts programs.',
    fundability: 'grant',
  }],

  ['athletics_equipment', {
    code: 'athletics_equipment',
    description: 'Sports equipment, uniforms, athletic gear for school programs.',
    synonyms: ['sports equipment', 'athletic gear', 'uniforms', 'sports uniforms', 'gym equipment', 'field equipment'],
    relatedEntityTypes: ['school_district', 'nonprofit', 'youth_org'],
    disallowedEntityTypes: ['individual'],
    preferredFundingTypes: ['grant', 'donation'],
    exampleSearchTerms: ['sports equipment grant for schools', 'athletic grant', 'youth sports gear donation', 'school athletics grant'],
    scoringHints: 'Strong for school and youth sports programs.',
    fundability: 'grant',
  }],

  ['workforce_development', {
    code: 'workforce_development',
    description: 'Career readiness, apprenticeships, job placement, and workforce programs.',
    synonyms: ['workforce training', 'apprenticeship', 'job placement', 'career readiness', 'WIOA', 'workforce board'],
    relatedEntityTypes: ['individual', 'nonprofit', 'workforce_board', 'community_action_agency'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant'],
    exampleSearchTerms: ['workforce development grant', 'WIOA training', 'apprenticeship program', 'career training grant'],
    scoringHints: 'Strong for unemployed or underemployed individuals seeking training.',
    fundability: 'grant',
  }],

  ['research_funding', {
    code: 'research_funding',
    description: 'Research grants, academic funding, lab equipment, and study funding.',
    synonyms: ['research grant', 'academic research', 'laboratory funding', 'NIH grant', 'NSF grant', 'study grant'],
    relatedEntityTypes: ['university', 'research_institute', 'hospital', 'nonprofit'],
    disallowedEntityTypes: ['individual', 'local_government', 'for_profit_business'],
    preferredFundingTypes: ['grant'],
    exampleSearchTerms: ['NIH research grant', 'NSF grant', 'academic research funding', 'university research grant'],
    scoringHints: 'Almost exclusively for institutional entities with research capacity.',
    fundability: 'grant',
  }],

  ['environmental_projects', {
    code: 'environmental_projects',
    description: 'Conservation, cleanup, environmental remediation, and green projects.',
    synonyms: ['conservation', 'environmental cleanup', 'remediation', 'green project', 'carbon reduction', 'sustainability'],
    relatedEntityTypes: ['nonprofit', 'local_government', 'tribal_government', 'environmental_org'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant'],
    exampleSearchTerms: ['environmental grant', 'conservation grant', 'EPA grant', 'clean water grant'],
    scoringHints: 'Strong for environmental nonprofits and tribal governments.',
    fundability: 'grant',
  }],

  ['public_safety_equipment', {
    code: 'public_safety_equipment',
    description: 'Emergency communications, defibrillators, rescue equipment, and public safety gear.',
    synonyms: ['AED', 'defibrillator', 'radio', 'communications equipment', 'rescue equipment', 'SCBA', 'public safety gear'],
    relatedEntityTypes: ['volunteer_fire_dept', 'local_government', 'tribal_government', 'nonprofit'],
    disallowedEntityTypes: ['individual', 'for_profit_business'],
    preferredFundingTypes: ['grant'],
    exampleSearchTerms: ['AFG grant', 'FEMA public safety grant', 'defibrillator grant', 'fire department communications grant'],
    scoringHints: 'Highest signal for volunteer fire, EMS, and public safety organizations.',
    fundability: 'grant',
  }],

  ['disaster_recovery', {
    code: 'disaster_recovery',
    description: 'Disaster recovery, FEMA assistance, emergency infrastructure repair.',
    synonyms: ['disaster relief', 'FEMA', 'flood recovery', 'tornado recovery', 'disaster assistance', 'emergency infrastructure'],
    relatedEntityTypes: ['individual', 'local_government', 'nonprofit', 'tribal_government'],
    disallowedEntityTypes: [],
    preferredFundingTypes: ['grant', 'benefit_program'],
    exampleSearchTerms: ['FEMA disaster assistance', 'disaster recovery grant', 'flood relief program'],
    scoringHints: 'Requires active disaster declaration or recent disaster event.',
    fundability: 'grant',
  }],

  ['community_outreach', {
    code: 'community_outreach',
    description: 'Community programs, outreach activities, and social services delivery.',
    synonyms: ['community programs', 'outreach', 'social services', 'community engagement', 'neighborhood services'],
    relatedEntityTypes: ['church', 'nonprofit', 'community_action_agency'],
    disallowedEntityTypes: ['individual'],
    preferredFundingTypes: ['grant', 'donor'],
    exampleSearchTerms: ['community outreach grant', 'social services grant', 'neighborhood program funding'],
    scoringHints: 'Broad category; most effective when combined with a specific program type.',
    fundability: 'grant',
  }],

  ['donor_support_private', {
    code: 'donor_support_private',
    description: 'Private donations, individual giving, and donor development.',
    synonyms: ['individual donors', 'private donations', 'fundraising', 'donor campaign', 'charitable giving'],
    relatedEntityTypes: ['church', 'nonprofit'],
    disallowedEntityTypes: ['individual', 'local_government'],
    preferredFundingTypes: ['donor'],
    exampleSearchTerms: ['nonprofit fundraising', 'donor campaign', 'charitable giving program'],
    scoringHints: 'Not a grant; represents private donor development strategy.',
    fundability: 'donor',
  }],

  ['denomination_support', {
    code: 'denomination_support',
    description: 'Denominational grants, judicatory support, and faith-based network funding.',
    synonyms: ['denomination grant', 'diocese support', 'synod grant', 'judicatory funding', 'faith network grant'],
    relatedEntityTypes: ['church'],
    disallowedEntityTypes: ['individual', 'local_government', 'for_profit_business'],
    preferredFundingTypes: ['grant', 'donor'],
    exampleSearchTerms: ['denomination capital grant', 'church synod building grant', 'diocese support fund', 'Baptist convention grant'],
    scoringHints: 'Exclusive to faith-based entities; requires denominational affiliation.',
    fundability: 'grant',
  }],

  ['capital_campaign', {
    code: 'capital_campaign',
    description: 'Major capital campaigns for construction, renovation, or significant expansion.',
    synonyms: ['capital campaign', 'building fund', 'capital project', 'major renovation', 'construction fund'],
    relatedEntityTypes: ['church', 'nonprofit', 'school_district'],
    disallowedEntityTypes: ['individual'],
    preferredFundingTypes: ['grant', 'donor'],
    exampleSearchTerms: ['capital campaign support', 'building campaign grant', 'major capital grant nonprofit'],
    scoringHints: 'Requires significant proposed capital project; boosted by matching funds language.',
    fundability: 'mixed',
  }],

  ['matching_funds_needed', {
    code: 'matching_funds_needed',
    description: 'Need for matching funds to unlock a grant or larger funding opportunity.',
    synonyms: ['matching funds', 'match requirement', 'cost share', 'in-kind match', 'local match'],
    relatedEntityTypes: ['nonprofit', 'local_government', 'church', 'school_district'],
    disallowedEntityTypes: ['individual'],
    preferredFundingTypes: ['donor', 'grant'],
    exampleSearchTerms: ['matching grant program', 'local match assistance', 'cost-share grant'],
    scoringHints: 'Secondary need; usually appears alongside a primary need code.',
    fundability: 'donor',
  }],

])

/**
 * Look up a need by code.
 * @param {string} code
 * @returns {Object|null}
 */
export function getNeed(code) {
  return NEEDS_TAXONOMY.get(code) ?? null
}

/**
 * Get all need codes.
 * @returns {string[]}
 */
export function getAllNeedCodes() {
  return Array.from(NEEDS_TAXONOMY.keys())
}

/**
 * Check if a need code exists in the taxonomy.
 * @param {string} code
 * @returns {boolean}
 */
export function isValidNeedCode(code) {
  return NEEDS_TAXONOMY.has(code)
}

/**
 * Get needs that are valid for a given entity type.
 * @param {string} entityType
 * @returns {Object[]}
 */
export function getNeedsForEntityType(entityType) {
  const results = []
  for (const need of NEEDS_TAXONOMY.values()) {
    const disallowed = need.disallowedEntityTypes ?? []
    const related = need.relatedEntityTypes ?? []
    if (!disallowed.includes(entityType) && related.includes(entityType)) {
      results.push(need)
    }
  }
  return results
}

export default {
  TAXONOMY_VERSION,
  NEEDS_TAXONOMY,
  getNeed,
  getAllNeedCodes,
  isValidNeedCode,
  getNeedsForEntityType,
}
