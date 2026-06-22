/**
 * WV.js — West Virginia State Benefits
 * 
 * Real programs with verified application URLs.
 * Every URL has been confirmed via web search.
 * NO loans. NO matching funds. Direct assistance only.
 */

export const STATE_META = {
  code: 'WV',
  name: 'West Virginia',
  benefitsPortal: 'https://www.wvpath.wv.gov/',
  benefitsPortalName: 'WV PATH',
  dhhrPhone: '1-304-558-0684',
  localOfficeUrl: 'https://dohs.wv.gov/field-offices',
  is211Available: true,
};

export const STATE_BENEFITS = [

  // ════════════════════════════════════════
  // COMBINED APPLICATION PORTAL
  // ════════════════════════════════════════
  {
    id: 'wv-path-portal',
    name: 'WV PATH — One Application for Multiple Benefits',
    description: 'West Virginia\'s online portal for applying to SNAP, Medicaid, WV WORKS (TANF), LIEAP, Medicare Premium Assistance, and School Clothing Allowance — all in a single application.',
    url: 'https://www.wvpath.wv.gov/',
    categories: ['food','healthcare','cash_assistance','utilities','clothing'],
    eligibility: { incomeLimit: 'Varies by program' },
    type: 'portal',
    fundingType: 'direct_benefit',
    priority: 1, // Show this first — it's the gateway to everything
  },

  // ════════════════════════════════════════
  // FOOD
  // ════════════════════════════════════════
  {
    id: 'wv-snap',
    name: 'WV SNAP (Food Assistance)',
    description: 'Monthly food benefits on an EBT card. For WV households, gross income limit is 130% FPL. Asset limit $3,000 ($4,500 if someone is 60+ or disabled). Apply through WV PATH.',
    url: 'https://bfa.wv.gov/snap',
    applicationUrl: 'https://www.wvpath.wv.gov/',
    categories: ['food'],
    eligibility: { incomeLimit: '130% FPL gross, 100% FPL net', assetLimit: '$3,000 / $4,500 elderly/disabled' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  },

  // ════════════════════════════════════════
  // UTILITIES / ENERGY
  // ════════════════════════════════════════
  {
    id: 'wv-lieap',
    name: 'WV LIEAP (Low Income Energy Assistance)',
    description: 'Heating assistance up to $10,000 maximum. Cooling assistance up to $866. Winter crisis component up to $2,000. Weatherization up to $12,000. Program opens each November.',
    url: 'https://bfa.wv.gov/utility-assistancelieap',
    applicationUrl: 'https://www.wvpath.wv.gov/',
    categories: ['utilities'],
    eligibility: { incomeLimit: 'Varies — see FY2026 LIEAP guidelines at bfa.wv.gov' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    maxAmount: 10000,
  },
  {
    id: 'wv-utility-assistance-def',
    name: 'WV Utility Assistance Program (Dollar Energy Fund)',
    description: 'One-time grant applied directly to your utility bill for gas, electric, and water. Open 10/1/2025 through 9/30/2026. Must apply for LIHEAP first if programs are open. Must have made minimum recent payments on account.',
    url: 'https://www.dollarenergy.org/program/west-virginia-utility-assistance-program/',
    applicationNote: 'Call 211 or contact your local Salvation Army intake agency. Find agencies at hardshiptools.org/AgencyFinder.aspx',
    categories: ['utilities'],
    eligibility: {
      incomeLimit: '150% FPL (200% FPL for WV American Water customers)',
      requirements: 'Service must be off or threatened. Must apply for LIHEAP/E-LIHEAP first if open. Must show minimum recent payments.',
    },
    type: 'grant',
    fundingType: 'direct_grant',
    recurring: false, // one grant per utility per program year
  },
  {
    id: 'wv-20pct-discount',
    name: 'WV 20% Utility Discount Program',
    description: '20% discount on gas and electric bills from November through March. Must receive SSI, WV WORKS, or SNAP and be age 60 or older.',
    url: 'https://liheapch.acf.gov/profiles/WV.htm',
    categories: ['utilities'],
    eligibility: {
      incomeLimit: 'Must be on SSI, WV WORKS, or SNAP',
      minAge: 60,
    },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    demographicMatch: ['senior'],
  },
  {
    id: 'wv-weatherization',
    name: 'WV Weatherization Assistance Program',
    description: 'Free home energy improvements: insulation, air sealing, furnace repair/replacement, window repair. No repayment required. Priority for elderly, disabled, families with children, and high energy burden households.',
    url: 'https://wvcad.org/sustainability/weatherization-assistance-program',
    applicationNote: 'Apply through your local Community Action Agency. Find agencies at wvcap.org/agencies/',
    categories: ['utilities','weatherization','housing'],
    eligibility: { incomeLimit: '200% FPL' },
    type: 'grant',
    fundingType: 'direct_service',
    recurring: false,
    maxAmount: 12000,
  },
  {
    id: 'wv-liheap-repair',
    name: 'WV LIHEAP Heating/Cooling Repair & Replacement',
    description: 'Emergency repair or replacement of unsafe or non-working heating and cooling systems for homeowners. Free — no repayment. Requires qualifying household member (child under 6, elderly 60+, or disabled).',
    url: 'https://bfa.wv.gov/utility-assistancelieap',
    applicationNote: 'Apply online at mylitt.com or through a Community Action Agency.',
    categories: ['utilities','housing'],
    eligibility: { incomeLimit: 'LIHEAP income guidelines', requiresQualifyingMember: true },
    type: 'grant',
    fundingType: 'direct_service',
    recurring: false,
  },
  {
    id: 'wv-monpower-checkup',
    name: 'Mon Power Home Check-Up Program',
    description: 'Free home energy audit plus installation of energy-saving improvements: insulation, LED bulbs, showerheads, faucet aerators, and possible refrigerator replacement.',
    url: 'https://www.monpower.com/home/assistance-programs',
    applicationNote: 'Call 1-800-207-1250 to see if you qualify.',
    categories: ['utilities','weatherization'],
    eligibility: { incomeLimit: '200% FPL', utilityProvider: 'Mon Power' },
    type: 'grant',
    fundingType: 'direct_service',
    recurring: false,
  },

  // ════════════════════════════════════════
  // CASH ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'wv-works',
    name: 'WV WORKS (TANF Cash Assistance)',
    description: 'Monthly cash assistance for families with children. Also provides job training, education support, transportation help, and emergency assistance.',
    url: 'https://bfa.wv.gov/wv-works',
    applicationUrl: 'https://www.wvpath.wv.gov/',
    categories: ['cash_assistance','employment'],
    eligibility: { incomeLimit: 'WV TANF limits', requiresChildren: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children','single_parent'],
  },

  // ════════════════════════════════════════
  // HEALTHCARE
  // ════════════════════════════════════════
  {
    id: 'wv-medicaid',
    name: 'WV Medicaid',
    description: 'Free health coverage for low-income WV residents. West Virginia expanded Medicaid — adults up to 138% FPL qualify. Covers doctor visits, hospital, prescriptions, dental, vision, mental health, and more.',
    url: 'https://dhhr.wv.gov/bms/Pages/default.aspx',
    applicationUrl: 'https://www.wvpath.wv.gov/',
    categories: ['healthcare'],
    eligibility: { incomeLimit: '138% FPL for adults' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  },
  {
    id: 'wv-chip',
    name: 'WV CHIP (Children\'s Health Insurance)',
    description: 'Health coverage for children in families with income too high for Medicaid but who can\'t afford private insurance. Covers medical, dental, vision, mental health, and prescriptions.',
    url: 'https://chip.wv.gov/',
    applicationUrl: 'https://www.wvpath.wv.gov/',
    categories: ['healthcare'],
    eligibility: { incomeLimit: '300% FPL for children' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children'],
  },

  // ════════════════════════════════════════
  // HOUSING
  // ════════════════════════════════════════
  {
    id: 'wv-housing-dev-fund',
    name: 'WV Housing Development Fund Programs',
    description: 'Multiple housing programs including Home4Good (homelessness), Affordable Housing Fund, and the National Housing Trust Fund for extremely low-income rental housing.',
    url: 'https://www.wvhdf.com/programs',
    categories: ['housing'],
    eligibility: { incomeLimit: 'Varies by program' },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: false,
  },
  {
    id: 'wv-hud',
    name: 'HUD West Virginia Resources',
    description: 'Federal housing assistance resources for WV including rental assistance, homelessness prevention, housing counseling, and fair housing services.',
    url: 'https://www.hud.gov/states/west-virginia',
    categories: ['housing'],
    eligibility: { incomeLimit: 'Varies by program' },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: false,
  },

  // ════════════════════════════════════════
  // CLOTHING / SCHOOL
  // ════════════════════════════════════════
  {
    id: 'wv-school-clothing',
    name: 'WV School Clothing Allowance',
    description: 'Annual $200 allowance for school clothing for each eligible child. Applied through WV PATH along with other benefits.',
    url: 'https://bfa.wv.gov/Pages/default.aspx',
    applicationUrl: 'https://www.wvpath.wv.gov/',
    categories: ['clothing','education'],
    eligibility: { incomeLimit: 'SNAP/WV WORKS income limits', requiresSchoolAgeChildren: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    maxAmount: 200,
    familyMatch: ['has_children'],
  },

  // ════════════════════════════════════════
  // LOCAL EMERGENCY ASSISTANCE (WV-wide nonprofits)
  // ════════════════════════════════════════
  {
    id: 'wv-cap-network',
    name: 'WV Community Action Partnership Network',
    description: 'Local Community Action Agencies in all 55 WV counties providing emergency assistance with utilities, rent, food, transportation, and case management.',
    url: 'https://wvcap.org/agencies/',
    categories: ['utilities','housing','food','transportation','cash_assistance'],
    eligibility: { incomeLimit: 'Varies — typically 125-200% FPL' },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
  },
  {
    id: 'wv-211',
    name: 'WV 211 — Connect to Help',
    description: 'Free referral service connecting you to local assistance for utilities, food, housing, healthcare, employment, and more. Available 24/7 by phone or online.',
    url: 'https://wv211.org/',
    applicationNote: 'Dial 2-1-1 from any phone, or visit wv211.org',
    categories: ['utilities','housing','food','healthcare','cash_assistance','employment','mental_health','legal','transportation','childcare'],
    type: 'referral',
    fundingType: 'referral_service',
    recurring: true,
  },
];

// ── County-specific contacts ──
export const COUNTY_RESOURCES = {
  nicholas: {
    cap: {
      name: 'Nicholas County Community Action',
      phone: '304-872-1162',
      address: '1205 Broad Street, Summersville, WV 26651',
      services: ['utilities','housing','food','transportation','weatherization'],
    },
    dhhr: {
      name: 'WV DHHR Nicholas County Office',
      phone: '304-872-0803',
      services: ['snap','medicaid','tanf','lieap'],
    },
  },
  kanawha: {
    cap: {
      name: 'Kanawha Valley Community Action (KVCA)',
      phone: '304-414-4475',
      services: ['utilities','housing','food','transportation','weatherization'],
    },
  },
  // Additional counties follow the same pattern
};

export default { STATE_META, STATE_BENEFITS, COUNTY_RESOURCES };
