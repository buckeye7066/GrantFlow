/**
 * profileFieldUsageRegistry.js
 *
 * GrantFlow Mission Goal 11 — Field-to-Funding Accountability.
 *
 * The single canonical, machine-readable contract for every profile field
 * GrantFlow asks the user for. A field is *only* allowed to live in the
 * application form when it has an entry here that proves it earns its
 * place by serving at least one of these usage modes:
 *
 *   profile_understanding   identifies who the user is / what kind of profile
 *   source_planning         picks crawlers / databases / portals to search
 *   crawler_query           contributes to search terms / filters / locations
 *   match_scoring           changes eligibility score or relevance
 *   explanation             helps explain why a result appeared
 *   workflow                drives application steps, deadlines, doc checklists
 *   anya_guidance           helps Anya explain profile / results / next action
 *
 * Sensitive identifiers (SSN, Green Card, Medicaid ID, detailed medical
 * identifiers) MUST set `pii: true` and `raw_external_use_allowed: false`,
 * which the mission test verifies by walking every field and asserting
 * that no PII identifier ever lands in a crawler query term.
 *
 * Pure / data-driven: no DB, no network, no I/O. Safe to import anywhere.
 *
 * Usage:
 *
 *   import { getFieldUsage, listFieldUsages, isPii, forSourceCategory,
 *            buildFieldUsageReport } from './profileFieldUsageRegistry.js'
 *
 *   getFieldUsage('organization.uei')       // { id, label, pii, usage_modes, ... }
 *   forSourceCategory('grants_gov')         // [ ...field entries that route here ]
 *   isPii('basic_information.ssn')          // true
 *   buildFieldUsageReport()                 // mission-health-friendly summary
 */

import { SOURCE_IDS, SOURCES } from './sourceRegistry.js'

const VALID_USAGE_MODES = Object.freeze([
  'profile_understanding',
  'source_planning',
  'crawler_query',
  'match_scoring',
  'explanation',
  'workflow',
  'anya_guidance',
])

const VALID_SECTIONS = Object.freeze([
  'basic_information',
  'organization_details',
  'nonprofit_compliance',
  'location_focus',
  'education',
  'financial_information',
  'government_assistance',
  'health_medical',
  'demographics',
  'family_life',
  'military_service',
  'occupation',
  'narrative',
  'pii',
])

/**
 * Helper: build a uniform entry. Defaults make the common case (a non-PII
 * boost field used in source planning + match scoring + explanation)
 * one line per field instead of seven.
 */
function field({
  id,
  label,
  section,
  pii = false,
  raw_external_use_allowed = !pii,
  usage_modes = ['profile_understanding'],
  source_categories = [],
  query_use = null, // 'required' | 'required_or' | 'boost' | 'must_not' | null
  match_reason = null,
  why_we_ask,
  applies_to_profile_types = null,
}) {
  return Object.freeze({
    id,
    label,
    section,
    pii,
    raw_external_use_allowed,
    usage_modes: Object.freeze([...usage_modes]),
    source_categories: Object.freeze([...source_categories]),
    query_use,
    match_reason,
    why_we_ask,
    applies_to_profile_types: applies_to_profile_types
      ? Object.freeze([...applies_to_profile_types])
      : null,
  })
}

/**
 * The registry. Order is grouped by section so this file is auditable
 * top-to-bottom by a non-engineer.
 */
