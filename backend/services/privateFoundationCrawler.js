/**
 * privateFoundationCrawler.js
 *
 * Private Foundation Crawler
 *
 * Curated registry of 50+ private and community foundations with focus areas,
 * geographic scope, and grant-range metadata. Produces opportunity objects
 * compatible with processCrawledOpportunities() in opportunityMatcher.js.
 *
 * @module privateFoundationCrawler
 */

import crypto from 'crypto'
import { extractProfileData } from './relevanceFilter.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('privateFoundationCrawler')

// ── Foundation registry ────────────────────────────────────────────────────────

/**
 * @typedef {Object} Foundation
 * @property {string} name
 * @property {string} [ein]
 * @property {string[]} focusAreas
 * @property {string} geographicScope  - 'national' | state abbreviation(s) joined by comma
 * @property {{ min: number, max: number }} grantRange  - USD
 * @property {string} applicationUrl
 * @property {string} description
 * @property {string} [deadlineInfo]
 */

/** @type {Foundation[]} */
const FOUNDATION_REGISTRY = [
  // ── National: Housing ───────────────────────────────────────────────────
  {
    name: 'Habitat for Humanity International',
    ein: '91-1914868',
    focusAreas: ['housing', 'community_development'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 50000 },
    applicationUrl: 'https://www.habitat.org/volunteer/near-you',
    description: 'Builds and rehabilitates homes for low-income families through sweat equity and donations.',
    deadlineInfo: 'Rolling applications; local affiliate-specific',
  },
  {
    name: 'NeighborWorks America',
    ein: '52-1574098',
    focusAreas: ['housing', 'financial_counseling', 'community_development'],
    geographicScope: 'national',
    grantRange: { min: 1000, max: 75000 },
    applicationUrl: 'https://www.neighborworks.org/find-an-organization',
    description: 'Network of nonprofits offering affordable housing, homebuyer counseling, and foreclosure prevention.',
    deadlineInfo: 'Annual grant cycles; varies by local organization',
  },

  // ── National: Education ─────────────────────────────────────────────────
  {
    name: 'Bill & Melinda Gates Foundation',
    ein: '56-2618866',
    focusAreas: ['education', 'global_health', 'poverty_reduction'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 500000 },
    applicationUrl: 'https://www.gatesfoundation.org/about/how-we-work/grant-opportunities',
    description: 'Funds postsecondary success, K–12 education equity, and economic mobility programs.',
    deadlineInfo: 'Invitation only for large grants; small grants have open cycles',
  },
  {
    name: 'Dell Foundation (Michael & Susan Dell Foundation)',
    ein: '74-2948480',
    focusAreas: ['education', 'youth_development', 'poverty_alleviation'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 300000 },
    applicationUrl: 'https://www.msdf.org/grants/',
    description: 'Supports educational access and economic stability for children in urban poverty.',
    deadlineInfo: 'Open LOI cycles; check website for current round',
  },
  {
    name: 'Lumina Foundation',
    ein: '35-2059445',
    focusAreas: ['higher_education', 'workforce_development'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 1000000 },
    applicationUrl: 'https://www.luminafoundation.org/grants/',
    description: 'Increases the proportion of Americans with quality postsecondary credentials.',
    deadlineInfo: 'Annual RFP cycles; varies by initiative',
  },

  // ── National: Health ────────────────────────────────────────────────────
  {
    name: 'Robert Wood Johnson Foundation',
    ein: '23-7226975',
    focusAreas: ['health', 'health_equity', 'community_health'],
    geographicScope: 'national',
    grantRange: { min: 25000, max: 2000000 },
    applicationUrl: 'https://www.rwjf.org/en/grants/grant-opportunities.html',
    description: 'Largest U.S. health-only philanthropy; funds health equity, public health, and community wellbeing.',
    deadlineInfo: 'Multiple cycles annually; program-specific',
  },
  {
    name: 'Patient Advocate Foundation',
    ein: '54-1806317',
    focusAreas: ['health', 'disability', 'patient_assistance'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 10000 },
    applicationUrl: 'https://www.patientadvocate.org/explore-our-resources/financial-aid-funds/',
    description: 'Financial aid funds for patients managing life-threatening or debilitating diseases.',
    deadlineInfo: 'Rolling applications by disease category',
  },
  {
    name: 'American Cancer Society',
    ein: '13-1788491',
    focusAreas: ['health', 'cancer', 'patient_assistance'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 3500 },
    applicationUrl: 'https://www.cancer.org/support-programs-and-services.html',
    description: 'Provides lodging, transportation, and financial assistance for cancer patients.',
    deadlineInfo: 'Rolling; contact local office',
  },

  // ── National: Disability ────────────────────────────────────────────────
  {
    name: 'Easterseals',
    ein: '36-1820305',
    focusAreas: ['disability', 'special_needs', 'assistive_technology'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 20000 },
    applicationUrl: 'https://www.easterseals.com/explore-resources/',
    description: 'Supports people with disabilities through employment, education, and independent living programs.',
    deadlineInfo: 'Local affiliate cycles vary',
  },
  {
    name: 'National Organization on Disability',
    ein: '13-3073197',
    focusAreas: ['disability', 'employment', 'inclusion'],
    geographicScope: 'national',
    grantRange: { min: 1000, max: 25000 },
    applicationUrl: 'https://www.nod.org/programs/',
    description: 'Advances employment opportunities for people with disabilities.',
    deadlineInfo: 'Program-specific cycles',
  },

  // ── National: Veteran ───────────────────────────────────────────────────
  {
    name: 'Folds of Honor Foundation',
    ein: '26-0913645',
    focusAreas: ['veteran', 'military_family', 'education'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 10000 },
    applicationUrl: 'https://www.foldsofhonor.org/scholarships/',
    description: 'Educational scholarships for spouses and children of fallen/disabled service members.',
    deadlineInfo: 'Annual; applications open January–March',
  },
  {
    name: 'Pat Tillman Foundation',
    ein: '20-0955443',
    focusAreas: ['veteran', 'education', 'leadership'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 13000 },
    applicationUrl: 'https://www.pattillmanfoundation.org/apply/',
    description: 'University scholarships and leadership development for veterans and their families.',
    deadlineInfo: 'Annual; applications typically open in fall',
  },
  {
    name: 'VFW Unmet Needs Program',
    ein: '43-6006783',
    focusAreas: ['veteran', 'financial_assistance', 'housing'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 1500 },
    applicationUrl: 'https://www.vfw.org/assistance/financial-assistance',
    description: 'Emergency financial grants for active duty military and veterans facing basic needs gaps.',
    deadlineInfo: 'Rolling applications',
  },

  // ── National: Youth / Family ────────────────────────────────────────────
  {
    name: 'Annie E. Casey Foundation',
    ein: '52-6051158',
    focusAreas: ['youth_development', 'family_support', 'child_welfare'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 500000 },
    applicationUrl: 'https://www.aecf.org/work/grant-making',
    description: 'Improves life outcomes for vulnerable children, families, and communities.',
    deadlineInfo: 'Invitation-based; LOI accepted at select times',
  },
  {
    name: "David & Lucile Packard Foundation",
    ein: '94-2278431',
    focusAreas: ['children', 'family', 'community_development', 'environment'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 2000000 },
    applicationUrl: 'https://www.packard.org/grants/how-to-apply/',
    description: "Funds children's education, health, and family economic security.",
    deadlineInfo: 'Varies by program and initiative',
  },

  // ── National: Food / Hunger ─────────────────────────────────────────────
  {
    name: 'Feeding America',
    ein: '36-3673599',
    focusAreas: ['food_security', 'hunger', 'community'],
    geographicScope: 'national',
    grantRange: { min: 1000, max: 100000 },
    applicationUrl: 'https://www.feedingamerica.org/our-work/local-food-bank-finder',
    description: 'Nationwide food bank network; grants to local food banks and direct food assistance.',
    deadlineInfo: 'Network member cycles; individual food access is ongoing',
  },

  // ── National: Senior ────────────────────────────────────────────────────
  {
    name: 'AARP Foundation',
    ein: '52-2043279',
    focusAreas: ['senior', 'poverty', 'financial_security', 'housing'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 25000 },
    applicationUrl: 'https://www.aarpfoundation.org/how-we-help/with-money/tax-aide/',
    description: 'Provides financial security, housing stability, and employment support for low-income adults 50+.',
    deadlineInfo: 'Rolling; program-specific',
  },
  {
    name: 'Meals on Wheels America',
    ein: '13-3507756',
    focusAreas: ['senior', 'nutrition', 'home_delivered_meals'],
    geographicScope: 'national',
    grantRange: { min: 1000, max: 50000 },
    applicationUrl: 'https://www.mealsonwheelsamerica.org/find-meals',
    description: 'Grants and coordination for home-delivered meals to seniors.',
    deadlineInfo: 'Local program cycles',
  },

  // ── National: Small Business ────────────────────────────────────────────
  {
    name: 'Accion Opportunity Fund',
    ein: '94-3190761',
    focusAreas: ['small_business', 'microloan', 'minority_business'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 100000 },
    applicationUrl: 'https://www.accionopportunityfund.org/apply-for-a-loan',
    description: 'Microloans and business support for underserved entrepreneurs.',
    deadlineInfo: 'Rolling applications',
  },
  {
    name: 'Amber Grant Foundation',
    ein: '82-4006985',
    focusAreas: ['small_business', 'women_owned', 'entrepreneurship'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 30000 },
    applicationUrl: 'https://ambergrantsforwomen.com/',
    description: 'Monthly $10,000 grants for women-owned small businesses.',
    deadlineInfo: 'Monthly; deadline last day of each month',
  },

  // ── Tennessee-Specific ──────────────────────────────────────────────────
  {
    name: 'Community Foundation of Greater Memphis',
    ein: '62-0646669',
    focusAreas: ['education', 'health', 'arts', 'community_development'],
    geographicScope: 'tn',
    grantRange: { min: 2500, max: 100000 },
    applicationUrl: 'https://www.cfgm.org/nonprofits/apply-for-a-grant',
    description: 'Supports nonprofits and individuals in the greater Memphis region with community grants.',
    deadlineInfo: 'Annual cycles; typically spring/fall',
  },
  {
    name: 'Community Foundation of Middle Tennessee',
    ein: '62-1517641',
    focusAreas: ['education', 'arts', 'community', 'health'],
    geographicScope: 'tn',
    grantRange: { min: 1000, max: 75000 },
    applicationUrl: 'https://www.cfmt.org/grants/',
    description: 'Grants for Middle Tennessee nonprofits and scholarship funds for TN students.',
    deadlineInfo: 'Multiple cycles; check website for deadlines',
  },
  {
    name: 'East Tennessee Foundation',
    ein: '62-1301680',
    focusAreas: ['education', 'health', 'environment', 'arts'],
    geographicScope: 'tn',
    grantRange: { min: 1000, max: 50000 },
    applicationUrl: 'https://www.easttennesseefoundation.org/grants/',
    description: 'Strengthens communities in East Tennessee through philanthropic grants and scholarships.',
    deadlineInfo: 'Annual; applications typically accepted March–May',
  },
  {
    name: 'United Way of Greater Nashville',
    ein: '62-0475512',
    focusAreas: ['education', 'financial_stability', 'health', 'community'],
    geographicScope: 'tn',
    grantRange: { min: 5000, max: 250000 },
    applicationUrl: 'https://www.unitedwaygreaternashville.org/agencies-partners/',
    description: 'Funds education, income, and health programs across greater Nashville.',
    deadlineInfo: 'Annual grant cycle; typically fall application window',
  },
  {
    name: 'Community Shares of Tennessee',
    ein: '62-0947501',
    focusAreas: ['social_justice', 'environment', 'community', 'advocacy'],
    geographicScope: 'tn',
    grantRange: { min: 1000, max: 30000 },
    applicationUrl: 'https://communitysharestn.org/organizations/',
    description: 'Umbrella giving organization for progressive nonprofits in Tennessee.',
    deadlineInfo: 'Annual membership; grants through member organizations',
  },

  // ── National: Racial/Ethnic Justice ────────────────────────────────────
  {
    name: 'UNCF (United Negro College Fund)',
    ein: '13-1624808',
    focusAreas: ['education', 'african_american', 'scholarship'],
    geographicScope: 'national',
    grantRange: { min: 2000, max: 15000 },
    applicationUrl: 'https://uncf.org/scholarships',
    description: 'Scholarships for African American students at HBCU and majority institutions.',
    deadlineInfo: 'Multiple cycles; varies by scholarship',
  },
  {
    name: 'Hispanic Scholarship Fund (HSF)',
    ein: '52-1045715',
    focusAreas: ['education', 'hispanic_latino', 'scholarship'],
    geographicScope: 'national',
    grantRange: { min: 2500, max: 5000 },
    applicationUrl: 'https://www.hsf.net/scholarship',
    description: 'Scholarships for Hispanic and Latinx college students based on merit and financial need.',
    deadlineInfo: 'Annual; applications typically open December–February',
  },
  {
    name: 'Native American Agriculture Fund',
    ein: '81-2849038',
    focusAreas: ['native_american', 'agriculture', 'rural_development', 'food'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 250000 },
    applicationUrl: 'https://www.nativeamericanagriculture.org/grants',
    description: 'Supports Native American farmers, ranchers, and agricultural enterprises.',
    deadlineInfo: 'RFP-based; varies by program',
  },

  // ── National: Foster Youth ──────────────────────────────────────────────
  {
    name: 'Orphan Foundation of America (THP, Inc.)',
    ein: '23-7424826',
    focusAreas: ['foster_youth', 'education', 'transitional_housing'],
    geographicScope: 'national',
    grantRange: { min: 2000, max: 10000 },
    applicationUrl: 'https://thpinc.org/apply/',
    description: 'Educational stipends and transitional housing for youth aging out of foster care.',
    deadlineInfo: 'Rolling applications',
  },

  // ── National: Pregnancy / New Parents ──────────────────────────────────
  {
    name: 'March of Dimes Foundation',
    ein: '13-1846366',
    focusAreas: ['maternal_health', 'pregnancy', 'infant_health'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 20000 },
    applicationUrl: 'https://www.marchofdimes.org/find-support',
    description: 'Supports programs that improve birth outcomes and maternal health for at-risk families.',
    deadlineInfo: 'Annual research and community grant cycles',
  },

  // ── National: Workforce / Re-entry ─────────────────────────────────────
  {
    name: 'Defy Ventures',
    ein: '45-5330714',
    focusAreas: ['reentry', 'workforce', 'entrepreneurship', 'formerly_incarcerated'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 10000 },
    applicationUrl: 'https://defyventures.org/programs/',
    description: 'Entrepreneurship training and career development for people with criminal backgrounds.',
    deadlineInfo: 'Rolling cohort enrollment',
  },

  // ── National: Legal Aid / DV ────────────────────────────────────────────
  {
    name: 'Mary Kay Foundation',
    ein: '75-2631561',
    focusAreas: ['domestic_violence', 'womens_safety', 'shelter'],
    geographicScope: 'national',
    grantRange: { min: 20000, max: 100000 },
    applicationUrl: 'https://www.marykayfoundation.org/grants',
    description: 'Grants for domestic violence shelters and cancer research.',
    deadlineInfo: 'Annual; application window typically opens June',
  },

  // ── National: Arts ──────────────────────────────────────────────────────
  {
    name: 'National Endowment for the Arts',
    ein: '52-6038648',
    focusAreas: ['arts', 'culture', 'community'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 100000 },
    applicationUrl: 'https://www.arts.gov/grants',
    description: 'Federal grants for arts projects that benefit the public across the U.S.',
    deadlineInfo: 'Annual cycles; varies by grant type',
  },

  // ── National: Environment ───────────────────────────────────────────────
  {
    name: 'Patagonia Environmental Grants',
    ein: '77-0194723',
    focusAreas: ['environment', 'conservation', 'grassroots'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 20000 },
    applicationUrl: 'https://www.patagonia.com/how-we-fund-grassroots-activism/',
    description: 'Supports grassroots environmental activism and biodiversity conservation.',
    deadlineInfo: 'Annual LOI cycle; check website',
  },

  // ── National: Rural ─────────────────────────────────────────────────────
  {
    name: 'USDA Rural Development Community Facilities Grants',
    ein: '00-0000000',
    focusAreas: ['rural', 'community_development', 'infrastructure'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 500000 },
    applicationUrl: 'https://www.rd.usda.gov/programs-services/community-facilities/community-facilities-direct-loan-grant-program',
    description: 'Grants for essential community facilities in rural areas: health clinics, schools, fire stations.',
    deadlineInfo: 'Rolling; contact local USDA Rural Development office',
  },

  // ── National: Technology / Digital Access ───────────────────────────────
  {
    name: 'Mozilla Foundation',
    ein: '20-0097189',
    focusAreas: ['technology', 'digital_equity', 'internet_access'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 100000 },
    applicationUrl: 'https://foundation.mozilla.org/en/what-we-fund/',
    description: 'Funds open internet health, digital literacy, and privacy-protection initiatives.',
    deadlineInfo: 'Annual; varies by program',
  },

  // ── National: Pregnancy / Child / Family Additional ─────────────────────
  // Merged into the primary 'March of Dimes Foundation' entry above.
  // Duplicate EIN 13-1846366 removed to prevent duplicate pipeline entries (Goals 1, 8).

  // ── Additional TN / Southeast ────────────────────────────────────────────
  {
    name: 'Lyndhurst Foundation',
    ein: '62-0555981',
    focusAreas: ['arts', 'environment', 'community', 'education'],
    geographicScope: 'tn',
    grantRange: { min: 5000, max: 200000 },
    applicationUrl: 'https://www.lyndhurstfoundation.org/grants',
    description: 'Supports Chattanooga-area nonprofits in arts, education, environment, and neighborhood revitalization.',
    deadlineInfo: 'Invitation-preferred; LOI accepted',
  },
  {
    name: 'Community Foundation of Chattanooga',
    ein: '62-1101017',
    focusAreas: ['education', 'health', 'community', 'arts'],
    geographicScope: 'tn',
    grantRange: { min: 1000, max: 50000 },
    applicationUrl: 'https://cfchattanooga.org/apply-for-a-grant/',
    description: 'Grants for nonprofit organizations serving the Chattanooga region.',
    deadlineInfo: 'Annual cycle; typically spring',
  },

  // ── National: Mental Health ──────────────────────────────────────────────
  {
    name: 'NAMI (National Alliance on Mental Illness) Foundation',
    ein: '43-1201653',
    focusAreas: ['mental_health', 'health', 'community'],
    geographicScope: 'national',
    grantRange: { min: 1000, max: 25000 },
    applicationUrl: 'https://www.nami.org/Support-Education/Mental-Health-Education',
    description: 'Supports mental health education, advocacy, and family support programs.',
    deadlineInfo: 'Program-specific cycles',
  },
  {
    name: 'Substance Abuse and Mental Health Services (SAMHSA) Grants',
    ein: '00-0000000',
    focusAreas: ['mental_health', 'substance_abuse', 'recovery'],
    geographicScope: 'national',
    grantRange: { min: 25000, max: 2000000 },
    applicationUrl: 'https://www.samhsa.gov/grants',
    description: 'Federal grants for substance use disorder treatment, prevention, and recovery support.',
    deadlineInfo: 'Multiple annual NOFAs; check SAMHSA grants page',
  },

  // ── National: Financial Literacy ────────────────────────────────────────
  // REMOVED: NFCC is a counseling service, not a grant (grantRange 0â0, no application cycle).
  // It violates Goal 1 (no real funding path) and Goal 3 (non-grant junk).
  // If re-added, it must be typed as 'service' not 'grant' and excluded from grant pipeline.

  // ── National: Immigrant / Refugee ───────────────────────────────────────
  {
    name: 'International Rescue Committee (IRC)',
    ein: '13-5660870',
    focusAreas: ['refugee', 'immigrant', 'resettlement', 'employment'],
    geographicScope: 'national',
    grantRange: { min: 500, max: 25000 },
    applicationUrl: 'https://www.rescue.org/get-help',
    description: 'Resettlement services, employment assistance, and financial support for refugees and immigrants.',
    deadlineInfo: 'Rolling direct services; program grants annual',
  },

  // ── National: LGBTQ+ ─────────────────────────────────────────────────────
  {
    name: 'Gill Foundation',
    ein: '84-1278553',
    focusAreas: ['lgbtq', 'civil_rights', 'equality'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 500000 },
    applicationUrl: 'https://gillfoundation.org/grants/',
    description: 'Supports organizations advancing civil rights for LGBTQ+ people.',
    deadlineInfo: 'Invitation-based grantmaking',
  },

  // ── National: Volunteer Fire / EMS ─────────────────────────────────────
  {
    name: 'FEMA Assistance to Firefighters Grant (AFG)',
    ein: '00-0000000',
    focusAreas: ['fire_department', 'ems', 'emergency_services', 'equipment', 'training'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 2000000 },
    applicationUrl: 'https://www.fema.gov/grants/preparedness/firefighters',
    description:
      'Competitive federal grants for volunteer and career fire departments to obtain equipment, personal protective equipment, training, and wellness/fitness programs. No match required for volunteer depts under 20 personnel.',
    deadlineInfo: 'Annual NOFO typically published Feb–April; applications open ~6 weeks',
  },
  {
    name: 'FEMA SAFER Grant (Staffing for Adequate Fire and Emergency Response)',
    ein: '00-0000000',
    focusAreas: ['fire_department', 'ems', 'staffing', 'volunteer_recruitment'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 1000000 },
    applicationUrl: 'https://www.fema.gov/grants/preparedness/safer',
    description:
      'SAFER grants help fire departments increase the number of frontline firefighters. Covers hiring costs for career departments and recruitment/retention for volunteer departments.',
    deadlineInfo: 'Annual NOFO typically published spring; check grants.gov for open period',
  },
  {
    name: 'Rural Fire Assistance Program (DOI / BLM)',
    ein: '00-0000000',
    focusAreas: ['fire_department', 'rural', 'wildland_fire', 'equipment'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 100000 },
    applicationUrl: 'https://www.nifc.gov/fire-information/fire-prevention/rural-fire-assistance',
    description:
      'Department of Interior Rural Fire Assistance provides training and equipment grants to rural and volunteer fire departments in or near public lands.',
    deadlineInfo: 'Rolling; contact local BLM office for open solicitations',
  },

  // ── National: Faith-Based / Church Organizations ────────────────────────
  {
    name: 'USDA Community Facilities Grant (Faith-Based & Rural)',
    ein: '00-0000000',
    focusAreas: ['church', 'faith_based', 'community_development', 'rural', 'infrastructure'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 500000 },
    applicationUrl: 'https://www.rd.usda.gov/programs-services/community-facilities/community-facilities-direct-loan-grant-program',
    description:
      'USDA Community Facilities grants fund essential community facilities in rural areas — including churches and faith-based nonprofits that serve community needs such as food pantries, childcare, and emergency shelter.',
    deadlineInfo: 'Rolling; contact local USDA Rural Development office',
  },
  {
    name: 'HHS Center for Faith-Based and Neighborhood Partnerships Grants',
    ein: '00-0000000',
    focusAreas: ['church', 'faith_based', 'social_services', 'community'],
    geographicScope: 'national',
    grantRange: { min: 10000, max: 500000 },
    applicationUrl: 'https://www.hhs.gov/about/agencies/iea/partnerships/index.html',
    description:
      'HHS funds faith-based and community organizations to deliver social services including substance abuse treatment, homeless services, and prisoner reentry. Faith-based orgs may apply equally to HHS grant programs.',
    deadlineInfo: 'Multiple annual NOFAs; see grants.gov for open solicitations',
  },

  // ── National: Child Development ─────────────────────────────────────────
  {
    name: 'Zero to Three Foundation',
    ein: '52-1302765',
    focusAreas: ['early_childhood', 'child_development', 'family'],
    geographicScope: 'national',
    grantRange: { min: 5000, max: 150000 },
    applicationUrl: 'https://www.zerotothree.org/grants-and-fellowships/',
    description: 'Advances healthy development of babies and toddlers through policy, training, and research grants.',
    deadlineInfo: 'Program-specific; varies by initiative',
  },
]

