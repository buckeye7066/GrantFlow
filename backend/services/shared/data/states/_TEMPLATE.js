/**
 * _TEMPLATE.js — State Benefits Template
 *
 * INSTRUCTIONS:
 * 1. Copy this file as {STATE_CODE}.js (e.g., OH.js, CA.js)
 * 2. Research the state's programs using the checklist below
 * 3. Fill in every program with a verified URL
 * 4. Add county-level resources for major counties
 *
 * RESEARCH CHECKLIST:
 * ┌─────────────────────────────────────────────────────────┐
 * │ CATEGORY           │ WHAT TO FIND                       │
 * ├─────────────────────────────────────────────────────────┤
 * │ Benefits Portal    │ State's online benefits application │
 * │ SNAP               │ State SNAP page + application URL   │
 * │ TANF / Cash        │ State TANF program name + URL       │
 * │ Medicaid           │ State Medicaid program + expansion?  │
 * │ CHIP               │ Children's health insurance          │
 * │ LIHEAP/LIEAP       │ State energy assistance + admin org  │
 * │ Utility Programs   │ State-specific utility assistance    │
 * │ Weatherization     │ State WAP administrator              │
 * │ Housing            │ State housing finance agency          │
 * │ Childcare          │ State child care subsidy program      │
 * │ Disability         │ State VR + I/DD waivers              │
 * │ Aging              │ State Area Agency on Aging network   │
 * │ CAP Network        │ State Community Action Agencies      │
 * │ 211                │ State 211 URL                        │
 * │ Legal Aid          │ State legal services program         │
 * └─────────────────────────────────────────────────────────┘
 *
 * RULES:
 * - Every URL must be a real, verified link
 * - NO loans, NO matching funds
 * - Categories must match the need detection system in profileHelpers.js
 * - Valid categories: utilities, housing, food, healthcare, cash_assistance,
 *   employment, childcare, education, transportation, disability,
 *   mental_health, substance_recovery, legal, clothing, internet,
 *   weatherization, burial, tax
 */

export const STATE_META = {
  code: 'XX',
  name: 'State Name',
  benefitsPortal: '',
  benefitsPortalName: '',
  dhsPhone: '',
  localOfficeUrl: '',
  is211Available: true,
};

export const STATE_BENEFITS = [

  // ── Portal ──
  {
    id: 'xx-portal',
    name: '[State] Benefits Portal',
    description: 'State online portal for applying to multiple benefits programs.',
    url: '',
    categories: ['food', 'healthcare', 'cash_assistance', 'utilities'],
    type: 'portal',
    fundingType: 'direct_benefit',
    priority: 1,
  },

  // ── Food ──
  {
    id: 'xx-snap',
    name: '[State] SNAP (Food Assistance)',
    description: '',
    url: '', // REQUIRED
    applicationUrl: '', // REQUIRED
    categories: ['food'],
    eligibility: { incomeLimit: '' }, // REQUIRED: fill verified income limit
    applicantTypes: [], // REQUIRED: fill for each state
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    // source is set by the loader to the state code (e.g. 'state_data:OH')
    // fingerprint is computed by the crawler from id + url + categories
    // Do NOT hardcode these here; the loader must inject them at import time.
  },

  // ── Utilities ──
  {
    id: 'xx-liheap',
    name: '[State] LIHEAP / Energy Assistance',
    description: '',
    url: '',
    categories: ['utilities'],
    eligibility: { incomeLimit: '' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  },

  // ── Weatherization ──
  {
    id: 'xx-wap',
    name: '[State] Weatherization Assistance',
    description: '',
    url: '',
    categories: ['utilities', 'weatherization', 'housing'],
    eligibility: { incomeLimit: '200% FPL' },
    type: 'grant',
    fundingType: 'direct_service',
    recurring: false,
  },

  // ── Cash Assistance ──
  {
    id: 'xx-tanf',
    name: '[State] TANF / Cash Assistance',
    description: '',
    url: '',
    categories: ['cash_assistance', 'employment'],
    eligibility: { requiresChildren: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children', 'single_parent'],
  },

  // ── Healthcare ──
  {
    id: 'xx-medicaid',
    name: '[State] Medicaid',
    description: '',
    url: '',
    categories: ['healthcare'],
    eligibility: { incomeLimit: '' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  },
  {
    id: 'xx-chip',
    name: '[State] CHIP / Children\'s Health Insurance',
    description: '',
    url: '',
    categories: ['healthcare'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children'],
  },

  // ── Housing ──
  {
    id: 'xx-housing',
    name: '[State] Housing Finance Agency Programs',
    description: '',
    url: '',
    categories: ['housing'],
    type: 'assistance',
    fundingType: 'direct_service',
  },

  // ── Childcare ──
  {
    id: 'xx-childcare',
    name: '[State] Child Care Subsidy',
    description: '',
    url: '',
    categories: ['childcare'],
    eligibility: { requiresChildren: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children'],
  },

  // ── Disability ──
  {
    id: 'xx-vr',
    name: '[State] Vocational Rehabilitation',
    description: '',
    url: '',
    categories: ['employment', 'disability'],
    eligibility: { requiresDisability: true },
    type: 'benefit',
    fundingType: 'direct_service',
    healthMatch: ['disability'],
  },

  // ── Local Resources ──
  {
    id: 'xx-cap',
    name: '[State] Community Action Agencies',
    description: '',
    url: '',
    categories: ['utilities', 'housing', 'food', 'transportation', 'cash_assistance'],
    type: 'assistance',
    fundingType: 'direct_service',
  },
  {
    id: 'xx-211',
    name: '[State] 211',
    description: '',
    url: '', // REQUIRED
    categories: ['utilities', 'housing', 'food', 'healthcare', 'cash_assistance', 'employment', 'mental_health', 'legal', 'transportation', 'childcare'],
    // applicantTypes: who can use this — fill in for each concrete state file
    // e.g. ['individual', 'family', 'senior', 'veteran', 'disabled', 'student', 'nonprofit']
    applicantTypes: [], // REQUIRED: fill for each state
    eligibility: {}, // REQUIRED: fill for each state
    type: 'referral',
    fundingType: 'referral_service',
  },

  // ── ADD STATE-SPECIFIC PROGRAMS BELOW ──
  // Examples: state utility discount programs, state-funded grants,
  // state emergency assistance, state I/DD waiver programs, etc.
];

export const COUNTY_RESOURCES = {
  // county_name_lowercase: {
  //   cap: { name, phone, address, services: [] },
  //   dhs: { name, phone, services: [] },
  // },
};

// Validate before export so any loader that imports this module gets
// an empty array rather than blank-URL placeholder records.
const _validatedBenefits = STATE_BENEFITS.filter(entry => {
  if (!entry.url || entry.url.trim() === '') {
    console.warn(
      `[STATE TEMPLATE] Skipping entry '${entry.id}' — url is empty. ` +
      'Fill in a verified URL before activating this state file.'
    );
    return false;
  }
  return true;
});

export default { STATE_META, STATE_BENEFITS: _validatedBenefits, COUNTY_RESOURCES };
