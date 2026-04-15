/**
 * Needs Taxonomy — Universal, versioned, centralized
 *
 * Defines all recognized need types, their metadata, synonyms, eligible
 * entity types, funding categories, and search hints.
 *
 * TAXONOMY_VERSION should be bumped whenever need codes change structurally.
 */

export const TAXONOMY_VERSION = '1.0.0'

/**
 * Funding category constants — used in "fundable_by" arrays.
 */
export const FUNDING_CATEGORY = {
  GRANT: 'grant',
  DONOR: 'donor',
  REBATE: 'rebate',
  CONTRACT: 'contract',
  SCHOLARSHIP: 'scholarship',
  LOAN: 'loan',
  OFTEN_NOT_FUNDABLE: 'often_not_fundable',
}

/**
 * Entity type constants used in eligible/disallowed lists.
 */
export const ENTITY_TYPE = {
  INDIVIDUAL: 'individual',
  NONPROFIT: 'nonprofit',
  CHURCH: 'church',
  SCHOOL: 'school',
  COLLEGE: 'college',
  FIRE_EMS: 'fire_ems',
  GOVERNMENT: 'government',
  TRIBAL: 'tribal',
  BUSINESS: 'business',
  HOSPITAL: 'hospital',
  HOUSING_AUTHORITY: 'housing_authority',
  COMMUNITY_ACTION: 'community_action',
  CDFI: 'cdfi',
  LIBRARY: 'library',
  FAITH_BASED: 'faith_based',
}

/**
 * The universal needs taxonomy.
 * Key: canonical need code (snake_case).
 * Value: NeedDefinition object.
 *
 * @typedef {Object} NeedDefinition
 * @property {string} code - Canonical need code
 * @property {string} label - Human-readable label
 * @property {string} description - What this need represents
 * @property {string[]} synonyms - Alternative names / keywords that map to this need
 * @property {string[]} related_entity_types - Entity types commonly associated with this need
 * @property {string[]} disallowed_entity_types - Entity types that cannot have this need
 * @property {string[]} funding_categories - How this is typically funded
 * @property {string[]} example_search_terms - Example search queries for this need
 * @property {string} scoring_hint - How to weight this in scoring
 * @property {boolean} is_capital - Whether this involves capital/physical assets
 * @property {boolean} is_operational - Whether this is operational/program cost
 */