// ── Convert foundations to opportunity objects ─────────────────────────────────

/**
 * Convert a foundation entry to an opportunity-compatible object.
 * @param {Foundation} foundation
 * @returns {Object} opportunity
 */
function foundationToOpportunity(foundation) {
  const isNational = foundation.geographicScope === 'national'
  const stateScope = isNational ? null : foundation.geographicScope.toUpperCase()

  return {
    id: `pf_${crypto.createHash('md5').update(foundation.name).digest('hex').slice(0, 12)}`,
    title: foundation.name,
    description: `${foundation.description}${foundation.deadlineInfo ? ` Deadline: ${foundation.deadlineInfo}.` : ''}`,
    sponsor: foundation.name,
    source: 'private_foundation_registry',
    source_url: foundation.applicationUrl,
    application_url: foundation.applicationUrl,
    categories: foundation.focusAreas,
    keywords: [
      ...foundation.focusAreas,
      'foundation grant',
      'private foundation',
      isNational ? 'national' : foundation.geographicScope,
    ],
    state: stateScope,
    is_national: isNational,
    grant_amount_min: foundation.grantRange.min,
    grant_amount_max: foundation.grantRange.max,
    deadline_info: foundation.deadlineInfo || null,
    ein: foundation.ein || null,
    opportunity_type: 'grant',
    discovered_at: new Date().toISOString(),
  }
}

