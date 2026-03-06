/**
 * nationalPrograms.js
 * 
 * National nonprofit organizations and foundations that provide
 * direct assistance to individuals. NOT Grants.gov. NOT organizational grants.
 * These are programs where a person can apply and receive help.
 * 
 * Every URL is a real application or intake page.
 * NO loans. NO matching funds.
 */

export const NATIONAL_PROGRAMS = [

  // ════════════════════════════════════════
  // EMERGENCY ASSISTANCE — MULTI-NEED
  // ════════════════════════════════════════
  {
    id: 'np-salvation-army',
    name: 'Salvation Army Emergency Assistance',
    description: 'Emergency help with utilities, rent, food, clothing, and disaster relief. Services vary by location. Contact your local Salvation Army for available programs.',
    url: 'https://www.salvationarmyusa.org/usn/provide-emergency-assistance/',
    categories: ['utilities','housing','food','clothing','cash_assistance'],
    eligibility: { incomeLimit: 'Varies by location — case-by-case' },
    type: 'assistance',
    fundingType: 'direct_service',
      intentMatch: ['utilities', 'housing', 'food'],
  },
  {
    id: 'np-catholic-charities',
    name: 'Catholic Charities Emergency Assistance',
    description: 'Emergency help with rent, utilities, food, prescription assistance, and crisis intervention. Open to all — not restricted by religion. 160+ local agencies nationwide.',
    url: 'https://www.catholiccharitiesusa.org/find-help/',
    categories: ['utilities','housing','food','healthcare','cash_assistance'],
    eligibility: { incomeLimit: 'Case-by-case' },
    type: 'assistance',
    fundingType: 'direct_service',
      intentMatch: ['utilities', 'housing', 'food', 'healthcare'],
  },
  {
    id: 'np-st-vincent',
    name: 'St. Vincent de Paul Society',
    description: 'Emergency financial assistance for rent, utilities, food, prescriptions, and basic needs. Home visits to assess need. Open to all regardless of religion.',
    url: 'https://www.svdpusa.org/assistance-services/',
    categories: ['utilities','housing','food','healthcare','cash_assistance'],
    eligibility: { incomeLimit: 'Case-by-case, home visit assessment' },
    type: 'assistance',
    fundingType: 'direct_service',
      intentMatch: ['utilities', 'housing', 'food', 'healthcare'],
  },
  {
    id: 'np-modest-needs',
    name: 'Modest Needs Self-Sufficiency Grants',
    description: 'One-time grants (typically $500-$1,500) to help people who are temporarily in crisis avoid falling into poverty. Pays bills directly to vendors for rent, utilities, medical, car repair, etc.',
    url: 'https://www.modestneeds.org/index.asp',
    categories: ['utilities','housing','healthcare','transportation','cash_assistance'],
    eligibility: { incomeLimit: 'Must be working/have income, but facing temporary crisis' },
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 1500,
      intentMatch: ['utilities', 'housing', 'healthcare', 'transportation'],
  },
  {
    id: 'np-united-way',
    name: 'United Way 211 — Local Assistance Finder',
    description: 'Connects you to local programs for food, housing, utilities, healthcare, jobs, and crisis services. Available in all 50 states by dialing 2-1-1.',
    url: 'https://www.211.org/',
    categories: ['utilities','housing','food','healthcare','employment','mental_health','legal','childcare','transportation'],
    type: 'referral',
    fundingType: 'referral_service',
      intentMatch: ['utilities', 'housing', 'food', 'healthcare', 'transportation', 'childcare', 'legal'],
  },

  // ════════════════════════════════════════
  // UTILITY / ENERGY ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'np-dollar-energy',
    name: 'Dollar Energy Fund',
    description: 'Utility assistance grants for low-income families to help with gas, electric, and water bills. Operates in PA, OH, WV, VA, and other states.',
    url: 'https://www.dollarenergy.org/',
    categories: ['utilities'],
    eligibility: { incomeLimit: '150-200% FPL depending on program' },
    type: 'grant',
    fundingType: 'direct_grant',
      intentMatch: ['utilities'],
  },
  {
    id: 'np-nef-utility',
    name: 'National Energy Foundation — Utility Programs',
    description: 'Energy education and utility assistance programs. Connects residents with local utility assistance and energy efficiency programs.',
    url: 'https://www.nef1.org/',
    categories: ['utilities','weatherization'],
    type: 'referral',
    fundingType: 'referral_service',
      intentMatch: ['utilities'],
  },

  // ════════════════════════════════════════
  // FOOD
  // ════════════════════════════════════════
  {
    id: 'np-feeding-america',
    name: 'Feeding America — Local Food Bank Finder',
    description: 'Find your nearest food bank for free food distribution. Network of 200+ food banks and 60,000+ food pantries nationwide.',
    url: 'https://www.feedingamerica.org/find-your-local-foodbank',
    categories: ['food'],
    eligibility: { incomeLimit: 'Varies — many have no formal requirements' },
    type: 'assistance',
    fundingType: 'direct_service',
      intentMatch: ['food'],
  },
  {
    id: 'np-meals-on-wheels',
    name: 'Meals on Wheels',
    description: 'Free or low-cost meal delivery for homebound seniors and people with disabilities. Also provides safety checks and social interaction.',
    url: 'https://www.mealsonwheelsamerica.org/find-meals',
    categories: ['food'],
    eligibility: { minAge: 60, homebound: true },
    type: 'assistance',
    fundingType: 'direct_service',
    demographicMatch: ['senior'],
    healthMatch: ['disability','physical_disability'],
      intentMatch: ['food', 'special_needs'],
  },

  // ════════════════════════════════════════
  // HEALTHCARE / PRESCRIPTIONS
  // ════════════════════════════════════════
  {
    id: 'np-needymeds',
    name: 'NeedyMeds — Prescription & Healthcare Assistance',
    description: 'Database of patient assistance programs, discount drug cards, free/low-cost clinics, and disease-specific assistance programs. Free drug discount card saves 0-80% on prescriptions.',
    url: 'https://www.needymeds.org/',
    categories: ['healthcare'],
    type: 'referral',
    fundingType: 'referral_service',
      intentMatch: ['healthcare'],
  },
  {
    id: 'np-rxassist',
    name: 'RxAssist — Prescription Assistance Programs',
    description: 'Comprehensive database of pharmaceutical company patient assistance programs. Many provide free medications to qualifying patients.',
    url: 'https://www.rxassist.org/',
    categories: ['healthcare'],
    type: 'referral',
    fundingType: 'referral_service',
      intentMatch: ['healthcare'],
  },
  {
    id: 'np-paf',
    name: 'Patient Advocate Foundation',
    description: 'Free case management and financial aid for patients with chronic, life-threatening, or debilitating diseases. Co-Pay Relief program covers insurance co-payments.',
    url: 'https://www.patientadvocate.org/',
    categories: ['healthcare','cash_assistance'],
    eligibility: { requiresMedicalCondition: true, incomeLimit: '400% FPL for co-pay relief' },
    type: 'grant',
    fundingType: 'direct_grant',
    healthMatch: ['cancer','chronic_illness','kidney_disease','heart_disease','diabetes','rare_disease','hiv_aids','multiple_sclerosis'],
      intentMatch: ['healthcare', 'special_needs'],
  },
  {
    id: 'np-healthwell',
    name: 'HealthWell Foundation',
    description: 'Grants to cover co-payments, premiums, and other out-of-pocket costs for people with chronic or life-altering conditions. Over 80 disease funds.',
    url: 'https://www.healthwellfoundation.org/',
    categories: ['healthcare'],
    eligibility: { requiresMedicalCondition: true, incomeLimit: '500% FPL (varies by fund)' },
    type: 'grant',
    fundingType: 'direct_grant',
    healthMatch: ['cancer','chronic_illness','kidney_disease','diabetes','rare_disease','hiv_aids','multiple_sclerosis'],
      intentMatch: ['healthcare', 'special_needs'],
  },
  {
    id: 'np-pan-foundation',
    name: 'PAN Foundation (Patient Access Network)',
    description: 'Financial assistance for out-of-pocket costs for people with life-threatening, chronic, or rare diseases. Over 70 disease-specific programs.',
    url: 'https://panfoundation.org/',
    categories: ['healthcare'],
    eligibility: { requiresMedicalCondition: true, incomeLimit: '400% FPL (varies)' },
    type: 'grant',
    fundingType: 'direct_grant',
    healthMatch: ['cancer','chronic_illness','kidney_disease','rare_disease','hiv_aids','multiple_sclerosis'],
      intentMatch: ['healthcare', 'special_needs'],
  },
  {
    id: 'np-acs-grants',
    name: 'American Cancer Society — Patient Programs',
    description: 'Free lodging (Hope Lodge), transportation to treatment, 24/7 helpline, and treatment-related financial assistance for cancer patients.',
    url: 'https://www.cancer.org/support-programs-and-services.html',
    categories: ['healthcare','transportation','housing'],
    eligibility: { requiresCancer: true },
    type: 'assistance',
    fundingType: 'direct_service',
    healthMatch: ['cancer'],
      intentMatch: ['healthcare'],
  },
  {
    id: 'np-kidney-fund',
    name: 'American Kidney Fund — Safety Net Grants',
    description: 'Emergency financial assistance for kidney disease patients. Health Insurance Premium Program helps cover insurance costs. Safety net grants up to $2,000 for treatment-related costs.',
    url: 'https://www.kidneyfund.org/financial-assistance',
    categories: ['healthcare','cash_assistance'],
    eligibility: { requiresKidneyDisease: true, incomeLimit: '150% FPL for some programs' },
    type: 'grant',
    fundingType: 'direct_grant',
    healthMatch: ['kidney_disease'],
    maxAmount: 2000,
      intentMatch: ['healthcare', 'special_needs'],
  },

  // ════════════════════════════════════════
  // MENTAL HEALTH / SUBSTANCE RECOVERY
  // ════════════════════════════════════════
  {
    id: 'np-samhsa-helpline',
    name: 'SAMHSA National Helpline (Free Treatment Referrals)',
    description: 'Free, confidential 24/7 referral service for substance abuse and mental health treatment. Can locate free/sliding-scale treatment in your area.',
    url: 'https://www.samhsa.gov/find-help/national-helpline',
    applicationNote: 'Call 1-800-662-4357 (HELP)',
    categories: ['mental_health','substance_recovery','healthcare'],
    type: 'referral',
    fundingType: 'referral_service',
    healthMatch: ['mental_health','substance_recovery'],
      intentMatch: ['mental_health', 'substance_recovery'],
  },
  {
    id: 'np-samhsa-treatment',
    name: 'SAMHSA Treatment Locator',
    description: 'Find substance abuse and mental health treatment facilities near you. Includes free and sliding-scale programs.',
    url: 'https://findtreatment.gov/',
    categories: ['mental_health','substance_recovery'],
    type: 'referral',
    fundingType: 'referral_service',
    healthMatch: ['mental_health','substance_recovery'],
      intentMatch: ['mental_health', 'substance_recovery'],
  },
  {
    id: 'np-nami',
    name: 'NAMI (National Alliance on Mental Illness)',
    description: 'Free support groups, education programs, and crisis resources. NAMI Helpline provides info and referrals for mental health services.',
    url: 'https://www.nami.org/help',
    applicationNote: 'Call NAMI Helpline: 1-800-950-NAMI (6264)',
    categories: ['mental_health'],
    type: 'assistance',
    fundingType: 'direct_service',
    healthMatch: ['mental_health'],
      intentMatch: ['mental_health'],
  },

  // ════════════════════════════════════════
  // VETERANS (NATIONAL NONPROFITS)
  // ════════════════════════════════════════
  {
    id: 'np-dav',
    name: 'DAV (Disabled American Veterans)',
    description: 'Free claims assistance, transportation to VA facilities, employment support, and emergency financial assistance for disabled veterans.',
    url: 'https://www.dav.org/veterans/i-need-help/',
    categories: ['cash_assistance','transportation','employment','healthcare'],
    eligibility: { requiresVeteran: true },
    type: 'assistance',
    fundingType: 'direct_service',
    militaryMatch: ['veteran','disabled_veteran'],
      intentMatch: ['military', 'healthcare'],
  },
  {
    id: 'np-operation-homefront',
    name: 'Operation Homefront',
    description: 'Financial assistance for military families including mortgage/rent help, utility assistance, food, and critical family support. Also provides transitional housing.',
    url: 'https://www.operationhomefront.org/get-help',
    categories: ['housing','utilities','food','cash_assistance'],
    eligibility: { requiresMilitaryConnection: true },
    type: 'grant',
    fundingType: 'direct_grant',
    militaryMatch: ['veteran','active_duty','military_spouse'],
      intentMatch: ['military', 'housing'],
  },

  // ════════════════════════════════════════
  // DISABILITY (NATIONAL NONPROFITS)
  // ════════════════════════════════════════
  {
    id: 'np-abilityone',
    name: 'AbilityOne / Disability Benefits Help',
    description: 'Employment opportunities for people who are blind or have significant disabilities through one of the largest sources of jobs for this community.',
    url: 'https://www.abilityone.gov/',
    categories: ['employment','disability'],
    eligibility: { requiresDisability: true },
    type: 'assistance',
    fundingType: 'direct_service',
    healthMatch: ['disability','visual_impairment','physical_disability'],
      intentMatch: ['workforce', 'special_needs'],
  },
  {
    id: 'np-nfb',
    name: 'National Federation of the Blind — Assistance Programs',
    description: 'Scholarships, advocacy, assistive technology, and independence training for blind and low-vision individuals.',
    url: 'https://nfb.org/resources',
    categories: ['disability','education','employment'],
    eligibility: { requiresVisualImpairment: true },
    type: 'assistance',
    fundingType: 'direct_service',
    healthMatch: ['visual_impairment'],
      intentMatch: ['special_needs', 'education'],
  },

  // ════════════════════════════════════════
  // WOMEN / DOMESTIC VIOLENCE
  // ════════════════════════════════════════
  {
    id: 'np-nnedv',
    name: 'National Network to End Domestic Violence',
    description: 'Safety planning, legal assistance, emergency shelter, and financial empowerment programs for survivors of domestic violence.',
    url: 'https://nnedv.org/content/getting-help/',
    applicationNote: 'National DV Hotline: 1-800-799-7233',
    categories: ['housing','legal','cash_assistance'],
    type: 'assistance',
    fundingType: 'direct_service',
    familyMatch: ['domestic_violence'],
      intentMatch: ['housing', 'legal'],
  },

  // ════════════════════════════════════════
  // TRANSPORTATION
  // ════════════════════════════════════════
  {
    id: 'np-good-news-garage',
    name: 'Working Cars for Working People (Multiple Programs)',
    description: 'Several national nonprofits provide donated vehicles to people who need a car for work. Includes Good News Garage, 1-800-Charity Cars, and Vehicles for Change.',
    url: 'https://www.1800charitycars.org/',
    categories: ['transportation'],
    eligibility: { incomeLimit: 'Varies — must demonstrate need for employment' },
    type: 'assistance',
    fundingType: 'direct_service',
      intentMatch: ['transportation'],
  },

  // ════════════════════════════════════════
  // BURIAL / FUNERAL
  // ════════════════════════════════════════
  {
    id: 'np-fema-funeral',
    name: 'FEMA Funeral Assistance (Disaster-Related)',
    description: 'Financial assistance for funeral expenses related to a federally declared disaster, including COVID-19 deaths. Up to $9,000 per deceased individual.',
    url: 'https://www.fema.gov/disaster/coronavirus/economic/funeral-assistance',
    categories: ['burial'],
    eligibility: { requiresDisasterRelatedDeath: true },
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 9000,
  },

  // ════════════════════════════════════════
  // TAX ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'np-vita',
    name: 'VITA (Volunteer Income Tax Assistance)',
    description: 'Free tax preparation for people earning $67,000 or less. Helps you claim EITC, Child Tax Credit, and other refundable credits that put cash back in your pocket.',
    url: 'https://www.irs.gov/individuals/free-tax-return-preparation-for-qualifying-taxpayers',
    categories: ['tax','cash_assistance'],
    eligibility: { incomeLimit: '$67,000 annual income' },
    type: 'assistance',
    fundingType: 'direct_service',
  },

  // ════════════════════════════════════════
  // OCCUPATION-SPECIFIC PROGRAMS
  // ════════════════════════════════════════
  {
    id: 'np-teach-grant',
    name: 'TEACH Grant — Teacher Education Assistance',
    description: 'Up to $4,000/year for students completing coursework needed to become a teacher in a high-need field. Requires teaching commitment at a low-income school.',
    url: 'https://studentaid.gov/understand-aid/types/grants/teach',
    categories: ['education','scholarship'],
    eligibility: { requiresStudent: true },
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 4000,
    occupationMatch: ['educator'],
    studentMatch: ['educator'],
    recurring: true,
      intentMatch: ['education'],
  },
  {
    id: 'np-first-responder-childrens',
    name: 'First Responder Children\'s Foundation',
    description: 'Scholarships for children of first responders (firefighters, EMS, law enforcement) and financial assistance for families of fallen first responders.',
    url: 'https://www.1702702.org/',
    categories: ['scholarship','education','cash_assistance'],
    type: 'grant',
    fundingType: 'direct_grant',
    occupationMatch: ['firefighter','ems_worker','law_enforcement'],
    familyMatch: ['has_children'],
      intentMatch: ['education'],
  },
  {
    id: 'np-nurse-corps',
    name: 'NURSE Corps Scholarship & Loan Repayment',
    description: 'Scholarships and loan repayment for nurses, nurse practitioners, and nurse faculty who work in underserved communities. Covers tuition, fees, and monthly stipend.',
    url: 'https://bhw.hrsa.gov/funding/apply-scholarship/nurse-corps',
    categories: ['education','scholarship','healthcare'],
    eligibility: { requiresStudent: true },
    type: 'grant',
    fundingType: 'direct_grant',
    occupationMatch: ['healthcare_worker'],
      intentMatch: ['education', 'healthcare'],
  },
  {
    id: 'np-usda-farm-grants',
    name: 'USDA Farm Programs & Beginning Farmer Grants',
    description: 'Multiple USDA programs for farmers including emergency farm loans, conservation programs, and grants for beginning/socially disadvantaged farmers.',
    url: 'https://www.farmers.gov/fund',
    categories: ['cash_assistance','employment'],
    type: 'grant',
    fundingType: 'direct_grant',
    occupationMatch: ['farmer'],
    geoMatch: ['rural'],
      intentMatch: ['workforce'],
  },
  {
    id: 'np-sba-resources',
    name: 'SBA Small Business Resources & Grants',
    description: 'Small Business Administration resources including grants, counseling, and training for small business owners. Includes programs for minority, women, and veteran-owned businesses.',
    url: 'https://www.sba.gov/funding-programs',
    categories: ['business','cash_assistance','employment'],
    type: 'referral',
    fundingType: 'referral_service',
    occupationMatch: ['small_business_owner','minority_owned_business','women_owned_business'],
    intentMatch: ['business','entrepreneurship','self_employment'],
  },

  // ════════════════════════════════════════
  // IMMIGRATION / REFUGEE PROGRAMS
  // ════════════════════════════════════════
  {
    id: 'np-refugee-resettlement',
    name: 'Office of Refugee Resettlement — Assistance Programs',
    description: 'Comprehensive assistance for refugees including cash and medical assistance, employment services, English language training, and social services.',
    url: 'https://www.acf.hhs.gov/orr/programs',
    categories: ['cash_assistance','healthcare','employment','education','housing'],
    type: 'assistance',
    fundingType: 'direct_service',
    immigrationMatch: ['refugee'],
    eligibility: { requiresImmigrationStatus: true },
      intentMatch: ['housing', 'healthcare', 'workforce'],
  },
  {
    id: 'np-irc',
    name: 'International Rescue Committee (IRC) — Resettlement',
    description: 'Helps refugees and immigrants rebuild their lives with housing, employment, education, health, and legal assistance in 25+ US cities.',
    url: 'https://www.rescue.org/united-states',
    categories: ['housing','employment','education','healthcare','legal'],
    type: 'assistance',
    fundingType: 'direct_service',
    immigrationMatch: ['refugee','new_immigrant','permanent_resident'],
      intentMatch: ['housing', 'healthcare', 'workforce', 'legal'],
  },
  {
    id: 'np-uscri',
    name: 'US Committee for Refugees and Immigrants',
    description: 'Legal services, case management, employment assistance, and integration support for refugees, immigrants, and asylum seekers.',
    url: 'https://refugees.org/',
    categories: ['legal','employment','housing'],
    type: 'assistance',
    fundingType: 'direct_service',
    immigrationMatch: ['refugee','new_immigrant'],
      intentMatch: ['legal', 'housing'],
  },

  // ════════════════════════════════════════
  // GEOGRAPHIC-SPECIFIC (APPALACHIAN/RURAL)
  // ════════════════════════════════════════
  {
    id: 'np-arc',
    name: 'Appalachian Regional Commission — Community Programs',
    description: 'Economic development, workforce training, infrastructure, and community grants across the 13-state Appalachian region. Includes individual assistance through local development districts.',
    url: 'https://www.arc.gov/',
    categories: ['employment','education','housing','utilities'],
    type: 'referral',
    fundingType: 'referral_service',
    geoMatch: ['appalachian','rural'],
      intentMatch: ['workforce', 'utilities'],
  },
  {
    id: 'np-rural-health',
    name: 'HRSA Rural Health Grants & Programs',
    description: 'Healthcare access programs for rural communities including telehealth, workforce development, emergency services, and community health programs.',
    url: 'https://www.hrsa.gov/rural-health',
    categories: ['healthcare'],
    type: 'referral',
    fundingType: 'referral_service',
    geoMatch: ['rural'],
      intentMatch: ['healthcare'],
  },

  // ════════════════════════════════════════
  // TRAFFICKING / DISASTER SURVIVORS
  // ════════════════════════════════════════
  {
    id: 'np-trafficking-hotline',
    name: 'National Human Trafficking Hotline — Survivor Services',
    description: 'Connects trafficking survivors to emergency shelter, legal aid, case management, and victim assistance funds. Available 24/7 in 200+ languages.',
    url: 'https://humantraffickinghotline.org/',
    applicationNote: 'Call 1-888-373-7888 or text 233733',
    categories: ['housing','legal','cash_assistance','healthcare'],
    type: 'assistance',
    fundingType: 'direct_service',
    familyMatch: ['trafficking_survivor'],
      intentMatch: ['housing', 'legal'],
  },
  {
    id: 'np-fema-individual',
    name: 'FEMA Individual Assistance (Disaster Relief)',
    description: 'Financial assistance for housing, personal property, medical, and other disaster-related expenses. Available when disasters are federally declared.',
    url: 'https://www.disasterassistance.gov/',
    categories: ['housing','cash_assistance','utilities'],
    type: 'grant',
    fundingType: 'direct_grant',
    familyMatch: ['disaster_survivor'],
      intentMatch: ['housing'],
  },

  // ════════════════════════════════════════
  // REENTRY / FORMERLY INCARCERATED
  // ════════════════════════════════════════
  {
    id: 'np-reentry',
    name: 'National Reentry Resource Center',
    description: 'Employment, housing, healthcare, and legal resources for people returning from incarceration. Connects to local reentry programs and federal Second Chance Act grants.',
    url: 'https://nationalreentryresourcecenter.org/',
    categories: ['employment','housing','legal','healthcare'],
    type: 'referral',
    fundingType: 'referral_service',
    familyMatch: ['formerly_incarcerated'],
      intentMatch: ['workforce', 'housing', 'legal'],
  },

  // ════════════════════════════════════════
  // FOSTER YOUTH / AGING OUT
  // ════════════════════════════════════════
  {
    id: 'np-foster-club',
    name: 'FosterClub — Youth Aging Out Resources',
    description: 'Resources, scholarships, and peer support for current and former foster youth. Includes Education Training Voucher (ETV) program links worth up to $5,000/year.',
    url: 'https://www.fosterclub.com/resources',
    categories: ['education','scholarship','housing','cash_assistance'],
    type: 'referral',
    fundingType: 'referral_service',
    familyMatch: ['foster_youth'],
      intentMatch: ['education'],
  },
  {
    id: 'np-chafee-etv',
    name: 'Chafee Education & Training Voucher (ETV) Program',
    description: 'Up to $5,000/year for post-secondary education for current and former foster youth up to age 26.',
    url: 'https://www.childwelfare.gov/topics/outofhome/independent/education/',
    categories: ['education','scholarship'],
    eligibility: { requiresStudent: true },
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 5000,
    familyMatch: ['foster_youth'],
    studentMatch: ['foster_youth'],
      intentMatch: ['education'],
  },

  // ════════════════════════════════════════
  // CAREGIVER / GRANDPARENT RAISING
  // ════════════════════════════════════════
  {
    id: 'np-caregiver-action',
    name: 'Caregiver Action Network — Family Caregiver Support',
    description: 'Education, peer support, and resource navigation for family caregivers. Connects to respite care, financial assistance, and caregiver-specific benefits.',
    url: 'https://www.caregiveraction.org/',
    categories: ['healthcare','cash_assistance'],
    type: 'referral',
    fundingType: 'referral_service',
    familyMatch: ['caregiver','grandparent_caregiver'],
      intentMatch: ['healthcare'],
  },
  {
    id: 'np-generations-united',
    name: 'Generations United — Grandfamilies Resources',
    description: 'Legal, financial, and community resources for grandparents and other relatives raising children. Includes state-by-state resource guides.',
    url: 'https://www.gu.org/explore-our-topics/grandfamilies/',
    categories: ['legal','cash_assistance','childcare'],
    type: 'referral',
    fundingType: 'referral_service',
    familyMatch: ['grandparent_caregiver'],
      intentMatch: ['legal', 'childcare'],
  },
];

export default NATIONAL_PROGRAMS;