const ENTRIES = [
  // ────────────────────────────────────────────────────────────────────
  // Basic information & identity
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'profile.primary_profile_type',
    label: 'Primary profile type',
    section: 'basic_information',
    usage_modes: ['profile_understanding', 'source_planning', 'crawler_query',
      'match_scoring', 'explanation', 'workflow', 'anya_guidance'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.STATE_PORTAL],
    query_use: 'required',
    match_reason: 'Primary profile type controls the entire source plan and the matching strategy.',
    why_we_ask: 'This tells GrantFlow what kind of profile you are so we can search the right kinds of funding for you.',
  }),
  field({
    id: 'basic_information.first_name',
    label: 'First name',
    section: 'basic_information',
    usage_modes: ['workflow', 'anya_guidance'],
    why_we_ask: 'Used on application drafts and to personalize Anya. Never sent to crawlers.',
  }),
  field({
    id: 'basic_information.last_name',
    label: 'Last name',
    section: 'basic_information',
    usage_modes: ['workflow', 'anya_guidance'],
    why_we_ask: 'Used on application drafts and to personalize Anya. Never sent to crawlers.',
  }),
  field({
    id: 'contact.email',
    label: 'Email address',
    section: 'basic_information',
    usage_modes: ['workflow', 'anya_guidance'],
    why_we_ask: 'Used to contact you about deadlines and applications. Never sent to crawlers.',
  }),
  field({
    id: 'contact.phone',
    label: 'Phone number',
    section: 'basic_information',
    usage_modes: ['workflow'],
    why_we_ask: 'Used for application contact info. Never sent to crawlers.',
  }),
  field({
    id: 'basic_information.dob',
    label: 'Date of birth',
    section: 'basic_information',
    usage_modes: ['profile_understanding', 'match_scoring', 'workflow'],
    match_reason: 'Age determines eligibility for senior, youth, FAFSA, and student aid programs.',
    why_we_ask: 'Used to check age-based eligibility (senior, youth, student) and FAFSA forms. We do not send your date of birth to crawlers.',
  }),

  // ── PII identifiers — local readiness only, NEVER external query ──
  field({
    id: 'pii.ssn',
    label: 'Social Security Number',
    section: 'pii',
    pii: true,
    raw_external_use_allowed: false,
    usage_modes: ['workflow'],
    query_use: 'must_not',
    why_we_ask: 'Some applications require it. GrantFlow stores only a masked last-four locally and NEVER sends your SSN to crawlers or search engines.',
  }),
  field({
    id: 'pii.green_card_number',
    label: 'Green Card number',
    section: 'pii',
    pii: true,
    raw_external_use_allowed: false,
    usage_modes: ['workflow'],
    query_use: 'must_not',
    why_we_ask: 'Some applications require it for residency proof. GrantFlow never sends Green Card numbers externally.',
  }),
  field({
    id: 'pii.medicaid_id',
    label: 'Medicaid / TennCare ID',
    section: 'pii',
    pii: true,
    raw_external_use_allowed: false,
    usage_modes: ['workflow'],
    query_use: 'must_not',
    why_we_ask: 'Some benefits applications need this. GrantFlow stores only a masked last-four locally and NEVER sends your Medicaid ID externally.',
  }),
  field({
    id: 'pii.immigration_document_number',
    label: 'Immigration document number',
    section: 'pii',
    pii: true,
    raw_external_use_allowed: false,
    usage_modes: ['workflow'],
    query_use: 'must_not',
    why_we_ask: 'Application readiness only. GrantFlow never sends immigration document numbers to crawlers.',
  }),
  field({
    id: 'pii.medical_record_identifier',
    label: 'Detailed medical identifier (e.g., MRN, prescription #)',
    section: 'pii',
    pii: true,
    raw_external_use_allowed: false,
    usage_modes: ['workflow'],
    query_use: 'must_not',
    why_we_ask: 'Application readiness for patient-assistance forms. Detailed medical identifiers are never sent to crawlers.',
  }),
  field({
    id: 'pii.driver_license_number',
    label: 'Driver license number',
    section: 'pii',
    pii: true,
    raw_external_use_allowed: false,
    usage_modes: ['workflow'],
    query_use: 'must_not',
    why_we_ask: 'Some applications require ID. We never send license numbers to crawlers.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Location / geography
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'geo.state',
    label: 'State',
    section: 'location_focus',
    usage_modes: ['profile_understanding', 'source_planning', 'crawler_query',
      'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.STATE_PORTAL, SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS,
      SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION, SOURCE_IDS.STATE_EMERGENCY_MANAGEMENT],
    query_use: 'required_or',
    match_reason: 'State is required to surface state-portal funding and to filter out wrong-state programs.',
    why_we_ask: 'Funding is often state-specific. We need state to find programs you can actually apply to.',
  }),
  field({
    id: 'geo.county',
    label: 'County',
    section: 'location_focus',
    usage_modes: ['profile_understanding', 'source_planning', 'crawler_query',
      'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.STATE_COUNTY_GRANT_PORTALS, SOURCE_IDS.COMMUNITY_ACTION,
      SOURCE_IDS.UNITED_WAY_211, SOURCE_IDS.COF_FOUNDATION_LOCATOR],
    query_use: 'boost',
    match_reason: 'County unlocks county-level grants, community foundations, regional commissions, and local assistance.',
    why_we_ask: 'County matters for community foundations, county grants, and local assistance — many programs only fund one county.',
  }),
  field({
    id: 'geo.city',
    label: 'City',
    section: 'location_focus',
    usage_modes: ['profile_understanding', 'source_planning', 'crawler_query',
      'explanation'],
    source_categories: [SOURCE_IDS.OVERPASS_LOCAL, SOURCE_IDS.COF_FOUNDATION_LOCATOR],
    query_use: 'boost',
    why_we_ask: 'City helps surface neighborhood and municipal programs.',
  }),
  field({
    id: 'geo.zip',
    label: 'ZIP code',
    section: 'location_focus',
    usage_modes: ['profile_understanding', 'source_planning', 'crawler_query',
      'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.OVERPASS_LOCAL, SOURCE_IDS.COMMUNITY_ACTION,
      SOURCE_IDS.HRSA_HEALTH_CENTERS, SOURCE_IDS.FEEDING_AMERICA],
    query_use: 'required_or',
    match_reason: 'ZIP code resolves county, qualified census tracts, opportunity zones, FEMA disaster zones.',
    why_we_ask: 'ZIP unlocks local food banks, health centers, community action agencies, and place-based federal programs.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Organization details — high-leverage federal/foundation readiness
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'organization.name',
    label: 'Organization name',
    section: 'organization_details',
    usage_modes: ['profile_understanding', 'workflow', 'explanation', 'anya_guidance'],
    why_we_ask: 'Identifies the organization on applications and in match explanations.',
  }),
  field({
    id: 'organization.organization_type',
    label: 'Organization type',
    section: 'organization_details',
    usage_modes: ['profile_understanding', 'source_planning', 'match_scoring',
      'explanation', 'anya_guidance'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.STATE_PORTAL],
    query_use: 'required',
    match_reason: 'Organization type controls eligibility for nonprofit/government/business/faith-based grants.',
    why_we_ask: 'Most funders only accept certain kinds of organizations. We use this to filter out programs you cannot apply to.',
  }),
  field({
    id: 'organization.ein',
    label: 'EIN',
    section: 'organization_details',
    usage_modes: ['workflow', 'match_scoring', 'explanation'],
    match_reason: 'Having an EIN signals readiness for federal/foundation grants.',
    why_we_ask: 'Most grant applications require an EIN. We do not send your EIN to crawlers.',
  }),
  field({
    id: 'organization.uei',
    label: 'UEI (SAM.gov)',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'workflow', 'explanation', 'anya_guidance'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV],
    query_use: 'boost',
    match_reason: 'UEI signals federal-grant and contracting readiness; many federal programs require it.',
    why_we_ask: 'A UEI is required for federal grants. If you have one we surface federal opportunities; if you do not we add a "Confirm SAM.gov registration" workflow step.',
  }),
  field({
    id: 'organization.cage_code',
    label: 'CAGE Code',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'workflow', 'explanation', 'anya_guidance'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
      SOURCE_IDS.FEMA_AFG, SOURCE_IDS.FEMA_PUBLIC_ASSISTANCE],
    query_use: 'boost',
    match_reason: 'CAGE Code signals defense, FEMA, and federal contracting readiness.',
    why_we_ask: 'A CAGE code helps identify federal and defense-related grants and contracts you may qualify for.',
  }),
  field({
    id: 'organization.sam_registered',
    label: 'SAM.gov registered',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'workflow', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS],
    query_use: 'boost',
    why_we_ask: 'SAM.gov registration unlocks federal grants. If you are not registered we add it as an application-readiness step.',
  }),
  field({
    id: 'organization.era_commons_id',
    label: 'eRA Commons ID',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation', 'workflow'],
    source_categories: [SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    match_reason: 'eRA Commons signals NIH/HHS research readiness.',
    why_we_ask: 'Required for NIH and HHS research grants. If present we surface those research opportunities.',
  }),
  field({
    id: 'organization.501c3',
    label: '501(c)(3) status',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.COF_FOUNDATION_LOCATOR, SOURCE_IDS.FOUNDATION_LOCATOR,
      SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.FAITH_BASED_GRANTS],
    query_use: 'boost',
    match_reason: '501(c)(3) status unlocks foundation and federal nonprofit grants.',
    why_we_ask: 'Most foundations only fund 501(c)(3) nonprofits. This determines what foundation grants we surface.',
  }),
  field({
    id: 'organization.faith_based',
    label: 'Faith-based organization',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.FAITH_BASED_GRANTS],
    query_use: 'boost',
    why_we_ask: 'Surfaces faith-based foundations and ministry-eligible community grants.',
  }),
  field({
    id: 'organization.school_district',
    label: 'School district',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation', 'workflow'],
    source_categories: [SOURCE_IDS.USED_DEPT_OF_ED, SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
      SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS, SOURCE_IDS.SPECIAL_EDUCATION_GRANTS],
    query_use: 'boost',
    why_we_ask: 'Connects schools and teachers to district-level grants and local education foundations.',
  }),
  field({
    id: 'organization.title_i_school',
    label: 'Title I school',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.USED_DEPT_OF_ED, SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION,
      SOURCE_IDS.SPECIAL_EDUCATION_GRANTS, SOURCE_IDS.SCHOOL_NUTRITION_GRANTS],
    query_use: 'boost',
    match_reason: 'Title I status unlocks school improvement, nutrition, and federal pass-through grants.',
    why_we_ask: 'Title I status unlocks federal school-improvement, nutrition, and special-education funding streams.',
  }),
  field({
    id: 'organization.fqhc',
    label: 'Federally Qualified Health Center / RHC',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HRSA_HEALTH_CENTERS, SOURCE_IDS.PUBLIC_HEALTH_DEPT_GRANTS,
      SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    why_we_ask: 'FQHC / RHC status unlocks HRSA, rural health, and telehealth funding.',
  }),
  field({
    id: 'organization.tribal_government',
    label: 'Tribal government / nation',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.TRIBAL_GOVERNMENT_GRANTS, SOURCE_IDS.BIA_TRIBAL_PROGRAMS,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV, SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES],
    query_use: 'boost',
    why_we_ask: 'Tribal status unlocks BIA, IHS, and tribal infrastructure funding.',
  }),
  field({
    id: 'organization.community_action_agency',
    label: 'Community Action Agency (CAA)',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.COMMUNITY_ACTION, SOURCE_IDS.LIHEAP, SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    why_we_ask: 'CAA status unlocks CSBG, LIHEAP, weatherization, and anti-poverty funding.',
  }),
  field({
    id: 'organization.public_housing_authority',
    label: 'Public Housing Authority',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.CDBG_STATE_LOCAL, SOURCE_IDS.HOMELESS_SERVICES_GRANTS,
      SOURCE_IDS.GRANTS_GOV_LOCAL_GOV],
    query_use: 'boost',
    why_we_ask: 'PHA status unlocks HUD, RAD, FSS, and HCV-related grants.',
  }),
  field({
    id: 'organization.workforce_board',
    label: 'Workforce Development Board',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.STATE_PORTAL,
      SOURCE_IDS.REENTRY_PROGRAM_GRANTS],
    query_use: 'boost',
    why_we_ask: 'Workforce-board status unlocks WIOA, ETPL, and apprenticeship funding.',
  }),
  field({
    id: 'organization.volunteer_fire_ems',
    label: 'Volunteer fire / EMS department',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.FEMA_AFG, SOURCE_IDS.NATIONAL_VOLUNTEER_FIRE_COUNCIL,
      SOURCE_IDS.RURAL_FIRE_GRANTS, SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES,
      SOURCE_IDS.STATE_EMERGENCY_MANAGEMENT],
    query_use: 'boost',
    why_we_ask: 'Volunteer fire / EMS status unlocks FEMA AFG / SAFER, rural fire, and state fire grants.',
  }),
  field({
    id: 'organization.research_institute',
    label: 'Research institute',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS],
    query_use: 'boost',
    why_we_ask: 'Research-institute status unlocks NIH, NSF, and lab/research foundation grants.',
  }),
  field({
    id: 'organization.cdfi',
    label: 'CDFI status',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.SBA_GRANTS,
      SOURCE_IDS.CDBG_STATE_LOCAL],
    query_use: 'boost',
    why_we_ask: 'CDFI certification unlocks Treasury CDFI Fund and community-development finance.',
  }),
  field({
    id: 'organization.hbcu_msi_hsi_tcu',
    label: 'HBCU / HSI / TCU / MSI designation',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.USED_DEPT_OF_ED, SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    why_we_ask: 'HBCU / HSI / TCU / MSI status unlocks Title III/V capacity-building education grants.',
  }),
  field({
    id: 'organization.business_certifications',
    label: 'Business certifications (WOSB / MBE / DBE / SDVOSB / 8(a))',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SBA_GRANTS, SOURCE_IDS.MINORITY_BUSINESS_DEV,
      SOURCE_IDS.WOMEN_OWNED_BUSINESS],
    query_use: 'boost',
    why_we_ask: 'Business certifications unlock SBA, MBDA, WOSB, DBE, SDVOSB, and 8(a) opportunities.',
  }),
  field({
    id: 'organization.naics',
    label: 'NAICS code',
    section: 'organization_details',
    usage_modes: ['crawler_query', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SBA_GRANTS, SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    why_we_ask: 'NAICS code targets industry-specific grants and contracts.',
  }),
  field({
    id: 'organization.hubzone',
    label: 'HUBZone designation',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SBA_GRANTS, SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT],
    query_use: 'boost',
    why_we_ask: 'HUBZone unlocks SBA HUBZone set-aside contracts and grants.',
  }),
  field({
    id: 'organization.opportunity_zone',
    label: 'Opportunity Zone / QCT / Promise Zone',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.CDBG_STATE_LOCAL, SOURCE_IDS.EDA_ECONOMIC_DEVELOPMENT,
      SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    why_we_ask: 'Place-based designations unlock HUD, Treasury, and EDA community-development funding.',
  }),
  field({
    id: 'organization.fema_disaster_area',
    label: 'FEMA disaster area',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.FEMA_PUBLIC_ASSISTANCE, SOURCE_IDS.FEMA_HAZARD_MITIGATION,
      SOURCE_IDS.STATE_EMERGENCY_MANAGEMENT],
    query_use: 'boost',
    why_we_ask: 'Locations in FEMA disaster declarations unlock public assistance and mitigation funding.',
  }),
  field({
    id: 'organization.broadband_underserved',
    label: 'Broadband underserved area',
    section: 'organization_details',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.BROADBAND_GRANTS, SOURCE_IDS.USDA_RD_COMMUNITY_FACILITIES],
    query_use: 'boost',
    why_we_ask: 'Underserved-broadband status unlocks BEAD, ReConnect, and FCC funding.',
  }),
  field({
    id: 'organization.annual_budget',
    label: 'Annual budget',
    section: 'organization_details',
    usage_modes: ['match_scoring', 'workflow', 'explanation'],
    why_we_ask: 'Funders match award sizes to organizational scale; budget tells us which size band you fit.',
  }),
  field({
    id: 'organization.staff_count',
    label: 'Staff count',
    section: 'organization_details',
    usage_modes: ['match_scoring', 'workflow', 'explanation'],
    why_we_ask: 'Some funders restrict by organization size (e.g., small-org grants).',
  }),
  field({
    id: 'organization.charitable_solicitation_registration',
    label: 'Charitable solicitation registration',
    section: 'organization_details',
    usage_modes: ['workflow', 'explanation', 'match_scoring'],
    why_we_ask: 'Required in many states for fundraising; we add it as an application-readiness step when missing.',
  }),
  field({
    id: 'organization.audit_status',
    label: 'Audit status',
    section: 'organization_details',
    usage_modes: ['match_scoring', 'workflow', 'explanation'],
    why_we_ask: 'Foundations and federal grants often require an audit; we surface readiness steps when missing.',
  }),
  field({
    id: 'organization.nicra',
    label: 'Negotiated Indirect Cost Rate Agreement (NICRA)',
    section: 'organization_details',
    usage_modes: ['workflow', 'match_scoring', 'explanation'],
    why_we_ask: 'NICRA improves federal grant readiness; surfaced as a workflow step when missing.',
  }),
  field({
    id: 'organization.insurance',
    label: 'General liability insurance',
    section: 'organization_details',
    usage_modes: ['workflow', 'match_scoring'],
    why_we_ask: 'Some funders require proof of insurance; surfaced as a workflow step when missing.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Nonprofit compliance — federal/foundation readiness gates
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'compliance.501c3_letter',
    label: '501(c)(3) determination letter',
    section: 'nonprofit_compliance',
    usage_modes: ['workflow', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.COF_FOUNDATION_LOCATOR, SOURCE_IDS.FOUNDATION_LOCATOR],
    why_we_ask: 'Most foundations require a 501(c)(3) letter. We surface a "Upload determination letter" workflow step when missing.',
  }),
  field({
    id: 'compliance.audit_990',
    label: 'Form 990 / audited financials',
    section: 'nonprofit_compliance',
    usage_modes: ['workflow', 'match_scoring', 'explanation'],
    why_we_ask: 'Foundations and federal grants typically require recent 990s or audits; we add the readiness step when missing.',
  }),
  field({
    id: 'compliance.charitable_solicitation_state',
    label: 'State charitable solicitation registration',
    section: 'nonprofit_compliance',
    usage_modes: ['workflow', 'explanation'],
    why_we_ask: 'Required to fundraise in many states; we add the readiness step per state when missing.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Education / student
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'education.grade_level',
    label: 'Grade level / education level',
    section: 'education',
    usage_modes: ['profile_understanding', 'source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS,
      SOURCE_IDS.PELL_GRANT, SOURCE_IDS.ED_GOV_FAFSA],
    query_use: 'boost',
    why_we_ask: 'Grade level controls which scholarships and aid programs apply.',
  }),
  field({
    id: 'education.target_colleges',
    label: 'Target colleges / universities',
    section: 'education',
    usage_modes: ['profile_understanding', 'source_planning', 'crawler_query', 'workflow', 'explanation'],
    source_categories: [SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS, SOURCE_IDS.SCHOLARSHIP_DIRECTORY],
    query_use: 'boost',
    why_we_ask: 'We pull each target school\'s financial-aid, scholarship, and housing pages directly.',
  }),
  field({
    id: 'education.major',
    label: 'Major / field of study',
    section: 'education',
    usage_modes: ['crawler_query', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS],
    query_use: 'boost',
    why_we_ask: 'Many scholarships are major-specific (STEM, nursing, education, trades).',
  }),
  field({
    id: 'education.gpa',
    label: 'GPA',
    section: 'education',
    usage_modes: ['match_scoring', 'explanation'],
    why_we_ask: 'Some scholarships have GPA minimums; we use yours to filter accordingly.',
  }),
  field({
    id: 'education.test_scores',
    label: 'Test scores (ACT/SAT/GRE/GMAT/LSAT/MCAT)',
    section: 'education',
    usage_modes: ['match_scoring', 'explanation'],
    why_we_ask: 'Some scholarships require test-score thresholds.',
  }),
  field({
    id: 'education.iep_504',
    label: 'IEP / 504 plan',
    section: 'education',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SPECIAL_EDUCATION_GRANTS, SOURCE_IDS.SCHOLARSHIP_DIRECTORY],
    query_use: 'boost',
    why_we_ask: 'Students with IEP/504 unlock special-education and disability scholarships.',
  }),
  field({
    id: 'education.rotc_jrotc_cap',
    label: 'ROTC / JROTC / CAP',
    section: 'education',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS],
    query_use: 'boost',
    why_we_ask: 'ROTC / JROTC / CAP unlocks military and aviation scholarships.',
  }),
  field({
    id: 'education.first_gen',
    label: 'First-generation college student',
    section: 'education',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS],
    query_use: 'boost',
    why_we_ask: 'First-gen status unlocks dedicated scholarships and TRIO programs.',
  }),
  field({
    id: 'education.fafsa',
    label: 'FAFSA submitted',
    section: 'education',
    usage_modes: ['workflow', 'match_scoring', 'anya_guidance'],
    source_categories: [SOURCE_IDS.ED_GOV_FAFSA, SOURCE_IDS.PELL_GRANT],
    query_use: 'boost',
    why_we_ask: 'FAFSA is required for federal aid. If missing we add a "Complete FAFSA" workflow step.',
  }),
  field({
    id: 'education.pell',
    label: 'Pell Grant eligible / recipient',
    section: 'education',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.PELL_GRANT, SOURCE_IDS.SCHOLARSHIP_DIRECTORY],
    query_use: 'boost',
    why_we_ask: 'Pell-eligibility opens a wide set of need-based aid programs.',
  }),
  field({
    id: 'education.efc_sai',
    label: 'EFC / SAI (Student Aid Index)',
    section: 'education',
    usage_modes: ['match_scoring', 'explanation'],
    why_we_ask: 'EFC / SAI is used by need-based aid; we use it to surface need-based scholarships first.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Financial situation
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'finance.annual_income',
    label: 'Annual income',
    section: 'financial_information',
    usage_modes: ['match_scoring', 'explanation', 'source_planning'],
    source_categories: [SOURCE_IDS.LIHEAP, SOURCE_IDS.SNAP, SOURCE_IDS.MEDICAID,
      SOURCE_IDS.COMMUNITY_ACTION],
    query_use: 'boost',
    why_we_ask: 'Income drives eligibility for benefits, low-income scholarships, and assistance programs.',
  }),
  field({
    id: 'finance.household_size',
    label: 'Household size',
    section: 'financial_information',
    usage_modes: ['match_scoring', 'explanation'],
    why_we_ask: 'Combined with income, household size determines benefits eligibility (FPL).',
  }),
  field({
    id: 'finance.low_income',
    label: 'Low-income household',
    section: 'financial_information',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.COMMUNITY_ACTION, SOURCE_IDS.LIHEAP, SOURCE_IDS.SNAP],
    query_use: 'boost',
    why_we_ask: 'Low-income status unlocks anti-poverty, utility, food, and housing assistance.',
  }),
  field({
    id: 'finance.unemployment',
    label: 'Unemployment / underemployment',
    section: 'financial_information',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.STATE_PORTAL],
    query_use: 'boost',
    why_we_ask: 'Unemployment unlocks workforce, UI, and re-training programs.',
  }),
  field({
    id: 'finance.displaced_worker',
    label: 'Displaced worker',
    section: 'financial_information',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.STATE_PORTAL,
      SOURCE_IDS.REENTRY_PROGRAM_GRANTS],
    query_use: 'boost',
    why_we_ask: 'Displaced-worker status unlocks WIOA dislocated-worker funding and rapid-response services.',
  }),
  field({
    id: 'finance.medical_debt',
    label: 'Medical debt',
    section: 'financial_information',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HRSA_HEALTH_CENTERS, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Medical debt unlocks patient assistance, hospital charity care, and debt-relief programs.',
  }),
  field({
    id: 'finance.first_time_homebuyer',
    label: 'First-time homebuyer',
    section: 'financial_information',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.STATE_PORTAL, SOURCE_IDS.CDBG_STATE_LOCAL],
    query_use: 'boost',
    why_we_ask: 'First-time-homebuyer status unlocks state and federal down-payment assistance.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Government assistance programs
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'programs.medicaid',
    label: 'Medicaid enrollment',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.MEDICAID, SOURCE_IDS.HRSA_HEALTH_CENTERS],
    query_use: 'boost',
    why_we_ask: 'Medicaid status confirms low-income eligibility for many other programs.',
  }),
  field({
    id: 'programs.snap',
    label: 'SNAP enrollment',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SNAP, SOURCE_IDS.FEEDING_AMERICA],
    query_use: 'boost',
    why_we_ask: 'SNAP status confirms low-income eligibility for food and assistance programs.',
  }),
  field({
    id: 'programs.tanf',
    label: 'TANF enrollment',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.COMMUNITY_ACTION, SOURCE_IDS.STATE_PORTAL],
    query_use: 'boost',
    why_we_ask: 'TANF unlocks family-stabilization, childcare, and workforce supports.',
  }),
  field({
    id: 'programs.wic',
    label: 'WIC enrollment',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SNAP, SOURCE_IDS.HRSA_HEALTH_CENTERS],
    query_use: 'boost',
    why_we_ask: 'WIC eligibility unlocks maternal, infant, and nutrition support.',
  }),
  field({
    id: 'programs.head_start',
    label: 'Head Start enrollment',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.COMMUNITY_ACTION],
    query_use: 'boost',
    why_we_ask: 'Head Start status surfaces early-childhood and family-support programs.',
  }),
  field({
    id: 'programs.section8',
    label: 'Section 8 / public housing',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HOMELESS_SERVICES_GRANTS, SOURCE_IDS.CDBG_STATE_LOCAL],
    query_use: 'boost',
    why_we_ask: 'Section 8 / public-housing status unlocks HUD supportive services.',
  }),
  field({
    id: 'programs.liheap',
    label: 'LIHEAP enrollment',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.LIHEAP, SOURCE_IDS.COMMUNITY_ACTION],
    query_use: 'boost',
    why_we_ask: 'LIHEAP confirms utility-assistance need and unlocks weatherization and CSBG programs.',
  }),
  field({
    id: 'programs.acp',
    label: 'Affordable Connectivity Program (ACP)',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.BROADBAND_GRANTS],
    query_use: 'boost',
    why_we_ask: 'ACP status unlocks broadband-connectivity and digital-equity programs.',
  }),
  field({
    id: 'programs.wioa',
    label: 'WIOA participant',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.STATE_PORTAL],
    query_use: 'boost',
    why_we_ask: 'WIOA status unlocks workforce training, apprenticeships, and re-employment support.',
  }),
  field({
    id: 'programs.vocational_rehabilitation',
    label: 'Vocational Rehabilitation',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.STATE_PORTAL],
    query_use: 'boost',
    why_we_ask: 'VR unlocks disability-employment supports, assistive tech, and training.',
  }),
  field({
    id: 'programs.ryan_white',
    label: 'Ryan White HIV/AIDS Program',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HRSA_HEALTH_CENTERS, SOURCE_IDS.MEDICAID],
    query_use: 'boost',
    why_we_ask: 'Ryan White unlocks HIV/AIDS care, housing, and medication-assistance funding.',
  }),
  field({
    id: 'programs.veterans_benefits',
    label: 'VA benefits enrollment',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HOMELESS_SERVICES_GRANTS, SOURCE_IDS.HRSA_HEALTH_CENTERS],
    query_use: 'boost',
    why_we_ask: 'VA enrollment unlocks veteran-specific programs and SSVF housing supports.',
  }),
  field({
    id: 'programs.medicaid_waiver',
    label: 'Medicaid waiver program (HCBS / ECF / CHOICES)',
    section: 'government_assistance',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.MEDICAID, SOURCE_IDS.STATE_PORTAL],
    query_use: 'boost',
    why_we_ask: 'Waiver status unlocks state HCBS / ECF / CHOICES supports.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Health / medical
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'health.cancer',
    label: 'Cancer diagnosis',
    section: 'health_medical',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HRSA_HEALTH_CENTERS, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Surfaces patient-assistance and disease-specific foundations. Stored locally; not sent verbatim to crawlers.',
  }),
  field({
    id: 'health.chronic_illness',
    label: 'Chronic illness',
    section: 'health_medical',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.MEDICAID, SOURCE_IDS.HRSA_HEALTH_CENTERS],
    query_use: 'boost',
    why_we_ask: 'Surfaces chronic-care and condition-specific assistance.',
  }),
  field({
    id: 'health.disability',
    label: 'Disability',
    section: 'health_medical',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.MEDICAID, SOURCE_IDS.SPECIAL_EDUCATION_GRANTS],
    query_use: 'boost',
    why_we_ask: 'Disability status unlocks SSI/SSDI, accessibility, and assistive-tech programs.',
  }),
  field({
    id: 'health.mental_health',
    label: 'Mental health needs',
    section: 'health_medical',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.MENTAL_HEALTH_NONPROFIT_GRANTS,
      SOURCE_IDS.HRSA_HEALTH_CENTERS],
    query_use: 'boost',
    why_we_ask: 'Surfaces SAMHSA-supported and community mental-health resources.',
  }),
  field({
    id: 'health.substance_recovery',
    label: 'Substance recovery',
    section: 'health_medical',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SUBSTANCE_RECOVERY_NONPROFIT_GRANTS,
      SOURCE_IDS.OPIOID_SETTLEMENT_RESOURCES],
    query_use: 'boost',
    why_we_ask: 'Surfaces recovery, treatment, and opioid-settlement-funded programs.',
  }),
  field({
    id: 'health.maternal_prenatal_infant',
    label: 'Maternal / prenatal / infant needs',
    section: 'health_medical',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HRSA_HEALTH_CENTERS, SOURCE_IDS.SNAP],
    query_use: 'boost',
    why_we_ask: 'Surfaces WIC, MIECHV, and maternal/infant support programs.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Demographics / culture / religion (sensitive, optional)
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'demographics.tribal_affiliation',
    label: 'Tribal affiliation',
    section: 'demographics',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.TRIBAL_GOVERNMENT_GRANTS, SOURCE_IDS.BIA_TRIBAL_PROGRAMS],
    query_use: 'boost',
    why_we_ask: 'Tribal affiliation unlocks BIA, IHS, and tribal-specific funding (optional, never required).',
  }),
  field({
    id: 'demographics.religious_affiliation',
    label: 'Religious affiliation',
    section: 'demographics',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.FAITH_BASED_GRANTS],
    query_use: 'boost',
    why_we_ask: 'Helps surface faith-based scholarships and foundations (optional).',
  }),
  field({
    id: 'demographics.lgbtq',
    label: 'LGBTQ+ identity',
    section: 'demographics',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'LGBTQ+ identity surfaces dedicated scholarships and support orgs (optional).',
  }),
  field({
    id: 'demographics.immigration_status',
    label: 'Immigration / citizenship status',
    section: 'demographics',
    usage_modes: ['profile_understanding', 'match_scoring', 'explanation', 'workflow'],
    why_we_ask: 'Some programs require US citizenship; others serve immigrants/refugees specifically. Stored locally only.',
  }),
  field({
    id: 'demographics.race_ethnicity',
    label: 'Race / ethnicity',
    section: 'demographics',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.MINORITY_BUSINESS_DEV],
    query_use: 'boost',
    why_we_ask: 'Optional. Surfaces dedicated scholarships and minority-owned-business programs when provided.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Family & life situation
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'family.single_parent',
    label: 'Single parent',
    section: 'family_life',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.UNITED_WAY_211, SOURCE_IDS.COMMUNITY_ACTION],
    query_use: 'boost',
    why_we_ask: 'Surfaces single-parent scholarships and family-support programs.',
  }),
  field({
    id: 'family.foster_youth',
    label: 'Foster youth / former foster care',
    section: 'family_life',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.COMMUNITY_ACTION],
    query_use: 'boost',
    why_we_ask: 'Foster-youth status unlocks dedicated scholarships and ETV/Chafee supports.',
  }),
  field({
    id: 'family.foster_or_adoptive_parent',
    label: 'Foster / adoptive / kinship parent',
    section: 'family_life',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.UNITED_WAY_211, SOURCE_IDS.COMMUNITY_ACTION],
    query_use: 'boost',
    why_we_ask: 'Surfaces kinship-care, foster-parent, and adoption-support programs.',
  }),
  field({
    id: 'family.domestic_violence',
    label: 'Domestic violence survivor',
    section: 'family_life',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.DOMESTIC_VIOLENCE_SHELTER_GRANTS,
      SOURCE_IDS.HOMELESS_SERVICES_GRANTS, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Surfaces VOCA, VAWA, and survivor-services programs (always optional).',
  }),
  field({
    id: 'family.trafficking',
    label: 'Trafficking survivor',
    section: 'family_life',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.DOMESTIC_VIOLENCE_SHELTER_GRANTS,
      SOURCE_IDS.HOMELESS_SERVICES_GRANTS, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Surfaces dedicated trafficking-survivor support and victim-services programs.',
  }),
  field({
    id: 'family.disaster',
    label: 'Disaster survivor',
    section: 'family_life',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.FEMA_PUBLIC_ASSISTANCE, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Surfaces FEMA individual assistance and disaster-recovery resources.',
  }),
  field({
    id: 'family.formerly_incarcerated',
    label: 'Formerly incarcerated / returning citizen',
    section: 'family_life',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.REENTRY_PROGRAM_GRANTS, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Surfaces reentry, second-chance, and DOL employment programs.',
  }),
  field({
    id: 'family.homelessness_or_housing_insecurity',
    label: 'Homelessness / housing insecurity',
    section: 'family_life',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HOMELESS_SERVICES_GRANTS, SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.FEEDING_AMERICA],
    query_use: 'boost',
    why_we_ask: 'Surfaces shelter, rapid-rehousing, and emergency-assistance programs.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Military service
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'military.veteran',
    label: 'Veteran',
    section: 'military_service',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HOMELESS_SERVICES_GRANTS, SOURCE_IDS.HRSA_HEALTH_CENTERS,
      SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Veteran status unlocks VA, DAV, IAVA, and veteran-specific scholarships.',
  }),
  field({
    id: 'military.disabled_veteran',
    label: 'Disabled veteran',
    section: 'military_service',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SBA_GRANTS, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Disabled-veteran status unlocks SDVOSB, VR&E, and disability-veteran programs.',
  }),
  field({
    id: 'military.spouse_or_dependent',
    label: 'Military spouse / dependent',
    section: 'military_service',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY],
    query_use: 'boost',
    why_we_ask: 'Surfaces military-spouse and dependent scholarships.',
  }),
  field({
    id: 'military.gold_star',
    label: 'Gold Star family',
    section: 'military_service',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.UNITED_WAY_211],
    query_use: 'boost',
    why_we_ask: 'Surfaces Gold Star-family scholarships and survivor benefits.',
  }),
  field({
    id: 'military.gi_bill',
    label: 'Post-9/11 GI Bill',
    section: 'military_service',
    usage_modes: ['source_planning', 'match_scoring', 'explanation', 'workflow'],
    source_categories: [SOURCE_IDS.ED_GOV_FAFSA, SOURCE_IDS.SCHOLARSHIP_DIRECTORY],
    query_use: 'boost',
    why_we_ask: 'GI Bill eligibility surfaces VA education benefits and complementary scholarships.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Occupation
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'occupation.healthcare_worker',
    label: 'Healthcare worker',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.HRSA_HEALTH_CENTERS, SOURCE_IDS.SCHOLARSHIP_DIRECTORY],
    query_use: 'boost',
    why_we_ask: 'Surfaces nurse / clinician scholarships, HRSA loan-repayment, and PSLF guidance.',
  }),
  field({
    id: 'occupation.teacher_educator',
    label: 'Teacher / educator',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.TEACHER_CLASSROOM_GRANTS, SOURCE_IDS.NEA_FOUNDATION,
      SOURCE_IDS.LOCAL_EDUCATION_FOUNDATIONS, SOURCE_IDS.STATE_DEPARTMENT_OF_EDUCATION],
    query_use: 'boost',
    why_we_ask: 'Surfaces teacher mini-grants, classroom-supply funding, and PD support.',
  }),
  field({
    id: 'occupation.firefighter',
    label: 'Firefighter / EMS',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.FEMA_AFG, SOURCE_IDS.NATIONAL_VOLUNTEER_FIRE_COUNCIL,
      SOURCE_IDS.RURAL_FIRE_GRANTS],
    query_use: 'boost',
    why_we_ask: 'Surfaces firefighter and EMS funding and certification supports.',
  }),
  field({
    id: 'occupation.public_servant',
    label: 'Public servant / government employee',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SCHOLARSHIP_DIRECTORY, SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    why_we_ask: 'Surfaces PSLF guidance and public-service scholarships.',
  }),
  field({
    id: 'occupation.clergy_ministry',
    label: 'Clergy / ministry',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.FAITH_BASED_GRANTS],
    query_use: 'boost',
    why_we_ask: 'Surfaces denomination-based grants and ministry-support funding.',
  }),
  field({
    id: 'occupation.small_business_owner',
    label: 'Small business owner',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.SBA_GRANTS, SOURCE_IDS.MINORITY_BUSINESS_DEV,
      SOURCE_IDS.WOMEN_OWNED_BUSINESS],
    query_use: 'boost',
    why_we_ask: 'Surfaces SBA, MBDA, WOSB, and other small-business programs.',
  }),
  field({
    id: 'occupation.farmer_ag_worker',
    label: 'Farmer / agricultural worker',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.USDA_RURAL_DEV, SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    why_we_ask: 'Surfaces USDA, NRCS, and farm-conservation programs.',
  }),
  field({
    id: 'occupation.union_apprenticeship_registration',
    label: 'Union / registered apprenticeship',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.STATE_PORTAL],
    query_use: 'boost',
    why_we_ask: 'Surfaces apprenticeship, training, and union-supported scholarships.',
  }),
  field({
    id: 'occupation.researcher_scientist',
    label: 'Researcher / scientist',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS],
    query_use: 'boost',
    why_we_ask: 'Surfaces NIH, NSF, and federal research-funding opportunities.',
  }),
  field({
    id: 'occupation.environmental_conservation_worker',
    label: 'Environmental / conservation worker',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.EPA_WATER_INFRASTRUCTURE, SOURCE_IDS.USDA_RURAL_DEV],
    query_use: 'boost',
    why_we_ask: 'Surfaces EPA, NRCS, and conservation-grant programs.',
  }),
  field({
    id: 'occupation.artist_musician_cultural',
    label: 'Artist / musician / cultural worker',
    section: 'occupation',
    usage_modes: ['source_planning', 'match_scoring', 'explanation'],
    source_categories: [SOURCE_IDS.IMLS_LIBRARY_MUSEUM, SOURCE_IDS.GRANTS_GOV],
    query_use: 'boost',
    why_we_ask: 'Surfaces NEA, IMLS, and state-arts grant programs.',
  }),

  // ────────────────────────────────────────────────────────────────────
  // Narrative — page 18 (highest-leverage qualitative input)
  // ────────────────────────────────────────────────────────────────────
  field({
    id: 'narrative.story',
    label: 'Personal / organization story',
    section: 'narrative',
    usage_modes: ['profile_understanding', 'crawler_query', 'match_scoring',
      'explanation', 'anya_guidance', 'workflow'],
    query_use: 'boost',
    why_we_ask: 'The story is one of the highest-signal inputs — it shapes search keywords, match explanations, and Anya guidance.',
  }),
  field({
    id: 'narrative.goals',
    label: 'Goals',
    section: 'narrative',
    usage_modes: ['profile_understanding', 'crawler_query', 'match_scoring', 'explanation'],
    query_use: 'required_or',
    why_we_ask: 'Goals tell GrantFlow what kinds of funding to prioritize.',
  }),
  field({
    id: 'narrative.funding_use',
    label: 'How funding will be used',
    section: 'narrative',
    usage_modes: ['profile_understanding', 'crawler_query', 'match_scoring',
      'explanation', 'workflow'],
    query_use: 'required_or',
    why_we_ask: 'Funding-use determines amount matching, deadline urgency, and application narrative drafts.',
  }),
  field({
    id: 'narrative.barriers',
    label: 'Barriers',
    section: 'narrative',
    usage_modes: ['profile_understanding', 'match_scoring', 'explanation', 'anya_guidance'],
    why_we_ask: 'Barriers help Anya recommend assistance programs that address what is blocking you.',
  }),
  field({
    id: 'narrative.keywords',
    label: 'Keywords',
    section: 'narrative',
    usage_modes: ['crawler_query', 'match_scoring', 'explanation'],
    query_use: 'boost',
    why_we_ask: 'Keywords sharpen search terms and disambiguate ambiguous needs.',
  }),
]