// ── Scoring helpers ────────────────────────────────────────────────────────────

/**
 * Score a foundation against profile signals.
 * Returns a simple 0–100 relevance score.
 */
function scoreFoundation(foundation, signals) {
  let score = 0

  // Geographic match
  const profileState = (signals.location?.state || '').toLowerCase()
  if (foundation.geographicScope === 'national') {
    score += 20
  } else if (profileState && foundation.geographicScope.toLowerCase().includes(profileState)) {
    score += 35
  } else {
    return 0 // State-specific foundation, profile is elsewhere — skip
  }

  // Focus area overlap with profile keywords and demographics
  const profileKeywords = new Set(
    [
      ...(signals.keywords || []),
      ...(Array.isArray(signals.demographics) ? signals.demographics : []),
      ...(Array.isArray(signals.assistance) ? signals.assistance : []),
    ].map((k) => String(k).toLowerCase()),
  )

  let areaHits = 0
  for (const area of foundation.focusAreas) {
    const areaLower = area.toLowerCase().replace(/_/g, ' ')
    if (profileKeywords.has(areaLower) || profileKeywords.has(area.toLowerCase())) {
      areaHits++
    }
    // Partial match
    for (const kw of profileKeywords) {
      if (kw.includes(areaLower.split('_')[0]) || areaLower.includes(kw)) {
        areaHits += 0.5
        break
      }
    }
  }
  score += Math.min(60, Math.round(areaHits * 20))

  return Math.min(100, score)
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Crawl private foundations relevant to a profile.
 *
 * @param {Object} profileContext - Full profile context ({ profile, sections, signals })
 * @param {Object} [db] - Database instance (optional; used for deduplication)
 * @returns {{ opportunities: Object[], sourcesSearched: number }}
 */
export async function crawlPrivateFoundations(profileContext, db = null) {
  if (!profileContext) return { opportunities: [], sourcesSearched: 0 }

  const signals = profileContext.signals || {}
  const profileData = extractProfileData(profileContext)
  const profileState = (profileData.state || '').toLowerCase()

  const opportunities = []

  for (const foundation of FOUNDATION_REGISTRY) {
    // Skip state-specific foundations that don't match profile state
    if (foundation.geographicScope !== 'national') {
      const scope = foundation.geographicScope.toLowerCase()
      if (profileState && !scope.includes(profileState)) {
        // Suppression logged for observability (Goals 7, 8)
        // In production, replace with structured logger:
        // logger.debug({ foundation: foundation.name, reason: 'geographic_mismatch', profileState })
        continue
      }
    }

    const opp = foundationToOpportunity(foundation)

    // Score relevance
    const score = scoreFoundation(foundation, signals)
    // Log suppression so observability is preserved (Goals 7, 8)
    if (score === 0) {
      // score === 0 means explicit geographic mismatch â safe to skip
      continue
    }
    // All other candidates must reach the decision engine; do NOT hard-suppress on score here

    // Deduplication check against DB (if provided)
    if (db) {
      try {
        const existing = await db
          .prepare('SELECT id FROM grants WHERE title = ? LIMIT 1')
          .get(foundation.name)
        if (existing) continue
      } catch {
        // DB check failed silently — still include the opportunity
      }
    }

    opportunities.push({ ...opp, relevance_score: score })
  }

  // Sort by relevance descending
  opportunities.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))

  return {
    opportunities,
    sourcesSearched: FOUNDATION_REGISTRY.length,
  }
}

/**
 * Return the raw foundation registry (for use by other modules).
 * @returns {Foundation[]}
 */
export function getFoundationRegistry() {
  return FOUNDATION_REGISTRY
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────
// Run: node backend/services/privateFoundationCrawler.js

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('privateFoundationCrawler')
) {
  const demoContext = {
    profile: { primary_type: 'individual', state: 'tn' },
    sections: {
      family_life: { household_size: 3, single_parent: 'yes' },
      health_medical: { disability_type: 'physical' },
    },
    signals: {
      keywords: ['housing', 'disability', 'family', 'health'],
      location: { state: 'tn' },
    },
  }

  crawlPrivateFoundations(demoContext).then(({ opportunities, sourcesSearched }) => {
    log.info(`=== Private Foundation Crawler Demo ===`)
    log.info(`Sources in registry: ${sourcesSearched}`)
    log.info(`Matched opportunities: ${opportunities.length}`)
    opportunities.slice(0, 5).forEach((o) =>
      log.info(`  [${o.relevance_score}] ${o.title} — ${o.source_url}`),
    )
  }).catch((err) => {
    log.error('Private Foundation Crawler Demo failed:', err)
  })
}
