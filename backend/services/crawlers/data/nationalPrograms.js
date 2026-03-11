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

  // ════════════════════════════════════════
  // NONPROFIT VEHICLE / EQUIPMENT GRANTS
  // ════════════════════════════════════════
  {
    id: 'np-mobility-van-grant',
    name: 'GrantWatch — Van & Vehicle Grants for Nonprofits',
    description: 'Curated database of van and vehicle grants for nonprofits, churches, and community organizations. Includes 15-passenger vans, buses, and fleet vehicles. Filter by state and eligibility.',
    url: 'https://www.grantwatch.com/cat/41/vehicle-grants.html',
    categories: ['transportation', 'equipment', 'business'],
    type: 'portal',
    fundingType: 'direct_grant',
    intentMatch: ['transportation', 'business'],
  },
  {
    id: 'np-usda-community-facilities',
    name: 'USDA Community Facilities Direct Loan & Grant Program',
    description: 'Grants and low-interest loans for essential community facilities in rural areas including vehicles, vans, and equipment for nonprofits, tribal organizations, and public entities.',
    url: 'https://www.rd.usda.gov/programs-services/community-facilities/community-facilities-direct-loan-grant-program',
    categories: ['equipment', 'transportation', 'business'],
    type: 'benefit',
    fundingType: 'direct_grant',
    intentMatch: ['transportation', 'business'],
  },
  {
    id: 'np-foundations-org',
    name: 'Foundation Directory Online — Equipment & Vehicle Grants',
    description: 'Search engine for foundation grants including vehicle purchases, equipment, and capital expenditures for 501(c)(3) organizations.',
    url: 'https://fconline.foundationcenter.org/',
    categories: ['equipment', 'transportation', 'business'],
    type: 'portal',
    fundingType: 'direct_grant',
    intentMatch: ['business'],
  },
  {
    id: 'np-good360',
    name: 'Good360 — Product Philanthropy for Nonprofits',
    description: 'Connects nonprofits with donated goods including vehicles, equipment, supplies, and technology from corporate donors. Free to join for 501(c)(3) organizations.',
    url: 'https://good360.org/',
    categories: ['equipment', 'transportation', 'business'],
    type: 'portal',
    fundingType: 'in_kind',
    intentMatch: ['business'],
  },

  // ════════════════════════════════════════
  // WORKFORCE / LICENSE REINSTATEMENT
  // ════════════════════════════════════════
  {
    id: 'np-wioa-training',
    name: 'WIOA — Workforce Innovation and Opportunity Act Training Vouchers',
    description: 'Federal funding through local American Job Centers for occupational training, certification exams, license reinstatement classes, and career re-entry programs. Covers tuition for approved training providers including nursing PROBE classes, NCLEX prep, CDL, and more.',
    url: 'https://www.careeronestop.org/LocalHelp/local-help.aspx',
    categories: ['employment', 'education', 'license_reinstatement_support', 'workforce_reentry_training'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    intentMatch: ['employment', 'education', 'license_reinstatement'],
  },
  {
    id: 'np-nurse-reentry',
    name: 'National Council of State Boards of Nursing — Nurse Re-Entry Resources',
    description: 'State-by-state resources for nurses seeking license reinstatement, including PROBE ethics classes, refresher courses, remediation programs, and state board requirements. The NCSBN provides guidance on reinstatement pathways and required professional education.',
    url: 'https://www.ncsbn.org/nursing-regulation/practice/nurse-reentry.page',
    categories: ['employment', 'education', 'healthcare', 'license_reinstatement_support',
      'nursing_reentry_support', 'professional_remediation_funding'],
    type: 'portal',
    fundingType: 'referral_service',
    intentMatch: ['employment', 'healthcare', 'license_reinstatement'],
  },
  {
    id: 'np-hrsa-nurse-corps',
    name: 'HRSA Nurse Corps — Loan Repayment & Scholarship',
    description: 'Federal program providing loan repayment and scholarships for nurses who work in underserved communities. Can help fund nursing education, re-entry, credential restoration, and return-to-practice costs.',
    url: 'https://bhw.hrsa.gov/funding/apply-loan-repayment/nurse-corps',
    categories: ['education', 'healthcare', 'employment', 'nursing_reentry_support'],
    type: 'benefit',
    fundingType: 'direct_grant',
    intentMatch: ['healthcare', 'education', 'license_reinstatement'],
  },
  {
    id: 'np-vocational-rehab',
    name: 'State Vocational Rehabilitation — License & Certification Assistance',
    description: 'State VR agencies can fund professional license reinstatement costs, exam fees, remediation classes, PROBE courses, and training for individuals with disabilities or barriers to employment. Covers board-ordered education, credential evaluations, and return-to-work training.',
    url: 'https://rsa.ed.gov/about/states',
    categories: ['employment', 'education', 'disability', 'license_reinstatement_support',
      'professional_remediation_funding', 'workforce_reentry_training'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['employment', 'disability', 'license_reinstatement'],
  },

  // ════════════════════════════════════════
  // LICENSE REINSTATEMENT / PROBE / PROFESSIONAL REMEDIATION FUNDING
  // ════════════════════════════════════════

  // --- Bucket 1: Workforce Re-entry / Job Training ---
  {
    id: 'np-ajc-reinstatement',
    name: 'American Job Centers — Professional License Reinstatement Training',
    description: 'Local American Job Centers provide WIOA-funded training support for professional license reinstatement, including nursing PROBE ethics classes, board-required remediation courses, recertification exams, and occupational relicensing. Free career counseling and training referrals available.',
    url: 'https://www.careeronestop.org/LocalHelp/AmericanJobCenters/find-american-job-centers.aspx',
    categories: ['license_reinstatement_support', 'workforce_reentry_training', 'employment',
      'professional_remediation_funding', 'education'],
    type: 'portal',
    fundingType: 'direct_benefit',
    recurring: true,
    intentMatch: ['employment', 'education', 'license_reinstatement'],
  },
  {
    id: 'np-wioa-reinstatement-ita',
    name: 'WIOA Individual Training Accounts — License Reinstatement & Remediation Tuition',
    description: 'WIOA Individual Training Accounts (ITAs) through local workforce boards can fund professional license reinstatement courses including PROBE ethics classes, board-required remediation, nursing refresher courses, and recertification training. Available to eligible adults and dislocated workers.',
    url: 'https://www.dol.gov/agencies/eta/wioa',
    categories: ['license_reinstatement_support', 'workforce_reentry_training', 'employment',
      'professional_remediation_funding', 'education'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    intentMatch: ['employment', 'education', 'license_reinstatement'],
  },
  {
    id: 'np-healthcare-workforce-reentry',
    name: 'Health Profession Opportunity Grants (HPOG) — Healthcare Workforce Re-Entry',
    description: 'HHS-funded grants through community organizations supporting healthcare workforce re-entry, including nursing license reinstatement training, remediation courses, PROBE classes, and credential restoration for TANF recipients and low-income individuals returning to healthcare careers.',
    url: 'https://www.acf.hhs.gov/ofa/programs/hpog',
    categories: ['license_reinstatement_support', 'nursing_reentry_support', 'healthcare',
      'employment', 'workforce_reentry_training'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['employment', 'healthcare', 'license_reinstatement'],
  },

  // --- Bucket 2: Professional Licensing / Reinstatement Support ---
  {
    id: 'np-ana-reinstatement',
    name: 'American Nurses Association — Return to Practice & Reinstatement Resources',
    description: 'The ANA provides resources, guidance, and connections to state nursing association programs that support nurses returning to practice after license suspension or lapse. Includes information on PROBE classes, remediation requirements, and financial support pathways for reinstatement.',
    url: 'https://www.nursingworld.org/practice-policy/workforce/',
    categories: ['license_reinstatement_support', 'nursing_reentry_support', 'healthcare', 'employment'],
    type: 'portal',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'employment', 'license_reinstatement'],
  },
  {
    id: 'np-state-nurse-assoc',
    name: 'State Nursing Associations — License Reinstatement Assistance & Advocacy',
    description: 'State nursing associations often provide reinstatement guidance, peer support, financial assistance referrals, and advocacy for nurses navigating board-required remediation, PROBE courses, and return-to-practice requirements. Contact your state association for local support programs.',
    url: 'https://www.nursingworld.org/ana/about/constituent-state/find-your-state/',
    categories: ['license_reinstatement_support', 'nursing_reentry_support', 'healthcare',
      'professional_remediation_funding'],
    type: 'portal',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'license_reinstatement'],
  },
  {
    id: 'np-ncsbn-discipline-resources',
    name: 'NCSBN — Discipline & Remediation Education Resources',
    description: 'The National Council of State Boards of Nursing maintains resources for nurses under board discipline, including information about PROBE ethics courses, professional boundaries education, alternative-to-discipline programs, and required remediation pathways.',
    url: 'https://www.ncsbn.org/nursing-regulation/discipline-and-alt-to-discipline.page',
    categories: ['license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'healthcare', 'education'],
    type: 'portal',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'license_reinstatement'],
  },

  // --- Bucket 3: Employer / Hospital Sponsorship ---
  {
    id: 'np-hospital-reinstatement-sponsor',
    name: 'Hospital Education Departments — License Reinstatement Sponsorship',
    description: 'Many hospitals and healthcare systems sponsor license reinstatement costs for nurses and healthcare workers they wish to retain or recruit. Education departments may cover PROBE class fees, remediation course tuition, and return-to-practice requirements. Contact hospital HR or nursing education departments directly.',
    url: 'https://www.aha.org/workforce-strategies',
    categories: ['license_reinstatement_support', 'nursing_reentry_support', 'healthcare',
      'workforce_reentry_training'],
    type: 'referral',
    fundingType: 'employer_sponsored',
    intentMatch: ['healthcare', 'employment', 'license_reinstatement'],
  },
  {
    id: 'np-employer-tuition-reimbursement',
    name: 'Healthcare Employer Tuition Reimbursement — Reinstatement & Remediation Coverage',
    description: 'Many healthcare employers offer tuition reimbursement programs that can cover board-required remediation courses, PROBE ethics classes, and license reinstatement training as part of return-to-work or retention programs. Check with your employer HR department for eligibility.',
    url: 'https://www.bls.gov/ebs/factsheets/educational-benefits-for-workers.htm',
    categories: ['license_reinstatement_support', 'professional_remediation_funding',
      'employment', 'education'],
    type: 'referral',
    fundingType: 'employer_sponsored',
    intentMatch: ['employment', 'license_reinstatement'],
  },

  // --- Bucket 4: Rehabilitation / Career Recovery / Community Support ---
  {
    id: 'np-community-foundation-reinstatement',
    name: 'Community Foundations — Career Restoration & Professional Training Grants',
    description: 'Over 800 community foundations across the U.S. fund career restoration, professional development, and workforce re-entry programs. Many accept applications for professional license reinstatement assistance, remediation course funding, and healthcare career recovery grants.',
    url: 'https://www.cof.org/community-foundation-locator',
    categories: ['license_reinstatement_support', 'professional_remediation_funding',
      'workforce_reentry_training', 'employment'],
    type: 'portal',
    fundingType: 'direct_grant',
    intentMatch: ['employment', 'license_reinstatement'],
  },
  {
    id: 'np-faith-community-reinstatement',
    name: 'Faith-Based & Community Organizations — Professional Restoration Support',
    description: 'Churches, ministries, and faith-based organizations may provide benevolence funds, sponsorship, or community support for professionals seeking to restore their licenses. Covers costs like PROBE ethics classes, remediation courses, and return-to-work training for nurses and healthcare workers.',
    url: 'https://www.churchlawandtax.com/web/2021/september/benevolence-fund-basics.html',
    categories: ['license_reinstatement_support', 'professional_remediation_funding',
      'workforce_reentry_training'],
    type: 'referral',
    fundingType: 'direct_grant',
    intentMatch: ['license_reinstatement'],
  },
  {
    id: 'np-civic-club-career-grant',
    name: 'Civic Clubs (Rotary, Lions, Kiwanis) — Career Recovery & Training Support',
    description: 'Local Rotary, Lions, and Kiwanis clubs fund community health and career development. Some clubs sponsor professional training, certification costs, and career restoration for healthcare workers. Contact your local club chapter for available career recovery grants.',
    url: 'https://www.rotary.org/en/our-programs/grants',
    categories: ['license_reinstatement_support', 'workforce_reentry_training', 'employment'],
    type: 'portal',
    fundingType: 'direct_grant',
    intentMatch: ['employment', 'license_reinstatement'],
  },

  // --- Bucket 5: Payment Support / Structured Access ---
  {
    id: 'np-probe-program-info',
    name: 'Professional Boundaries & Ethics (PROBE) — Course Information & Payment',
    description: 'The PROBE program provides professional boundaries and ethics education required by many state boards of nursing for license reinstatement. Course costs vary by state. Payment plans and employer reimbursement options may be available. Contact the PROBE provider or your state board for payment assistance options.',
    url: 'https://www.ncsbn.org/nursing-regulation/discipline-and-alt-to-discipline/probe.page',
    categories: ['license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'healthcare', 'education'],
    type: 'portal',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'license_reinstatement'],
  },

  // ════════════════════════════════════════
  // CPR / FIRST AID / SAFETY CERTIFICATION FUNDING
  // ════════════════════════════════════════

  // --- Bucket 1: Workforce Development / Job Training ---
  {
    id: 'np-ajc-cpr-training',
    name: 'American Job Centers — CPR/First Aid Certification Funding',
    description: 'Local American Job Centers (formerly One-Stop Career Centers) provide WIOA-funded training vouchers that cover CPR, First Aid, AED, BLS, and instructor certification costs. Find your nearest center for free certification assistance.',
    url: 'https://www.careeronestop.org/LocalHelp/AmericanJobCenters/find-american-job-centers.aspx',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'employment', 'workforce_training'],
    type: 'portal',
    fundingType: 'direct_benefit',
    recurring: true,
    intentMatch: ['employment', 'education'],
  },
  {
    id: 'np-wioa-certification-vouchers',
    name: 'WIOA Individual Training Accounts — Certification Tuition Assistance',
    description: 'The Workforce Innovation and Opportunity Act (WIOA) provides Individual Training Accounts (ITAs) that pay for certification classes including CPR, First Aid, BLS, ACLS, and instructor courses. Available through local workforce development boards for eligible adults and dislocated workers.',
    url: 'https://www.dol.gov/agencies/eta/wioa',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'employment', 'workforce_training', 'education'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    intentMatch: ['employment', 'education'],
  },
  {
    id: 'np-healthcare-upskilling',
    name: 'Health Profession Opportunity Grants (HPOG) — Healthcare Certification Training',
    description: 'HHS-funded grants through community organizations that pay for healthcare certification training including CPR, First Aid, BLS, CNA, and other health credentials for TANF recipients and low-income individuals.',
    url: 'https://www.acf.hhs.gov/ofa/programs/hpog',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'healthcare', 'employment', 'workforce_training'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['employment', 'healthcare'],
  },

  // --- Bucket 2: Community / Nonprofit / Civic Club Support ---
  {
    id: 'np-rotary-community-grants',
    name: 'Rotary Club — Community Grants & Safety Education Support',
    description: 'Local Rotary Clubs fund community health and safety initiatives including CPR/AED training, instructor certification, and community preparedness programs. Contact your local Rotary Club or district for grant applications.',
    url: 'https://www.rotary.org/en/our-programs/grants',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training', 'volunteer_training_support'],
    type: 'portal',
    fundingType: 'direct_grant',
    intentMatch: ['community_health_training'],
  },
  {
    id: 'np-lions-club-community',
    name: 'Lions Club International — Community Health & Safety Grants',
    description: 'Lions Clubs support community health initiatives including CPR training, AED placement, first aid education, and safety certification sponsorship. Apply through your local Lions Club.',
    url: 'https://www.lionsclubs.org/en/start-our-approach/grant-types',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training'],
    type: 'portal',
    fundingType: 'direct_grant',
    intentMatch: ['community_health_training'],
  },
  {
    id: 'np-community-foundation-safety',
    name: 'Community Foundations — Safety Training & Health Education Grants',
    description: 'Over 800 community foundations across the U.S. fund local health and safety programs. Many accept applications for CPR/First Aid instructor training, community preparedness, and safety education mini-grants.',
    url: 'https://www.cof.org/community-foundation-locator',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training', 'volunteer_training_support'],
    type: 'portal',
    fundingType: 'direct_grant',
    intentMatch: ['community_health_training'],
  },

  // --- Bucket 3: Faith-Based / Church / Ministry ---
  {
    id: 'np-church-benevolence-training',
    name: 'Church Benevolence Funds — Ministry Safety Training Sponsorship',
    description: 'Many churches and faith-based organizations have benevolence funds or community outreach budgets that cover safety training costs including CPR/First Aid certification and instructor courses for volunteers, staff, and community members.',
    url: 'https://www.churchlawandtax.com/web/2021/september/benevolence-fund-basics.html',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training', 'volunteer_training_support'],
    type: 'referral',
    fundingType: 'direct_grant',
    intentMatch: ['community_health_training', 'volunteer_training_support'],
  },

  // --- Bucket 4: Employer / Agency Sponsorship ---
  {
    id: 'np-hospital-education-cpr',
    name: 'Hospital Education Departments — CPR/BLS Instructor Sponsorship',
    description: 'Many hospitals sponsor CPR, BLS, and ACLS instructor training for employees, volunteers, and community health workers. Contact education or volunteer services departments at local hospitals for sponsorship opportunities.',
    url: 'https://cpr.heart.org/en/cpr-courses-and-kits/healthcare-professional/basic-life-support-bls',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'healthcare', 'workforce_training'],
    type: 'referral',
    fundingType: 'employer_sponsored',
    intentMatch: ['healthcare', 'employment'],
  },
  {
    id: 'np-fire-ems-training-fund',
    name: 'Fire/EMS Departments — Public Safety Training Assistance',
    description: 'Many fire departments and EMS agencies provide free or funded CPR, First Aid, and AED training for community members. Some sponsor instructor certification for volunteers who commit to teaching community classes.',
    url: 'https://www.usfa.fema.gov/training/',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training'],
    type: 'referral',
    fundingType: 'direct_benefit',
    intentMatch: ['community_health_training', 'employment'],
  },

  // --- Bucket 5: Childcare / Youth / Community Safety ---
  {
    id: 'np-childcare-cpr-requirement',
    name: 'Child Care & Development Fund (CCDF) — CPR/First Aid Training Support',
    description: 'State CCDF programs often cover CPR and First Aid certification costs for childcare workers, daycare providers, and afterschool program staff as a required health and safety training. Contact your state childcare resource and referral agency.',
    url: 'https://www.acf.hhs.gov/occ/ccdf-reauthorization',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'childcare', 'workforce_training'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['childcare', 'employment'],
  },
  {
    id: 'np-ymca-safety-training',
    name: 'YMCA — Staff & Volunteer Safety Certification Programs',
    description: 'YMCA locations frequently provide free or subsidized CPR, First Aid, and AED training for staff, volunteers, and community members. Many locations also sponsor instructor certification for long-term volunteers.',
    url: 'https://www.ymca.org/what-we-do/youth-development',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training', 'volunteer_training_support'],
    type: 'referral',
    fundingType: 'direct_benefit',
    intentMatch: ['community_health_training', 'childcare'],
  },

  // --- Bucket 6: Public Safety / AED / Training Grants ---
  {
    id: 'np-aha-community-training',
    name: 'American Heart Association — Community CPR Training Resources & Grants',
    description: 'The AHA offers community CPR training programs, instructor development opportunities, and partners with organizations to fund CPR/AED education. Includes Nation of Lifesavers initiative and community training center resources.',
    url: 'https://cpr.heart.org/en/training-programs/community-training-resources',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training'],
    type: 'portal',
    fundingType: 'referral_service',
    intentMatch: ['community_health_training', 'healthcare'],
  },
  {
    id: 'np-redcross-training-aid',
    name: 'American Red Cross — Certification Training & Financial Assistance',
    description: 'The Red Cross offers CPR, First Aid, AED, and instructor training nationwide. Some chapters provide reduced-cost or free training for volunteers, nonprofit staff, and community organizations. Contact your local chapter for scholarship availability.',
    url: 'https://www.redcross.org/take-a-class/classes/cpr-certification',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training'],
    type: 'portal',
    fundingType: 'referral_service',
    intentMatch: ['community_health_training'],
  },
  {
    id: 'np-fema-community-preparedness',
    name: 'FEMA Community Emergency Response Team (CERT) — Free Safety Training',
    description: 'FEMA CERT programs offer free community safety training including CPR, First Aid, disaster preparedness, and basic emergency response skills. Available in most communities through local emergency management agencies.',
    url: 'https://www.ready.gov/cert',
    categories: ['certification_assistance', 'cpr_first_aid_training', 'community_health_training'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['community_health_training'],
  },
];

export default NATIONAL_PROGRAMS;