const REGISTRY = Object.freeze(Object.fromEntries(ENTRIES.map((e) => [e.id, e])))

export const FIELD_USAGE_MODES = VALID_USAGE_MODES
export const FIELD_USAGE_SECTIONS = VALID_SECTIONS

export function listFieldUsages() {
  return ENTRIES.slice()
}

export function getFieldUsage(id) {
  if (!id) return null
  return REGISTRY[String(id)] ?? null
}

export function isPii(id) {
  const e = getFieldUsage(id)
  return e?.pii === true
}

/**
 * Returns true when the field is sensitive AND the registry forbids
 * sending its raw value to crawlers / external search systems. Used by
 * the mission test to assert PII never leaks into query terms.
 */
export function forbidsExternalQuery(id) {
  const e = getFieldUsage(id)
  if (!e) return false
  return e.pii === true || e.raw_external_use_allowed === false
}

export function forSection(sectionKey) {
  if (!sectionKey) return []
  return ENTRIES.filter((e) => e.section === sectionKey)
}

export function forSourceCategory(sourceId) {
  if (!sourceId) return []
  return ENTRIES.filter((e) => e.source_categories.includes(sourceId))
}

export function forUsageMode(mode) {
  if (!mode) return []
  return ENTRIES.filter((e) => e.usage_modes.includes(mode))
}