export const NEEDS_TAXONOMY = {
  // ── Physical Infrastructure & Facilities ──────────────────────────────────
  facilities_repair: {
    code: 'facilities_repair',
    label: 'Facilities Repair & Maintenance',
    description: 'Repair, renovation, or maintenance of physical buildings or infrastructure',
    synonyms: [
      'building repair', 'roof repair', 'renovation', 'structural repair',
      'maintenance', 'facility improvement', 'rehab', 'building restoration',
    ],
    related_entity_types: [ENTITY_TYPE.CHURCH, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.SCHOOL,
      ENTITY_TYPE.FIRE_EMS, ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.TRIBAL, ENTITY_TYPE.LIBRARY],
    disallowed_entity_types: [ENTITY_TYPE.INDIVIDUAL],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'facility repair grant', 'building renovation grant nonprofit',
      'historic preservation grant', 'community facility improvement',
    ],
    scoring_hint: 'high_weight_for_org_profiles',
    is_capital: true,
    is_operational: false,
  },

  facilities_preservation: {
    code: 'facilities_preservation',
    label: 'Historic / Cultural Preservation',
    description: 'Preservation of historic or culturally significant buildings or sites',
    synonyms: [
      'historic preservation', 'heritage preservation', 'landmark preservation',
      'cultural preservation', 'architectural preservation',
    ],
    related_entity_types: [ENTITY_TYPE.CHURCH, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.GOVERNMENT,
      ENTITY_TYPE.TRIBAL],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'historic preservation grant', 'heritage building grant', 'cultural preservation funding',
    ],
    scoring_hint: 'requires_historic_designation_flag',
    is_capital: true,
    is_operational: false,
  },

  accessibility_upgrades: {
    code: 'accessibility_upgrades',
    label: 'ADA / Accessibility Upgrades',
    description: 'Making facilities accessible for people with disabilities (ADA compliance, ramps, lifts)',
    synonyms: [
      'ADA compliance', 'accessibility improvements', 'wheelchair access', 'ramp installation',
      'elevator', 'lift', 'disability access',
    ],
    related_entity_types: [ENTITY_TYPE.CHURCH, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.SCHOOL,
      ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.HOSPITAL, ENTITY_TYPE.LIBRARY],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.REBATE],
    example_search_terms: [
      'ADA compliance grant', 'accessibility improvement grant', 'disability access funding',
    ],
    scoring_hint: 'boost_for_old_buildings',
    is_capital: true,
    is_operational: false,
  },

  safety_upgrades: {
    code: 'safety_upgrades',
    label: 'Safety & Security Upgrades',
    description: 'Physical security improvements, fire safety, alarm systems, surveillance',
    synonyms: [
      'security system', 'fire suppression', 'alarm system', 'safety improvements',
      'security cameras', 'access control', 'emergency lighting',
    ],
    related_entity_types: [ENTITY_TYPE.CHURCH, ENTITY_TYPE.SCHOOL, ENTITY_TYPE.NONPROFIT,
      ENTITY_TYPE.GOVERNMENT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'school safety grant', 'nonprofit security grant', 'building safety improvement',
    ],
    scoring_hint: 'standard',
    is_capital: true,
    is_operational: false,
  },

  utilities_support: {
    code: 'utilities_support',
    label: 'Utilities Assistance',
    description: 'Help paying electric, gas, water, or heating/cooling bills',
    synonyms: [
      'utility assistance', 'electric bill help', 'heating assistance', 'LIHEAP',
      'energy assistance', 'water bill', 'utility relief',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.CHURCH, ENTITY_TYPE.NONPROFIT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.REBATE],
    example_search_terms: [
      'LIHEAP utility assistance', 'energy assistance program', 'utility bill help',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  energy_efficiency: {
    code: 'energy_efficiency',
    label: 'Energy Efficiency / Weatherization',
    description: 'Weatherization, insulation, energy-efficient upgrades to reduce utility costs',
    synonyms: [
      'weatherization', 'insulation', 'energy efficiency', 'solar panels', 'HVAC upgrade',
      'energy audit', 'heat pump',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.CHURCH,
      ENTITY_TYPE.SCHOOL, ENTITY_TYPE.GOVERNMENT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.REBATE],
    example_search_terms: [
      'weatherization grant', 'energy efficiency rebate', 'home energy assistance',
    ],
    scoring_hint: 'standard',
    is_capital: true,
    is_operational: false,
  },

  technology: {
    code: 'technology',
    label: 'Technology / IT Equipment',
    description: 'Computers, software, IT infrastructure, technology upgrades',
    synonyms: [
      'computers', 'IT equipment', 'software', 'hardware', 'technology upgrade',
      'digital tools', 'tablets', 'chromebooks',
    ],
    related_entity_types: [ENTITY_TYPE.SCHOOL, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.CHURCH,
      ENTITY_TYPE.LIBRARY, ENTITY_TYPE.GOVERNMENT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'technology grant school', 'nonprofit technology grant', 'computer equipment donation',
    ],
    scoring_hint: 'standard',
    is_capital: true,
    is_operational: false,
  },

  broadband: {
    code: 'broadband',
    label: 'Broadband / Internet Access',
    description: 'Expanding or improving internet connectivity, broadband infrastructure',
    synonyms: [
      'broadband', 'internet access', 'connectivity', 'digital divide', 'WiFi', 'hotspot',
    ],
    related_entity_types: [ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.TRIBAL, ENTITY_TYPE.NONPROFIT,
      ENTITY_TYPE.SCHOOL, ENTITY_TYPE.LIBRARY, ENTITY_TYPE.INDIVIDUAL],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'broadband expansion grant', 'rural internet connectivity funding', 'digital equity grant',
    ],
    scoring_hint: 'boost_for_rural',
    is_capital: true,
    is_operational: false,
  },

  vehicles: {
    code: 'vehicles',
    label: 'Vehicles / Fleet',
    description: 'Purchasing or replacing vehicles (fire trucks, ambulances, vans, buses)',
    synonyms: [
      'fire truck', 'ambulance', 'van', 'bus', 'vehicle replacement', 'fleet', 'apparatus',
      'engine', 'tanker truck',
    ],
    related_entity_types: [ENTITY_TYPE.FIRE_EMS, ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.NONPROFIT,
      ENTITY_TYPE.SCHOOL],
    disallowed_entity_types: [ENTITY_TYPE.INDIVIDUAL],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'fire truck grant', 'ambulance replacement grant', 'nonprofit van grant',
    ],
    scoring_hint: 'high_weight_for_fire_ems',
    is_capital: true,
    is_operational: false,
  },

  equipment: {
    code: 'equipment',
    label: 'Equipment / Tools',
    description: 'General equipment purchases or upgrades for operations',
    synonyms: [
      'equipment purchase', 'tools', 'machinery', 'appliances', 'general equipment',
    ],
    related_entity_types: [ENTITY_TYPE.FIRE_EMS, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.SCHOOL,
      ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.BUSINESS],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'equipment grant nonprofit', 'fire department equipment funding',
    ],
    scoring_hint: 'standard',
    is_capital: true,
    is_operational: false,
  },

  ppe: {
    code: 'ppe',
    label: 'Personal Protective Equipment (PPE)',
    description: 'Protective gear for first responders, healthcare workers, or others',
    synonyms: [
      'PPE', 'turnout gear', 'protective equipment', 'safety gear', 'body armor',
      'helmet', 'SCBA', 'self-contained breathing apparatus',
    ],
    related_entity_types: [ENTITY_TYPE.FIRE_EMS, ENTITY_TYPE.HOSPITAL, ENTITY_TYPE.GOVERNMENT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'PPE grant fire department', 'turnout gear grant', 'first responder equipment grant',
    ],
    scoring_hint: 'high_weight_for_fire_ems',
    is_capital: true,
    is_operational: false,
  },

  training: {
    code: 'training',
    label: 'Training & Professional Development',
    description: 'Training programs, certifications, professional development for staff or volunteers',
    synonyms: [
      'training', 'professional development', 'certification', 'continuing education',
      'workshops', 'skills training', 'first aid training', 'fire training',
    ],
    related_entity_types: [ENTITY_TYPE.FIRE_EMS, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.SCHOOL,
      ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.HOSPITAL, ENTITY_TYPE.INDIVIDUAL],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.SCHOLARSHIP],
    example_search_terms: [
      'firefighter training grant', 'staff training grant', 'professional development funding',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  staffing_salary: {
    code: 'staffing_salary',
    label: 'Staffing / Salary Support',
    description: 'Funding to hire or retain staff, pay salaries, or support volunteers',
    synonyms: [
      'salary support', 'staffing grant', 'personnel costs', 'hiring grant',
      'volunteer support', 'AmeriCorps', 'COPS grant', 'SAFER grant',
    ],
    related_entity_types: [ENTITY_TYPE.FIRE_EMS, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.SCHOOL,
      ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.CHURCH],
    disallowed_entity_types: [ENTITY_TYPE.INDIVIDUAL],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'SAFER grant fire department', 'staffing grant nonprofit', 'salary support grant',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  program_operations: {
    code: 'program_operations',
    label: 'Program / Operations Support',
    description: 'General operating support, programming costs, administrative overhead',
    synonyms: [
      'operating support', 'program funding', 'general support', 'overhead',
      'capacity building', 'sustaining operations',
    ],
    related_entity_types: [ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.CHURCH, ENTITY_TYPE.SCHOOL,
      ENTITY_TYPE.COMMUNITY_ACTION],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'general operating support grant', 'nonprofit capacity building',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  food_programs: {
    code: 'food_programs',
    label: 'Food Programs & Nutrition',
    description: 'Food pantries, meal programs, nutrition assistance, food distribution',
    synonyms: [
      'food pantry', 'food bank', 'meal program', 'soup kitchen', 'SNAP', 'WIC',
      'nutrition assistance', 'food distribution', 'hunger relief',
    ],
    related_entity_types: [ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.CHURCH, ENTITY_TYPE.COMMUNITY_ACTION,
      ENTITY_TYPE.INDIVIDUAL],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'food pantry grant', 'hunger relief grant', 'community food program funding',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  housing_support: {
    code: 'housing_support',
    label: 'Housing Support',
    description: 'Emergency housing, rent assistance, mortgage help, homelessness prevention',
    synonyms: [
      'rental assistance', 'rent help', 'mortgage assistance', 'eviction prevention',
      'housing stability', 'homelessness', 'shelter', 'emergency housing',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.HOUSING_AUTHORITY,
      ENTITY_TYPE.COMMUNITY_ACTION],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'rental assistance grant', 'eviction prevention funding', 'emergency housing help',
    ],
    scoring_hint: 'boost_for_hardship',
    is_capital: false,
    is_operational: true,
  },

  health_medical_support: {
    code: 'health_medical_support',
    label: 'Health & Medical Support',
    description: 'Medical bills, prescriptions, health coverage, mental health, dental, vision',
    synonyms: [
      'medical bills', 'prescription assistance', 'health insurance', 'mental health',
      'dental care', 'vision care', 'behavioral health', 'substance abuse treatment',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.HOSPITAL,
      ENTITY_TYPE.COMMUNITY_ACTION],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.SCHOLARSHIP],
    example_search_terms: [
      'medical bill assistance', 'prescription drug assistance', 'mental health funding',
    ],
    scoring_hint: 'boost_for_hardship',
    is_capital: false,
    is_operational: true,
  },

  emergency_assistance: {
    code: 'emergency_assistance',
    label: 'Emergency / Crisis Assistance',
    description: 'One-time emergency financial help for crisis situations',
    synonyms: [
      'emergency assistance', 'crisis help', 'one-time assistance', 'emergency fund',
      'hardship relief', 'disaster relief', 'FEMA assistance',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.COMMUNITY_ACTION],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'emergency assistance grant', 'crisis financial help', 'hardship relief fund',
    ],
    scoring_hint: 'boost_for_hardship',
    is_capital: false,
    is_operational: true,
  },

  scholarships_tuition: {
    code: 'scholarships_tuition',
    label: 'Scholarships & Tuition Assistance',
    description: 'Scholarships, grants for college/vocational education, tuition assistance',
    synonyms: [
      'scholarship', 'scholarships', 'tuition grant', 'tuition assistance',
      'financial aid', 'Pell Grant', 'college funding',
      'vocational scholarship', 'vocational scholarships', 'FAFSA', 'student aid',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.SCHOOL, ENTITY_TYPE.COLLEGE],
    // Churches can offer scholarships through educational ministries, but inference
    // does not infer this by default. Churches may still qualify if explicitly
    // requested via funding_ask or keywords.
    disallowed_entity_types: [ENTITY_TYPE.FIRE_EMS],
    funding_categories: [FUNDING_CATEGORY.SCHOLARSHIP, FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'college scholarship', 'tuition assistance grant', 'first-generation student scholarship',
    ],
    scoring_hint: 'requires_student_flag',
    is_capital: false,
    is_operational: true,
  },

  debt_relief: {
    code: 'debt_relief',
    label: 'Debt Relief / Financial Stability',
    description: 'Help managing debt, financial counseling, credit repair, bankruptcy support',
    synonyms: [
      'debt relief', 'debt management', 'financial counseling', 'credit repair',
      'medical debt forgiveness', 'student loan forgiveness',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL],
    disallowed_entity_types: [],
    // GRANT intentionally excluded: debt relief is almost never funded by grants;
    // listing GRANT here causes crawlers to surface loan products that must be
    // hard-rejected by relevanceFilter (Goal 3). OFTEN_NOT_FUNDABLE signals to
    // the decision engine to apply low_funding_availability logic.
    funding_categories: [FUNDING_CATEGORY.OFTEN_NOT_FUNDABLE],
    example_search_terms: [
      'debt relief program', 'financial counseling assistance',
    ],
    scoring_hint: 'low_funding_availability',
    is_capital: false,
    is_operational: false,
  },

  childcare_support: {
    code: 'childcare_support',
    label: 'Childcare Assistance',
    description: 'Help paying for childcare, daycare subsidies, after-school programs',
    synonyms: [
      'childcare subsidy', 'daycare assistance', 'CCAP', 'child care voucher',
      'after-school care', 'Head Start',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.COMMUNITY_ACTION],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'childcare assistance grant', 'daycare subsidy', 'childcare voucher program',
    ],
    scoring_hint: 'requires_children_flag',
    is_capital: false,
    is_operational: true,
  },

  transportation_support: {
    code: 'transportation_support',
    label: 'Transportation Assistance',
    description: 'Help with car repairs, bus passes, transportation costs',
    synonyms: [
      'car repair assistance', 'transportation voucher', 'bus pass', 'gas assistance',
      'vehicle repair grant', 'rideshare assistance',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'transportation assistance grant', 'car repair help', 'bus pass program',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  arts_equipment: {
    code: 'arts_equipment',
    label: 'Arts / Music / Band Equipment',
    description: 'Musical instruments, art supplies, theater/drama equipment',
    synonyms: [
      'musical instruments', 'band equipment', 'art supplies', 'drama equipment',
      'choir robes', 'orchestra instruments', 'music program',
    ],
    related_entity_types: [ENTITY_TYPE.SCHOOL, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.CHURCH],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'school band instrument grant', 'music program grant', 'arts equipment funding',
    ],
    scoring_hint: 'standard',
    is_capital: true,
    is_operational: false,
  },

  athletics_equipment: {
    code: 'athletics_equipment',
    label: 'Athletics / Sports Equipment',
    description: 'Sports equipment, uniforms, athletic gear for school or community programs',
    synonyms: [
      'sports equipment', 'athletic gear', 'team uniforms', 'football equipment',
      'basketball gear', 'youth sports', 'physical education equipment',
    ],
    related_entity_types: [ENTITY_TYPE.SCHOOL, ENTITY_TYPE.NONPROFIT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'school sports equipment grant', 'youth athletics funding', 'PE equipment grant',
    ],
    scoring_hint: 'standard',
    is_capital: true,
    is_operational: false,
  },

  workforce_development: {
    code: 'workforce_development',
    label: 'Workforce Development',
    description: 'Job training, employment programs, apprenticeships, career development',
    synonyms: [
      'job training', 'workforce training', 'apprenticeship', 'career development',
      'WIOA', 'workforce investment', 'employment program',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.SCHOOL,
      ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.COMMUNITY_ACTION],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.SCHOLARSHIP],
    example_search_terms: [
      'WIOA funding', 'job training grant', 'workforce development program',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  research_funding: {
    code: 'research_funding',
    label: 'Research & Innovation Funding',
    description: 'Grants for academic, scientific, or applied research projects',
    synonyms: [
      'research grant', 'R&D funding', 'SBIR', 'STTR', 'NSF grant', 'NIH grant',
      'clinical research', 'innovation funding',
    ],
    related_entity_types: [ENTITY_TYPE.COLLEGE, ENTITY_TYPE.HOSPITAL, ENTITY_TYPE.NONPROFIT,
      ENTITY_TYPE.BUSINESS],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.CONTRACT],
    example_search_terms: [
      'NIH research grant', 'SBIR grant', 'university research funding',
    ],
    scoring_hint: 'requires_research_capability',
    is_capital: false,
    is_operational: true,
  },

  environmental_projects: {
    code: 'environmental_projects',
    label: 'Environmental / Conservation Projects',
    description: 'Environmental cleanup, conservation, land preservation, sustainability projects',
    synonyms: [
      'environmental grant', 'conservation funding', 'land preservation', 'brownfield cleanup',
      'sustainability project', 'wetlands restoration', 'tree planting',
    ],
    related_entity_types: [ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.TRIBAL],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'environmental grant', 'conservation project funding', 'EPA grant',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  public_safety_equipment: {
    code: 'public_safety_equipment',
    label: 'Public Safety Equipment',
    description: 'Communications, radios, dispatch systems, fire suppression, rescue equipment',
    synonyms: [
      'radio equipment', 'communications equipment', 'dispatch system', 'CAD system',
      'extrication tools', 'jaws of life', 'thermal imaging', 'NFPA compliance',
    ],
    related_entity_types: [ENTITY_TYPE.FIRE_EMS, ENTITY_TYPE.GOVERNMENT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'public safety equipment grant', 'firefighter equipment grant', 'EMS equipment funding',
    ],
    scoring_hint: 'high_weight_for_fire_ems',
    is_capital: true,
    is_operational: false,
  },

  disaster_recovery: {
    code: 'disaster_recovery',
    label: 'Disaster Recovery',
    description: 'Recovery from natural disasters, FEMA assistance, emergency response',
    synonyms: [
      'disaster recovery', 'FEMA grant', 'flood recovery', 'hurricane recovery',
      'tornado recovery', 'wildfire recovery', 'disaster relief',
    ],
    related_entity_types: [ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.NONPROFIT,
      ENTITY_TYPE.CHURCH],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'FEMA disaster recovery', 'flood recovery grant', 'disaster relief funding',
    ],
    scoring_hint: 'requires_disaster_context',
    is_capital: false,
    is_operational: true,
  },

  community_outreach: {
    code: 'community_outreach',
    label: 'Community Outreach & Engagement',
    description: 'Programs to engage, serve, or connect the community',
    synonyms: [
      'community outreach', 'community engagement', 'community programs', 'community service',
      'neighborhood programs', 'community events',
    ],
    related_entity_types: [ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.CHURCH, ENTITY_TYPE.GOVERNMENT,
      ENTITY_TYPE.COMMUNITY_ACTION],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'community outreach grant', 'neighborhood improvement grant', 'community engagement funding',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: true,
  },

  donor_support_private: {
    code: 'donor_support_private',
    label: 'Private Donor / Individual Fundraising',
    description: 'Individual donor campaigns, fundraising drives, crowdfunding',
    synonyms: [
      'fundraising', 'donor campaign', 'crowdfunding', 'GoFundMe', 'capital campaign support',
      'major gifts', 'donor stewardship',
    ],
    related_entity_types: [ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.CHURCH, ENTITY_TYPE.INDIVIDUAL],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'nonprofit fundraising', 'church fundraising ideas', 'donor campaign resources',
    ],
    scoring_hint: 'low_grant_weight',
    is_capital: false,
    is_operational: false,
  },

  denomination_support: {
    code: 'denomination_support',
    label: 'Denominational / Judicatory Support',
    description: 'Funding from parent church organization, diocese, synod, or denomination',
    synonyms: [
      'denominational grant', 'diocese grant', 'synod grant', 'presbytery grant',
      'judicatory support', 'conference grant', 'bishop fund',
    ],
    related_entity_types: [ENTITY_TYPE.CHURCH, ENTITY_TYPE.FAITH_BASED],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.DONOR, FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'church denomination grant', 'diocese building fund', 'synod grant application',
    ],
    scoring_hint: 'church_specific',
    is_capital: false,
    is_operational: false,
  },

  capital_campaign: {
    code: 'capital_campaign',
    label: 'Capital Campaign',
    description: 'Organized fundraising drive for major capital projects',
    synonyms: [
      'capital campaign', 'building campaign', 'capital fund drive', 'endowment campaign',
    ],
    related_entity_types: [ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.CHURCH, ENTITY_TYPE.SCHOOL,
      ENTITY_TYPE.HOSPITAL],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.DONOR, FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'church capital campaign', 'nonprofit building campaign', 'capital project fundraising',
    ],
    scoring_hint: 'standard',
    is_capital: true,
    is_operational: false,
  },

  matching_funds_needed: {
    code: 'matching_funds_needed',
    label: 'Matching Funds / Cost Share',
    description: 'Seeking matching funds to qualify for a grant or meet a cost-share requirement',
    synonyms: [
      'matching funds', 'cost share', 'match requirement', 'in-kind match', 'cash match',
    ],
    related_entity_types: [ENTITY_TYPE.NONPROFIT, ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.CHURCH,
      ENTITY_TYPE.SCHOOL],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'matching grant', 'cost share grant', 'matching funds program',
    ],
    scoring_hint: 'standard',
    is_capital: false,
    is_operational: false,
  },

  business_startup: {
    code: 'business_startup',
    label: 'Business Startup / Seed Capital',
    description: 'Startup funding, microloans, seed capital, and small business grants for new ventures',
    synonyms: [
      'startup funding', 'seed capital', 'microloan', 'small business grant',
      'SBA loan', 'business start', 'new business', 'entrepreneurship',
      'small business', 'venture capital', 'business plan', 'startup grant',
    ],
    related_entity_types: [ENTITY_TYPE.BUSINESS, ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.LOAN],
    example_search_terms: [
      'small business startup grant', 'SBA microloan', 'entrepreneur grant',
      'minority business grant', 'women business grant',
    ],
    scoring_hint: 'requires_business_intent',
    is_capital: true,
    is_operational: false,
  },

  business_licensing: {
    code: 'business_licensing',
    label: 'Licenses, Permits & Certifications',
    description: 'Business licenses, health permits, food handler certs, professional certifications needed to operate',
    synonyms: [
      'business license', 'health permit', 'food handler', 'food handler certification',
      'professional license', 'occupational license', 'permit fees',
      'zoning permit', 'fire inspection', 'commercial permit',
    ],
    related_entity_types: [ENTITY_TYPE.BUSINESS, ENTITY_TYPE.INDIVIDUAL, ENTITY_TYPE.NONPROFIT],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.OFTEN_NOT_FUNDABLE, FUNDING_CATEGORY.GRANT],
    example_search_terms: [
      'small business license assistance', 'permit fee grant', 'business certification help',
    ],
    scoring_hint: 'low_funding_availability',
    is_capital: false,
    is_operational: true,
  },

  business_insurance: {
    code: 'business_insurance',
    label: 'Business Insurance',
    description: 'Liability insurance, commercial auto, workers comp, and other business coverage',
    synonyms: [
      'liability insurance', 'commercial insurance', 'business insurance',
      'workers compensation', 'commercial auto insurance', 'general liability',
    ],
    related_entity_types: [ENTITY_TYPE.BUSINESS, ENTITY_TYPE.NONPROFIT],
    disallowed_entity_types: [ENTITY_TYPE.INDIVIDUAL],
    funding_categories: [FUNDING_CATEGORY.OFTEN_NOT_FUNDABLE],
    example_search_terms: [
      'small business insurance assistance', 'nonprofit insurance grant',
    ],
    scoring_hint: 'low_funding_availability',
    is_capital: false,
    is_operational: true,
  },

  stem_education: {
    code: 'stem_education',
    label: 'STEM / Computer Science Education',
    description: 'Science, technology, engineering, and math education programs, labs, and curriculum',
    synonyms: [
      'STEM', 'science lab', 'robotics', 'coding class', 'computer science', 'math program',
      'engineering education', 'maker space', 'science education',
    ],
    related_entity_types: [ENTITY_TYPE.SCHOOL, ENTITY_TYPE.COLLEGE, ENTITY_TYPE.NONPROFIT,
      ENTITY_TYPE.LIBRARY],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: [
      'STEM education grant', 'school science lab funding', 'robotics program grant',
    ],
    scoring_hint: 'standard',
    is_capital: true,
    is_operational: true,
  },
}

