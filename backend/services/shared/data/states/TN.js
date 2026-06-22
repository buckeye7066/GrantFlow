/**
 * TN.js — Tennessee State Benefits
 *
 * Includes standard benefits AND the ECF CHOICES / CHOICES
 * long-term services and supports system.
 * Real URLs. Verified contacts.
 */

export const STATE_META = {
  code: 'TN',
  name: 'Tennessee',
  benefitsPortal: 'https://tenncareconnect.tn.gov/',
  benefitsPortalName: 'TennCare Connect',
  medicaidName: 'TennCare',
  dhsPhone: '1-866-311-4287',
  localOfficeUrl: 'https://www.tn.gov/humanservices/for-families/supplemental-nutrition-assistance-program-snap/county-offices.html',
  aaadPhone: '1-866-836-6678',
  ltssHelpDesk: '1-877-224-0219',
  is211Available: true,
};

export const STATE_BENEFITS = [

  // ════════════════════════════════════════
  // COMBINED APPLICATION PORTAL
  // ════════════════════════════════════════
  {
    id: 'tn-tenncare-connect',
    name: 'TennCare Connect — Apply for TennCare, CHOICES, ECF CHOICES & More',
    description: 'Tennessee\'s online portal for healthcare coverage, long-term services and supports, Katie Beckett, and other TennCare programs. Create an account to apply, check status, and manage your benefits.',
    url: 'https://tenncareconnect.tn.gov/',
    categories: ['healthcare','disability','cash_assistance'],
    type: 'portal',
    fundingType: 'direct_benefit',
    priority: 1,
  },
  {
    id: 'tn-dhs-portal',
    name: 'TN DHS Family Assistance — SNAP, TANF, Child Care',
    description: 'Tennessee DHS online portal for SNAP (food), Families First (TANF), child care assistance, and other family support programs.',
    url: 'https://fabenefits.dhs.tn.gov/',
    categories: ['food','cash_assistance','childcare'],
    eligibility: { incomeLimit: 'Varies by program' },
    type: 'portal',
    fundingType: 'direct_benefit',
    priority: 1,
  },

  // ════════════════════════════════════════
  // ECF CHOICES (Intellectual/Developmental Disabilities)
  // ════════════════════════════════════════
  {
    id: 'tn-ecf-choices',
    name: 'ECF CHOICES (Employment and Community First CHOICES)',
    description: 'Home and community-based services for people with intellectual and developmental disabilities (I/DD). Helps people find employment, live independently, and participate in their communities. Includes residential supports (CLS, CLS-FM), employment services, personal assistance, and more. Groups 4-8 based on assessed need.',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
    applicationUrl: 'https://www.tn.gov/disability-and-aging/disability-aging-programs/ecf-choices.html',
    applicationNote: 'Complete the online Self-Referral Form. For help, call your MCO (number on TennCare card) or DDA regional office.',
    categories: ['disability','healthcare','housing','employment'],
    eligibility: {
      requiresIDD: true,
      intellectualDisabilityBeforeAge18: true,
      developmentalDisabilityBeforeAge22: true,
      incomeLimit: '$2,982/month (2026, nursing facility LOC) or $1,957/month (at-risk LOC)',
      assetLimit: '$2,000 (home excluded)',
      requiresTennCare: true,
    },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    healthMatch: ['developmental_disability','disability','mental_health'],
    isECFCHOICES: true,
  },
  {
    id: 'tn-ecf-cls',
    name: 'ECF CHOICES — Community Living Supports (CLS)',
    description: 'Community-based residential service for up to 4 individuals in a licensed home. Includes ADL/IADL assistance, skill building, community integration, and 24-hour support. Multiple levels (CLS-1, CLS-2, CLS-3) based on support needs.',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
    categories: ['housing','disability'],
    eligibility: { requiresECFCHOICES: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    healthMatch: ['developmental_disability','disability'],
    isECFCHOICES: true,
  },
  {
    id: 'tn-ecf-cls-fm',
    name: 'ECF CHOICES — Community Living Supports - Family Model (CLS-FM)',
    description: 'Adult foster care arrangement where up to 3 individuals with I/DD live in the home of a trained family caregiver. The caregiver integrates the individual into shared family life while providing individualized supports. CLS-FM homes are licensed and reimbursed by TennCare through the MCOs. CLS Ombudsman: 1-866-836-6678.',
    url: 'https://www.tn.gov/content/dam/tn/disability-and-aging/documents/provider-information/become-a-credentialed-provider/Attachment%204%20-%20ECF%20Choices.pdf',
    categories: ['housing','disability'],
    eligibility: { requiresECFCHOICES: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    healthMatch: ['developmental_disability','disability'],
    isECFCHOICES: true,
    isCLSFM: true,
  },
  {
    id: 'tn-ecf-employment',
    name: 'ECF CHOICES — Supported Employment & Integrated Employment Path',
    description: 'Employment services helping people with I/DD find and maintain competitive, integrated employment. Includes job exploration, job development, job coaching, and ongoing support. Also covers paid/unpaid internships.',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
    categories: ['employment','disability'],
    eligibility: { requiresECFCHOICES: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    healthMatch: ['developmental_disability','disability'],
    isECFCHOICES: true,
  },
  {
    id: 'tn-ecf-enabling-tech',
    name: 'ECF CHOICES — Enabling Technology',
    description: 'Technology solutions to promote independence: remote monitoring, smart home devices, GPS tracking, medication reminders, and other assistive technology. Technology-first approach to reduce reliance on direct support staff.',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
    categories: ['disability'],
    eligibility: { requiresECFCHOICES: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    healthMatch: ['developmental_disability','disability'],
    isECFCHOICES: true,
  },
  {
    id: 'tn-ecf-family-stipend',
    name: 'ECF CHOICES Group 4 — Family Support Stipend',
    description: 'Monthly stipend for families caring for a child or adult with I/DD at home. Helps offset the costs of caregiving. Child must be under 21 or adult 21+ living at home with family.',
    url: 'https://www.familyvoicestn.org/resources/ecf-choices/',
    categories: ['cash_assistance','disability'],
    eligibility: { requiresECFCHOICES: true, group: 4, requiresLivingWithFamily: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    healthMatch: ['developmental_disability','disability'],
    familyMatch: ['has_children','caregiver'],
    isECFCHOICES: true,
  },
  {
    id: 'tn-ecf-comprehensive',
    name: 'ECF CHOICES Comprehensive Supports (Group 6)',
    description: 'Full array of community-based residential and day services for individuals with I/DD who need comprehensive supports. Includes CLS, CLS-FM, supportive home care, dental ($5,000/yr), environmental modifications, and specialized equipment. Annual expenditure cap: $236,450. Income limit: $2,982/month.',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
    categories: ['disability','housing','employment'],
    eligibility: { requiresDisability: true, requiresMedicaid: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    maxAmount: 236450,
    healthMatch: ['disability','developmental_disability'],
    isECFCHOICES: true,
  },
  {
    id: 'tn-ecf-group7',
    name: 'ECF CHOICES Group 7 — Comprehensive Behavioral Supports (Children)',
    description: 'For children under 21 with I/DD and severe co-occurring behavioral/psychiatric conditions that place the child or others at significant risk. Includes all Group 6 services plus intensive behavioral health supports, crisis intervention, and specialized residential supports.',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
    categories: ['disability','healthcare','mental_health'],
    eligibility: { requiresDisability: true, requiresMedicaid: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    healthMatch: ['disability','developmental_disability','mental_health'],
    familyMatch: ['has_children'],
    isECFCHOICES: true,
  },
  {
    id: 'tn-ecf-group8',
    name: 'ECF CHOICES Group 8 — Comprehensive Behavioral Supports (Adults)',
    description: 'For adults with I/DD and severe behavioral needs transitioning from institutional or highly structured settings into the community. First-year expenditure cap: $513,625, then $236,450. Includes intensive behavioral health community stabilization (CLS-BHCST).',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
    categories: ['disability','housing','healthcare','mental_health'],
    eligibility: { requiresDisability: true, requiresMedicaid: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    maxAmount: 513625,
    healthMatch: ['disability','developmental_disability','mental_health'],
    isECFCHOICES: true,
  },
  {
    id: 'tn-ecf-apply',
    name: 'ECF CHOICES — How to Apply',
    description: 'Self-referral form, financial eligibility documents, and MCO contacts for applying to ECF CHOICES. BlueCare: 1-800-468-9698 | Wellpoint: 1-833-731-2153 | UHC: 1-800-690-1606 | Not sure? Call 1-855-259-0701. DDA offices: West 901-745-7357, Middle 615-231-5436, East 865-594-6508.',
    url: 'https://www.tn.gov/disability-and-aging/disability-aging-programs/ecf-choices.html',
    categories: ['disability','healthcare'],
    eligibility: { requiresDisability: true, stateResident: 'TN' },
    type: 'portal',
    fundingType: 'referral_service',
    healthMatch: ['disability','developmental_disability'],
    isECFCHOICES: true,
  },

  // ════════════════════════════════════════
  // CHOICES (Elderly / Physical Disability)
  // ════════════════════════════════════════
  {
    id: 'tn-choices',
    name: 'TennCare CHOICES in Long-Term Services and Supports',
    description: 'Home and community-based services for Tennesseans age 65+ or adults 21+ with physical disabilities. Includes nursing facility care, attendant care, personal care, in-home respite, companion care, and Community Living Supports. Groups 1, 2, and 3 based on level of care needed.',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/choices.html',
    applicationNote: 'Contact your local AAAD at 1-866-836-6678 or apply through TennCare Connect.',
    categories: ['healthcare','housing','disability'],
    eligibility: {
      incomeLimit: '$2,982/month (2026)',
      assetLimit: '$2,000 (home excluded)',
      ageOrDisability: 'Age 65+ or physical disability age 21+',
    },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    demographicMatch: ['senior'],
    healthMatch: ['disability','physical_disability','chronic_illness'],
  },

  // ════════════════════════════════════════
  // FOOD
  // ════════════════════════════════════════
  {
    id: 'tn-snap',
    name: 'Tennessee SNAP (Food Assistance)',
    description: 'Monthly food benefits on EBT card. Apply online, by phone, in person at county DHS office, or by mail. Tennessee uses broad-based categorical eligibility.',
    url: 'https://www.tn.gov/humanservices/for-families/supplemental-nutrition-assistance-program-snap.html',
    applicationUrl: 'https://fabenefits.tn.gov/',
    categories: ['food'],
    eligibility: { incomeLimit: '130% FPL gross' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  },

  // ════════════════════════════════════════
  // UTILITIES / ENERGY
  // ════════════════════════════════════════
  {
    id: 'tn-liheap',
    name: 'Tennessee LIHEAP (Home Energy Assistance)',
    description: 'Helps low-income households pay heating and cooling costs. Administered through local Community Action Agencies. Also includes crisis assistance for utility shutoff prevention.',
    url: 'https://www.tn.gov/humanservices/for-families/community-services-block-grant-csbg-/low-income-home-energy-assistance-program--liheap-.html',
    applicationNote: 'Contact your local Community Action Agency. Find yours at tncommunityaction.org',
    categories: ['utilities'],
    eligibility: { incomeLimit: '150% FPL' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  },
  {
    id: 'tn-weatherization',
    name: 'Tennessee Weatherization Assistance Program',
    description: 'Free home energy improvements: insulation, air sealing, HVAC repair/replacement, window repair. Reduces energy bills and improves home safety.',
    url: 'https://www.tn.gov/humanservices/for-families/community-services-block-grant-csbg-/weatherization-assistance-program.html',
    categories: ['utilities','weatherization','housing'],
    eligibility: { incomeLimit: '200% FPL' },
    type: 'grant',
    fundingType: 'direct_service',
    recurring: false,
  },
  {
    id: 'tn-tva-utility-assistance',
    name: 'TVA/Local Power Company Assistance Programs',
    description: 'Tennessee Valley Authority distributors offer low-income utility assistance, budget billing, and energy efficiency programs. Contact your local power company.',
    url: 'https://www.tva.com/energy/valley-energy-assistance',
    categories: ['utilities'],
    type: 'assistance',
    fundingType: 'direct_service',
  },

  // ════════════════════════════════════════
  // CASH ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'tn-tanf',
    name: 'Tennessee Families First (TANF)',
    description: 'Cash assistance for low-income families with children. Includes job training, education support, and transitional services.',
    url: 'https://www.tn.gov/humanservices/for-families/families-first-tanf.html',
    applicationUrl: 'https://fabenefits.tn.gov/',
    categories: ['cash_assistance','employment'],
    eligibility: { requiresChildren: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children','single_parent'],
  },

  // ════════════════════════════════════════
  // HEALTHCARE
  // ════════════════════════════════════════
  {
    id: 'tn-tenncare',
    name: 'TennCare (Tennessee Medicaid)',
    description: 'Tennessee\'s Medicaid program providing health coverage to eligible residents. Managed through three MCOs: BlueCare, Wellpoint (Amerigroup), and UnitedHealthcare Community Plan.',
    url: 'https://www.tn.gov/tenncare.html',
    applicationUrl: 'https://tenncareconnect.tn.gov/',
    categories: ['healthcare'],
    eligibility: { incomeLimit: 'Varies by category — Tennessee did not expand Medicaid under ACA' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  },
  {
    id: 'tn-coverkids',
    name: 'CoverKids (Children\'s Health Insurance)',
    description: 'Health insurance for uninsured Tennessee children under 19 and pregnant women. Covers medical, dental, vision, prescriptions, and mental health services.',
    url: 'https://www.tn.gov/tenncare/members-applicants/coverkids.html',
    applicationUrl: 'https://tenncareconnect.tn.gov/',
    categories: ['healthcare'],
    eligibility: { incomeLimit: '250% FPL for children, 195% FPL for pregnant women' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children'],
  },
  {
    id: 'tn-katie-beckett',
    name: 'Katie Beckett Program',
    description: 'TennCare coverage for children with disabilities or complex medical needs who don\'t otherwise qualify for TennCare. Covers medical, behavioral, and home care services regardless of parental income (premiums may apply).',
    url: 'https://www.tn.gov/tenncare/long-term-services-supports/katie-beckett-program.html',
    applicationNote: 'Apply through TennCare Connect, then complete the Katie Beckett self-referral.',
    categories: ['healthcare','disability'],
    eligibility: { requiresChild: true, requiresDisabilityOrMedicalNeed: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    healthMatch: ['developmental_disability','disability','chronic_illness'],
    familyMatch: ['has_children'],
  },

  // ════════════════════════════════════════
  // HOUSING
  // ════════════════════════════════════════
  {
    id: 'tn-thda',
    name: 'Tennessee Housing Development Agency (THDA) Programs',
    description: 'Multiple housing programs: Emergency Repair for low-income homeowners, Home Modification for accessibility, and rental assistance programs.',
    url: 'https://thda.org/',
    categories: ['housing'],
    eligibility: { incomeLimit: 'Varies by program' },
    type: 'assistance',
    fundingType: 'direct_service',
  },

  // ════════════════════════════════════════
  // CHILDCARE
  // ════════════════════════════════════════
  {
    id: 'tn-childcare-cert',
    name: 'Tennessee Child Care Certificate Program',
    description: 'Subsidized child care for low-income working families. Reduces or eliminates child care costs through payments directly to providers.',
    url: 'https://www.tn.gov/humanservices/for-families/child-care-services.html',
    categories: ['childcare'],
    eligibility: { incomeLimit: '85% state median income', requiresChildren: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children','single_parent'],
  },

  // ════════════════════════════════════════
  // DISABILITY SERVICES (NON-ECF)
  // ════════════════════════════════════════
  {
    id: 'tn-vr',
    name: 'Tennessee Vocational Rehabilitation (VR)',
    description: 'Employment services for Tennesseans with disabilities: assessment, training, job placement, assistive technology, and ongoing support. VR and TennCare partner to serve ECF CHOICES members.',
    url: 'https://www.tn.gov/humanservices/disability-services/vocational-rehabilitation.html',
    categories: ['employment','disability','education'],
    eligibility: { requiresDisability: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    healthMatch: ['disability','physical_disability','developmental_disability','visual_impairment','hearing_impairment','mental_health'],
  },
  {
    id: 'tn-didd-services',
    name: 'TN DIDD (Dept of Intellectual & Developmental Disabilities)',
    description: 'State agency providing and coordinating services for Tennesseans with intellectual and developmental disabilities. Gateway to all TN I/DD programs.',
    url: 'https://www.tn.gov/didd.html',
    categories: ['disability','employment','housing'],
    eligibility: { requiresDisability: true },
    type: 'portal',
    fundingType: 'direct_service',
    healthMatch: ['disability','developmental_disability'],
  },

  // ════════════════════════════════════════
  // CAREGIVER SUPPORT
  // ════════════════════════════════════════
  {
    id: 'tn-caregiver-support',
    name: 'National Family Caregiver Support — TN (ACL)',
    description: 'Respite care, training, support groups, and supplemental services for family caregivers of individuals with disabilities in Tennessee.',
    url: 'https://www.tn.gov/aging/our-programs/caregiver-support-program.html',
    categories: ['disability','healthcare'],
    eligibility: { requiresCaregiver: true },
    type: 'assistance',
    fundingType: 'direct_service',
    familyMatch: ['caregiver'],
  },

  // ════════════════════════════════════════
  // LOCAL RESOURCES / REFERRAL
  // ════════════════════════════════════════
  {
    id: 'tn-cap-network',
    name: 'Tennessee Community Action Agencies',
    description: 'Local agencies providing emergency assistance with utilities, rent, food, and other basic needs across all Tennessee counties.',
    url: 'https://www.tncommunityaction.org/',
    categories: ['utilities','housing','food','transportation','cash_assistance'],
    eligibility: { incomeLimit: 'Varies — typically 125-200% FPL' },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
  },
  {
    id: 'tn-aaad',
    name: 'Area Agencies on Aging and Disability (AAAD)',
    description: 'Regional agencies providing intake for CHOICES, information about ECF CHOICES, meals, homemaker services, personal care, transportation, and case management for older adults and adults with disabilities.',
    url: 'https://www.tn.gov/disability-and-aging/resource-directory/aaad.html',
    applicationNote: 'Call TENNOPT at 1-866-836-6678 or email dda.aging@tn.gov',
    categories: ['healthcare','disability','food','transportation'],
    type: 'referral',
    fundingType: 'referral_service',
    recurring: true,
    demographicMatch: ['senior'],
    healthMatch: ['disability','physical_disability'],
  },
  {
    id: 'tn-211',
    name: 'Tennessee 211 — Connect to Help',
    description: 'Free referral service connecting Tennesseans to local assistance for utilities, food, housing, healthcare, employment, and more.',
    url: 'https://www.tn211.org/',
    applicationNote: 'Dial 2-1-1 or visit tn211.org',
    categories: ['utilities','housing','food','healthcare','cash_assistance','employment','mental_health','legal','transportation','childcare'],
    type: 'referral',
    fundingType: 'referral_service',
    recurring: true,
  },
];

// ── MCO Contact Information (critical for ECF CHOICES) ──
export const MCO_CONTACTS = {
  bluecare: {
    name: 'BlueCare Tennessee',
    phone: '1-800-468-9698',
    url: 'https://www.bcbst.com/bluecare',
  },
  wellpoint: {
    name: 'Wellpoint (formerly Amerigroup)',
    phone: '1-833-731-2153',
    url: 'https://www.wellpoint.com/tennessee',
  },
  uhc: {
    name: 'UnitedHealthcare Community Plan',
    phone: '1-800-690-1606',
    url: 'https://www.uhc.com/communityplan/tennessee',
  },
  general: {
    name: 'TennCare Member Services',
    phone: '1-855-259-0701',
  },
};

// ── DDA Regional Offices (for ECF CHOICES applications) ──
export const DDA_REGIONAL_OFFICES = {
  west: {
    name: 'West TN Regional Office (Memphis)',
    phone: '901-745-7357',
    director: 'C.J. McMorran',
  },
  middle: {
    name: 'Middle TN Regional Office (Nashville)',
    phone: '615-231-5436',
    director: 'Dr. Levi Harris',
  },
  east: {
    name: 'East TN Regional Office',
    phone: '865-594-6508',
  },
};

// ── CLS Ombudsman ──
export const CLS_OMBUDSMAN = {
  description: 'Advocates for individuals living in CLS and CLS-FM homes. Investigates complaints, ensures rights are enforced, assists with provider selection.',
  phone: '1-866-836-6678',
  note: 'Contact your local AAAD and ask for the CLS Ombudsman.',
};

// ── County Resources ──
export const COUNTY_RESOURCES = {
  davidson: {
    cap: { name: 'Nashville CARES / Metro Action Commission', phone: '615-862-8860', services: ['utilities','housing','food','employment'] },
  },
  shelby: {
    cap: { name: 'Memphis Light Gas & Water Utility Assistance', phone: '901-528-4270', services: ['utilities'] },
  },
  knox: {
    cap: { name: 'Knoxville-Knox County CAC', phone: '865-546-3500', services: ['utilities','housing','food','weatherization'] },
  },
  hamilton: {
    cap: { name: 'Chattanooga Community Action Agency', phone: '423-752-0316', services: ['utilities','housing','food'] },
  },
};

export default { STATE_META, STATE_BENEFITS, MCO_CONTACTS, DDA_REGIONAL_OFFICES, CLS_OMBUDSMAN, COUNTY_RESOURCES };