/**
 * Build a mission-health-friendly usage report. The shape matches the
 * `field_usage` block the audit asked for so the dashboard / CI can
 * render it directly.
 *
 * Returns:
 *   {
 *     total_profile_fields, mapped_fields, unmapped_fields,
 *     pii_fields, pii_external_query_violations,
 *     by_section: { section: count, ... },
 *     by_usage_mode: { mode: count, ... },
 *     by_source_category: { source_id: count, ... },
 *     unknown_source_categories: [ ... ]   // sources referenced but not in SOURCES
 *   }
 */
export function buildFieldUsageReport() {
  const bySection = {}
  const byUsageMode = {}
  const bySourceCategory = {}
  const unknownSources = new Set()
  let pii = 0
  let piiViolations = 0
  let unmapped = 0

  for (const entry of ENTRIES) {
    bySection[entry.section] = (bySection[entry.section] ?? 0) + 1
    for (const m of entry.usage_modes) byUsageMode[m] = (byUsageMode[m] ?? 0) + 1
    for (const s of entry.source_categories) {
      bySourceCategory[s] = (bySourceCategory[s] ?? 0) + 1
      if (!SOURCES[s]) unknownSources.add(s)
    }
    if (entry.pii) {
      pii += 1
      // PII fields must (a) declare raw_external_use_allowed:false and
      // (b) carry no source_categories meant for external query.
      if (entry.raw_external_use_allowed === true) piiViolations += 1
      if (entry.usage_modes.includes('crawler_query')) piiViolations += 1
    }
    if (entry.usage_modes.length === 0) unmapped += 1
  }

  return {
    total_profile_fields: ENTRIES.length,
    mapped_fields: ENTRIES.length - unmapped,
    unmapped_fields: unmapped,
    pii_fields: pii,
    pii_external_query_violations: piiViolations,
    by_section: bySection,
    by_usage_mode: byUsageMode,
    by_source_category: bySourceCategory,
    unknown_source_categories: Array.from(unknownSources),
  }
}

export default {
  FIELD_USAGE_MODES,
  FIELD_USAGE_SECTIONS,
  listFieldUsages,
  getFieldUsage,
  isPii,
  forbidsExternalQuery,
  forSection,
  forSourceCategory,
  forUsageMode,
  buildFieldUsageReport,
}