/**
 * Get a need definition by code.
 * Returns null if not found.
 */
export function getNeedDefinition(code) {
  return NEEDS_TAXONOMY[code] ?? null
}

/**
 * Get all defined need codes.
 */
export function getAllNeedCodes() {
  return Object.keys(NEEDS_TAXONOMY)
}

/**
 * Look up the canonical need code from a synonym/alias string.
 * Returns the code if found, null otherwise.
 * Prefers longer (more specific) synonym matches over shorter ones.
 */
export function resolveNeedFromSynonym(text) {
  if (!text) return null
  const lower = String(text).toLowerCase().trim()

  let bestCode = null
  let bestMatchLength = 0

  for (const [code, def] of Object.entries(NEEDS_TAXONOMY)) {
    // Exact code match
    if (lower === code) return code

    // Check synonyms — prefer longer matches (more specific)
    for (const s of def.synonyms) {
      const sl = s.toLowerCase()
      // Use word-boundary-aware matching: check both directions so that
      // a short synonym 'van' doesn't match inside 'advantage', and a
      // multi-word synonym 'cargo van' still matches input 'cargo van'.
      const inputContainsSynonym = new RegExp(`(?<![a-z0-9])${sl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(lower)
      const synonymContainsInput = sl === lower
      if ((inputContainsSynonym || synonymContainsInput) && sl.length > bestMatchLength) {
        bestMatchLength = sl.length
        bestCode = code
      }
    }

    // Check label match with word-boundary guard
    const labelLower = def.label.toLowerCase()
    const labelRegex = new RegExp(`(?<![a-z0-9])${labelLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`)
    if (labelRegex.test(lower) && labelLower.length > bestMatchLength) {
      bestMatchLength = labelLower.length
      bestCode = code
    }
  }

  return bestCode
}

/**
 * Get needs applicable to an entity type.
 */
// Entity type aliases: types that should inherit needs from a parent type
const ENTITY_TYPE_ALIASES = {
  [ENTITY_TYPE.FAITH_BASED]: [ENTITY_TYPE.CHURCH, ENTITY_TYPE.NONPROFIT],
  [ENTITY_TYPE.COLLEGE]: [ENTITY_TYPE.SCHOOL],
  [ENTITY_TYPE.COMMUNITY_ACTION]: [ENTITY_TYPE.NONPROFIT],
  [ENTITY_TYPE.HOUSING_AUTHORITY]: [ENTITY_TYPE.GOVERNMENT, ENTITY_TYPE.NONPROFIT],
  [ENTITY_TYPE.CDFI]: [ENTITY_TYPE.NONPROFIT],
}

export function getNeedsForEntityType(entityType) {
  const results = []
  // Build the set of types to check (the entity type itself plus any aliased parent types)
  const typesToCheck = new Set([entityType, ...(ENTITY_TYPE_ALIASES[entityType] || [])])
  for (const def of Object.values(NEEDS_TAXONOMY)) {
    if (def.disallowed_entity_types.includes(entityType)) continue
    const isRelated = [...typesToCheck].some(t => def.related_entity_types.includes(t))
    if (isRelated) results.push(def.code)
  }
  return results
}
