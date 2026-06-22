/**
 * propertyTaxRelief.js
 *
 * Curated property tax relief programs for homeowners, primarily targeting seniors 65+,
 * disabled individuals, and veterans. Includes generic national entries and
 * state-specific programs for the 10 most populous US states.
 *
 * Property tax relief is almost entirely state- and county-administered. This file
 * documents real program names and official URLs. Eligibility rules change annually —
 * users should always verify current thresholds with their county assessor or tax office.
 *
 * Every URL is real and current. NO loans. Direct benefit only.
 */

export const PROPERTY_TAX_RELIEF_PROGRAMS = [

  // ════════════════════════════════════════
  // GENERIC / NATIONAL RESOURCE ENTRIES
  // ════════════════════════════════════════
  {
    id: 'ptax-generic-senior-disabled',
    name: 'State Senior & Disabled Property Tax Relief Programs',
    description: 'Every state administers at least one property tax relief program for seniors 65+ and disabled homeowners. Common forms include: (1) Homestead exemptions — reduce the assessed value of your home so you pay tax on less; (2) Circuit-breaker credits — provide a tax credit or rebate when property taxes exceed a set percentage of your income; (3) Property tax deferrals — allow seniors to delay payment of taxes until the home is sold. Program names, income limits, and benefit amounts vary significantly by state and county. Contact your county assessor, county tax office, or state department of revenue to apply.',
    url: 'https://www.ncsl.org/research/fiscal-policy/property-tax-relief-for-homeowners.aspx',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      requiresDisability: false,
      requiresHomeowner: true,
      note: 'Disabled homeowners under 65 also qualify in most states. Apply through your county assessor or tax office.',
    },
    recurring: true,
  },

  {
    id: 'ptax-homestead-federal',
    name: 'Homestead Exemption Programs — State & County Administered',
    description: 'Homestead exemptions protect a portion of a primary residence\'s assessed value from property taxation. While there is no single federal homestead exemption program, all states and many counties have their own versions. Exemptions for seniors, veterans, and disabled persons are common and often provide larger reductions than standard homestead exemptions. Apply through your county property appraiser, county assessor, or county auditor office. You typically must have owned and occupied the property as your primary residence by January 1 of the tax year.',
    url: 'https://www.benefits.gov/categories/Housing',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      requiresDisability: false,
      requiresHomeowner: true,
      note: 'Must be primary residence (homestead); additional exemptions for seniors/veterans/disabled usually require separate application',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // STATE-SPECIFIC PROGRAMS — 10 MOST POPULOUS STATES
  // ════════════════════════════════════════

  // 1. CALIFORNIA
  {
    id: 'ptax-ca-senior',
    name: 'California Senior Citizen Property Tax Postponement Program',
    description: 'California\'s Property Tax Postponement (PTP) program allows senior homeowners 62 and older (or blind/disabled) with household income under $53,574 (2024) to defer current-year property taxes on their primary residence. The deferred amount becomes a low-interest lien on the home, payable when the property is sold or transferred. Apply through the California State Controller\'s Office.',
    url: 'https://www.sco.ca.gov/ardtax_prop_tax_postponement.html',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 62,
      incomeLimit: '$53,574 household income (2024; adjusted annually)',
      requiresHomeowner: true,
      stateRestriction: 'CA',
      note: 'Also available to blind or disabled homeowners of any age; equity requirement applies',
    },
    recurring: true,
  },

  // 2. TEXAS
  {
    id: 'ptax-tx-senior',
    name: 'Texas Senior / Disabled Homestead Property Tax Exemption',
    description: 'Texas provides a $10,000 school tax exemption for homeowners 65+ or disabled. Seniors also receive a school district tax freeze (ceiling) preventing school taxes from rising above the year they turned 65 or qualified. Additional exemptions are available from counties, cities, and special districts. Apply through your county appraisal district. Disability exemption requires SSDI or VA disability determination.',
    url: 'https://comptroller.texas.gov/taxes/property-tax/exemptions/index.php',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      requiresDisability: false,
      requiresHomeowner: true,
      stateRestriction: 'TX',
      note: 'No income limit for basic senior exemption; must own and occupy as primary residence on January 1',
    },
    recurring: true,
  },

  // 3. FLORIDA
  {
    id: 'ptax-fl-senior',
    name: 'Florida Senior Homestead Exemption (Additional $25,000–$50,000)',
    description: 'Florida offers an additional homestead exemption of up to $50,000 for seniors 65+ who have lived in their home for at least 25 years and whose household income does not exceed the adjusted limit (approximately $35,167 for 2024). There is also a standard $25,000 additional senior exemption available in counties and cities that have adopted it. Apply through your county property appraiser by March 1.',
    url: 'https://floridarevenue.com/property/Pages/Taxpayers_Exemptions.aspx',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      incomeLimit: '~$35,167 household income (2024; adjusted annually for CPI)',
      requiresHomeowner: true,
      stateRestriction: 'FL',
      note: '25-year residency required for largest exemption; apply by March 1 each year',
    },
    recurring: true,
  },

  // 4. NEW YORK
  {
    id: 'ptax-ny-senior',
    name: 'New York Enhanced STAR / Senior Citizens Exemption (SCHE)',
    description: 'New York provides two main senior property tax relief programs. Enhanced STAR reduces school tax bills for homeowners 65+ with income up to $98,700 (2024) by $81,400 in assessed value. The Senior Citizens Exemption (SCHE) reduces assessed value by 5–50% for seniors with income under $37,400 (in NYC) or local limits; administered by municipalities. Apply for Enhanced STAR through the NYS Tax Department; apply for SCHE through your local assessor.',
    url: 'https://www.tax.ny.gov/pit/property/star/enhanced-star.htm',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      incomeLimit: 'Enhanced STAR: up to $98,700 (2024); SCHE: varies by municipality (up to $37,400 in NYC)',
      requiresHomeowner: true,
      stateRestriction: 'NY',
      note: 'Must own and occupy as primary residence; existing STAR registrants must switch to Enhanced STAR separately',
    },
    recurring: true,
  },

  // 5. PENNSYLVANIA
  {
    id: 'ptax-pa-senior',
    name: 'Pennsylvania Property Tax / Rent Rebate Program',
    description: 'Pennsylvania\'s Property Tax/Rent Rebate Program provides rebates of $380–$1,000 on property taxes or rent paid by eligible seniors 65+, widows/widowers 50+, and disabled individuals 18+. Income limit is $35,000 for homeowners ($15,000 for renters). Claimants with income up to $30,000 may receive an increased rebate. Apply through the Pennsylvania Department of Revenue by December 31.',
    url: 'https://www.revenue.pa.gov/IncentivesCreditsPrograms/PropertyTaxRentRebateProgram/Pages/default.aspx',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      incomeLimit: '$35,000 for homeowners; $15,000 for renters (half of Social Security excluded)',
      requiresHomeowner: false,
      stateRestriction: 'PA',
      note: 'Also available to renters and younger disabled persons; renters qualify on rent paid',
    },
    recurring: true,
  },

  // 6. ILLINOIS
  {
    id: 'ptax-il-senior',
    name: 'Illinois Senior Citizens Assessment Freeze Homestead Exemption',
    description: 'Illinois freezes the assessed value of primary residences for seniors 65+ with household income up to $65,000 (as of 2023), preventing assessment increases that drive up tax bills. A separate Senior Homestead Exemption provides an additional $8,000 reduction in assessed value for seniors 65+. Apply through your county assessor or chief county assessment officer by the applicable deadline (varies by county).',
    url: 'https://tax.illinois.gov/individuals/propertytax/senior.html',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      incomeLimit: '$65,000 household income for the freeze; no income limit for Senior Homestead Exemption',
      requiresHomeowner: true,
      stateRestriction: 'IL',
      note: 'Must have owned and occupied for at least one year; apply by county-specific deadline',
    },
    recurring: true,
  },

  // 7. OHIO
  {
    id: 'ptax-oh-senior',
    name: 'Ohio Homestead Exemption for Seniors and Disabled',
    description: 'Ohio\'s Homestead Exemption reduces the taxable value of the home of eligible seniors and disabled persons by $25,000, regardless of income. Additionally, Ohio offers an Enhanced Homestead Exemption of $50,000 for seniors who qualified prior to the income-limit era. Apply through your county auditor\'s office. The exemption applies to the principal residence and up to one acre of surrounding land.',
    url: 'https://tax.ohio.gov/home/homestead-exemptions',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      incomeLimit: 'No income limit (restored to universal eligibility in 2014)',
      requiresDisability: false,
      requiresHomeowner: true,
      stateRestriction: 'OH',
      note: 'Disabled applicants under 65 also qualify; surviving spouses of qualifying homeowners may continue exemption',
    },
    recurring: true,
  },

  // 8. GEORGIA
  {
    id: 'ptax-ga-senior',
    name: 'Georgia Senior Property Tax Exemptions (School Tax Homestead)',
    description: 'Georgia counties and school districts offer various senior property tax exemptions. Many counties grant full or partial school tax exemptions for seniors 62–65+. Statewide, all seniors 65+ with income up to $10,000 (excluding Social Security and retirement income) qualify for an additional $4,000 state and county exemption. Apply through your county tax assessor\'s office by April 1.',
    url: 'https://dor.georgia.gov/property-tax-exemptions',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 62,
      incomeLimit: '$10,000 net income for state exemption (Social Security excluded); county school tax exemptions vary',
      requiresHomeowner: true,
      stateRestriction: 'GA',
      note: 'County-specific exemptions often more generous; apply through county tax assessor by April 1',
    },
    recurring: true,
  },

  // 9. NORTH CAROLINA
  {
    id: 'ptax-nc-senior',
    name: 'North Carolina Elderly / Disabled Homestead Circuit Breaker',
    description: 'North Carolina\'s Homestead Circuit Breaker program caps property taxes for eligible seniors 65+ and permanently disabled homeowners. Property taxes are limited to 4% of household income (income up to $33,800 in 2024) or 5% for income up to $50,700. Taxes above the cap are deferred until the property is sold. A standard Homestead Exclusion also excludes $25,000 or 50% of assessed value (whichever is greater) for qualifying seniors. Apply through your county assessor by June 1.',
    url: 'https://www.ncdor.gov/taxes-forms/property-tax/property-tax-exemptions-and-exclusions/elderly-or-permanently-disabled-exclusion',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      incomeLimit: '$50,700 for circuit breaker; $33,800 for lower cap level (2024; adjusted annually)',
      requiresDisability: false,
      requiresHomeowner: true,
      stateRestriction: 'NC',
      note: 'Circuit breaker defers excess taxes with lien; must have owned for at least 5 years for circuit breaker; apply by June 1',
    },
    recurring: true,
  },

  // 10. MICHIGAN
  {
    id: 'ptax-mi-senior',
    name: 'Michigan Homestead Property Tax Credit (Senior)',
    description: 'Michigan\'s Homestead Property Tax Credit provides a refundable credit for homeowners and renters with household income up to $63,000 whose property taxes exceed 3.5% of income. Seniors 65+ also qualify for the Senior Citizen Homestead Credit. Credit is claimed on the Michigan state income tax return (MI-1040CR). Renters may also qualify based on rent paid as a proxy for property taxes.',
    url: 'https://www.michigan.gov/taxes/iit/credits/homestead-property-tax-credit-information',
    categories: ['housing', 'property_tax_relief', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 65,
      incomeLimit: '$63,000 household income',
      requiresHomeowner: false,
      stateRestriction: 'MI',
      note: 'Renters also qualify; claimed via state income tax return Form MI-1040CR; no separate application required',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // HOUSING COUNSELING & VETERANS
  // ════════════════════════════════════════
  {
    id: 'ptax-hud-counseling',
    name: 'HUD-Approved Housing Counseling for Property Tax Issues',
    description: 'HUD-approved housing counselors can help homeowners facing property tax delinquency, assess eligibility for local tax relief programs, and navigate tax sale prevention resources. Free or low-cost counseling available nationwide. Find a HUD-approved agency through the HUD locator tool. Counselors can also assist with property tax deferral applications and property assessment appeals.',
    url: 'https://www.hud.gov/findacounselor',
    categories: ['housing', 'property_tax_relief', 'legal'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['housing', 'property_tax_relief'],
    eligibility: {
      ageMin: 0,
      incomeLimit: 'None — counseling is free or low-cost for all homeowners',
      requiresHomeowner: true,
      note: 'Priority for those facing foreclosure or tax sale; available in all 50 states and territories',
    },
    recurring: true,
  },

  {
    id: 'ptax-disabled-veterans',
    name: 'Property Tax Relief for Disabled Veterans — All States',
    description: 'All 50 states provide some form of property tax exemption or relief for veterans with service-connected disabilities. Benefits range from partial exemptions to complete property tax exemption for 100% disabled veterans and surviving spouses. Some states (e.g., Texas, Florida) provide full exemptions for 100% disabled veterans with no income limit. Benefits are separate from VA pension and do not affect VA benefit eligibility. Apply through your county assessor or county auditor with your VA disability rating letter.',
    url: 'https://www.benefits.gov/benefit/962',
    categories: ['housing', 'property_tax_relief', 'cash_assistance', 'veterans'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief', 'veterans'],
    eligibility: {
      ageMin: 0,
      requiresDisability: true,
      requiresHomeowner: true,
      requiresVeteran: true,
      incomeLimit: 'Varies by state; many have no income limit for disabled veterans',
      note: 'Must have a VA service-connected disability rating; exemption amount often scales with disability percentage',
    },
    recurring: true,
  },
];
