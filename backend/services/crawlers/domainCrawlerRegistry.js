/**
 * Registry of 60+ domain crawler type configs.
 * Each config has directoryResources with real URLs (official or major directories).
 */

export const DOMAIN_CRAWLER_REGISTRY = [
  // === VETERAN / MILITARY ===
  {
    id: 'veteran_affairs',
    label: 'Veteran Affairs Programs',
    description: 'Grants and benefits for veterans and their families.',
    category: 'veteran',
    requiredSignals: [['military']],
    boostSignals: ['veteran', 'military', 'VA'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'VA Benefits Home', description: 'U.S. Department of Veterans Affairs benefits hub', url: 'https://www.va.gov/benefits/', categories: ['veteran'], keywords: ['veteran', 'benefits'] },
      { title: 'VA Education and Training', description: 'GI Bill and education benefits', url: 'https://www.va.gov/education/', categories: ['veteran', 'education'], keywords: ['GI Bill', 'veteran'] },
      { title: 'VA Housing Assistance', description: 'Home loans and housing grants', url: 'https://www.va.gov/housing-assistance/', categories: ['veteran', 'housing'], keywords: ['veteran', 'housing'] },
      { title: 'Veterans Crisis Line', description: '24/7 support for veterans in crisis', url: 'https://www.veteranscrisisline.net/', categories: ['veteran', 'mental health'], keywords: ['veteran'] },
      { title: 'Veteran Readiness and Employment', description: 'Employment services for veterans', url: 'https://www.benefits.va.gov/vocrehab/', categories: ['veteran', 'employment'], keywords: ['veteran'] },
      { title: 'VA Caregiver Support', description: 'Program of Comprehensive Assistance for Family Caregivers', url: 'https://www.caregiver.va.gov/', categories: ['veteran', 'caregiver'], keywords: ['caregiver'] },
    ],
  },
  {
    id: 'veteran_housing_grants',
    label: 'Veteran Housing Grants',
    description: 'Housing grants and assistance for veterans.',
    category: 'veteran',
    requiredSignals: [['military']],
    boostSignals: ['veteran', 'housing'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Specially Adapted Housing Grant', description: 'VA grant for disability-adapted homes', url: 'https://www.va.gov/housing-assistance/disability-housing-grants/specially-adapted-housing/', categories: ['veteran', 'housing'], keywords: ['SAH', 'veteran'] },
      { title: 'Temporary Residence Adaptation', description: 'Grants for temporary housing adaptation', url: 'https://www.va.gov/housing-assistance/disability-housing-grants/', categories: ['veteran'], keywords: ['veteran'] },
      { title: 'HUD-VASH Voucher Program', description: 'Housing vouchers for homeless veterans', url: 'https://www.va.gov/homeless/hud-vash.asp', categories: ['veteran', 'housing'], keywords: ['veteran', 'homeless'] },
      { title: 'Supportive Services for Veteran Families', description: 'Grants to prevent veteran homelessness', url: 'https://www.va.gov/homeless/ssvf.asp', categories: ['veteran'], keywords: ['veteran'] },
      { title: 'Veterans Housing Grants Overview', description: 'Overview of VA housing grants', url: 'https://www.va.gov/housing-assistance/', categories: ['veteran'], keywords: ['veteran'] },
      { title: 'State Veterans Homes', description: 'State-run veterans nursing homes', url: 'https://www.va.gov/geriatrics/guide/longtermcare/state_veterans_homes.asp', categories: ['veteran'], keywords: ['veteran'] },
    ],
  },
  {
    id: 'disabled_veteran_business_grants',
    label: 'Disabled Veteran Business Grants',
    description: 'Grants and programs for veteran-owned and service-disabled veteran-owned businesses.',
    category: 'veteran',
    requiredSignals: [['military']],
    boostSignals: ['veteran', 'business', 'SDVOSB'],
    strict_no_loans: true,
    strict_no_matching: true,
    directoryResources: [
      { title: 'VA VetBiz Verification', description: 'Get verified as a veteran-owned business', url: 'https://www.va.gov/osdbu/verification/', categories: ['veteran', 'business'], keywords: ['SDVOSB', 'VOSB'] },
      { title: 'SBA Veteran-Owned Business Programs', description: 'SBA programs for veteran entrepreneurs', url: 'https://www.sba.gov/funding-programs/entrepreneurs/veterans', categories: ['veteran', 'business'], keywords: ['veteran'] },
      { title: 'Bootstrap Fund for Veterans', description: 'Grant programs for veteran-owned small businesses', url: 'https://www.sba.gov/funding-programs/entrepreneurs/veterans', categories: ['veteran'], keywords: ['veteran'] },
      { title: 'Veteran Business Outreach Centers', description: 'VBOC assistance and training', url: 'https://www.sba.gov/local-assistance/find/?type=Veteran%20Business%20Development&pageNumber=1', categories: ['veteran', 'business'], keywords: ['veteran'] },
      { title: 'National Veterans Business Development Council', description: 'Resources for veteran entrepreneurs', url: 'https://www.nvbdc.org/', categories: ['veteran'], keywords: ['veteran'] },
      { title: 'SCORE Veterans', description: 'Free mentoring for veteran business owners', url: 'https://www.score.org/veterans', categories: ['veteran'], keywords: ['veteran'] },
    ],
  },
  {
    id: 'military_spouse_entrepreneurship',
    label: 'Military Spouse Entrepreneurship',
    description: 'Grants and programs for military spouses starting businesses.',
    category: 'veteran',
    requiredSignals: [['military']],
    boostSignals: ['military spouse', 'entrepreneur'],
    strict_no_loans: true,
    strict_no_matching: true,
    directoryResources: [
      { title: 'MilSpouse Entrepreneur Program', description: 'Resources for military spouse business owners', url: 'https://www.sba.gov/funding-programs/entrepreneurs/veterans', categories: ['military spouse'], keywords: ['military spouse'] },
      { title: 'In-Venture Military Spouse Program', description: 'Business training for military spouses', url: 'https://www.sba.gov/local-assistance/find/?type=Veteran%20Business%20Development', categories: ['military spouse'], keywords: ['military spouse'] },
      { title: 'National Military Family Association', description: 'Resources for military families', url: 'https://www.militaryfamily.org/', categories: ['military'], keywords: ['military family'] },
      { title: 'Blue Star Families', description: 'Support for military families', url: 'https://bluestarfam.org/', categories: ['military'], keywords: ['military'] },
      { title: 'SBA Women-Owned Business Programs', description: 'Programs for women entrepreneurs including military spouses', url: 'https://www.sba.gov/funding-programs/entrepreneurs/women', categories: ['military spouse'], keywords: ['women'] },
      { title: 'Association of Military Spouse Entrepreneurs', description: 'Network and resources', url: 'https://www.americaspouse.org/', categories: ['military spouse'], keywords: ['military spouse'] },
    ],
  },
  {
    id: 'gold_star_family_support',
    label: 'Gold Star Family Support',
    description: 'Programs and benefits for Gold Star families.',
    category: 'veteran',
    requiredSignals: [['military']],
    boostSignals: ['gold star', 'survivor'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'VA Survivors and Dependents', description: 'Benefits for surviving family members', url: 'https://www.va.gov/family-member-benefits/', categories: ['gold star'], keywords: ['survivor'] },
      { title: 'Gold Star Wives of America', description: 'Support organization for Gold Star spouses', url: 'https://www.goldstarwives.org/', categories: ['gold star'], keywords: ['gold star'] },
      { title: 'Tragedy Assistance Program for Survivors', description: 'TAPS support for military survivors', url: 'https://www.taps.org/', categories: ['gold star'], keywords: ['survivor'] },
      { title: 'American Gold Star Mothers', description: 'Support for Gold Star mothers', url: 'https://www.goldstarmoms.com/', categories: ['gold star'], keywords: ['gold star'] },
      { title: 'Fisher House Foundation', description: 'Housing for military families during medical treatment', url: 'https://fisherhouse.org/', categories: ['military'], keywords: ['military'] },
      { title: 'Children of Fallen Patriots', description: 'Scholarships for children of fallen service members', url: 'https://www.fallenpatriots.org/', categories: ['gold star'], keywords: ['scholarship'] },
    ],
  },

  // === BUSINESS STARTUP ===
  {
    id: 'business_startup_grants',
    label: 'Business Startup Grants',
    description: 'Grants (not loans) for new business owners. Excludes loans and matching-fund programs.',
    category: 'business',
    requiredSignals: [['occupation'], ['demographics']],
    boostSignals: ['startup', 'small business', 'entrepreneur'],
    strict_no_loans: true,
    strict_no_matching: true,
    directoryResources: [
      { title: 'Grants.gov', description: 'Federal grant opportunities', url: 'https://www.grants.gov/', categories: ['business', 'federal'], keywords: ['grant'] },
      { title: 'SBA Small Business Grants', description: 'SBA grant programs overview', url: 'https://www.sba.gov/funding-programs/grants', categories: ['business'], keywords: ['small business'] },
      { title: 'USA.gov Business Grants', description: 'Government grants for businesses', url: 'https://www.usa.gov/business-grants-loans', categories: ['business'], keywords: ['grant'] },
      { title: 'Minority Business Development Agency', description: 'MBDA grants and resources', url: 'https://www.mbda.gov/', categories: ['business', 'minority'], keywords: ['minority'] },
      { title: 'USDA Rural Business Development', description: 'Grants for rural businesses', url: 'https://www.rd.usda.gov/programs-services/business-programs', categories: ['business', 'rural'], keywords: ['rural'] },
      { title: 'Economic Development Administration', description: 'EDA grants for economic development', url: 'https://www.eda.gov/grants', categories: ['business'], keywords: ['grant'] },
    ],
  },
  {
    id: 'women_owned_business_grants',
    label: 'Women-Owned Business Grants',
    description: 'Grants for women entrepreneurs. No loans or matching-fund programs.',
    category: 'business',
    requiredSignals: [['demographics']],
    boostSignals: ['women', 'female', 'entrepreneur'],
    strict_no_loans: true,
    strict_no_matching: true,
    directoryResources: [
      { title: 'SBA Women-Owned Small Business', description: 'WOSB certification and programs', url: 'https://www.sba.gov/funding-programs/entrepreneurs/women', categories: ['business', 'women'], keywords: ['women'] },
      { title: 'Amber Grant Foundation', description: 'Monthly grants for women business owners', url: 'https://ambergrantsforwomen.com/', categories: ['women', 'business'], keywords: ['women'] },
      { title: 'Cartier Women\'s Initiative', description: 'Awards for women entrepreneurs', url: 'https://www.cartierwomensinitiative.com/', categories: ['women'], keywords: ['women'] },
      { title: 'Eileen Fisher Grant Program', description: 'Grants for women-owned businesses', url: 'https://www.eileenfisher.com/our-company/leadership/', categories: ['women'], keywords: ['women'] },
      { title: 'National Association of Women Business Owners', description: 'NAWBO resources and opportunities', url: 'https://www.nawbo.org/', categories: ['women', 'business'], keywords: ['women'] },
      { title: 'IFundWomen', description: 'Crowdfunding and grants for women', url: 'https://ifundwomen.com/', categories: ['women'], keywords: ['women'] },
    ],
  },
  {
    id: 'minority_owned_business_grants',
    label: 'Minority-Owned Business Grants',
    description: 'Grants for minority-owned businesses. No loans or matching-fund programs.',
    category: 'business',
    requiredSignals: [['demographics']],
    boostSignals: ['minority', 'diverse'],
    strict_no_loans: true,
    strict_no_matching: true,
    directoryResources: [
      { title: 'Minority Business Development Agency', description: 'Federal grants for minority-owned firms', url: 'https://www.mbda.gov/', categories: ['minority', 'business'], keywords: ['minority'] },
      { title: 'SBA 8(a) Business Development', description: 'Program for disadvantaged businesses', url: 'https://www.sba.gov/funding-programs/contracting/8a-business-development-program', categories: ['minority'], keywords: ['8a'] },
      { title: 'National Minority Supplier Development Council', description: 'NMSDC certification and resources', url: 'https://nmsdc.org/', categories: ['minority'], keywords: ['minority'] },
      { title: 'Operation Hope', description: 'Financial empowerment for minority communities', url: 'https://www.operationhope.org/', categories: ['minority'], keywords: ['minority'] },
      { title: 'Native American Business Development', description: 'Resources for Native entrepreneurs', url: 'https://www.sba.gov/funding-programs/entrepreneurs/native-americans', categories: ['minority', 'native'], keywords: ['native'] },
      { title: 'Asian Pacific Islander American Scholarship Fund', description: 'Scholarships and business support', url: 'https://apiasf.org/', categories: ['minority'], keywords: ['API'] },
    ],
  },
  {
    id: 'rural_small_business_grants',
    label: 'Rural Small Business Grants',
    description: 'Grants for rural small businesses. Excludes loans.',
    category: 'business',
    requiredSignals: [],
    boostSignals: ['rural', 'small business'],
    strict_no_loans: true,
    strict_no_matching: true,
    directoryResources: [
      { title: 'USDA Rural Business Development Grants', description: 'RBDG program for rural areas', url: 'https://www.rd.usda.gov/programs-services/business-programs/rural-business-development-grants', categories: ['rural', 'business'], keywords: ['rural'] },
      { title: 'USDA Rural Energy for America', description: 'REAP grants for rural energy', url: 'https://www.rd.usda.gov/programs-services/energy-programs/rural-energy-america-program-reap', categories: ['rural'], keywords: ['rural'] },
      { title: 'Appalachian Regional Commission', description: 'ARC grants for Appalachian region', url: 'https://www.arc.gov/grants/', categories: ['rural', 'appalachian'], keywords: ['rural'] },
      { title: 'Delta Regional Authority', description: 'DRA grants for Delta region', url: 'https://dra.gov/funding-programs/', categories: ['rural'], keywords: ['rural'] },
      { title: 'Rural Development State Offices', description: 'State-level rural development', url: 'https://www.rd.usda.gov/about-rd/state-offices', categories: ['rural'], keywords: ['rural'] },
      { title: 'Small Business Administration Rural', description: 'SBA rural business resources', url: 'https://www.sba.gov/local-assistance', categories: ['rural'], keywords: ['rural'] },
    ],
  },
  {
    id: 'food_truck_startup_grants',
    label: 'Food Truck Startup Grants',
    description: 'Grants for food truck and mobile food businesses. No loans.',
    category: 'business',
    requiredSignals: [['occupation']],
    boostSignals: ['food truck', 'mobile food', 'restaurant'],
    strict_no_loans: true,
    strict_no_matching: true,
    directoryResources: [
      { title: 'SBA Restaurant Revitalization', description: 'Restaurant and food business grants', url: 'https://www.sba.gov/funding-programs/loans/restaurant-revitalization-fund', categories: ['food', 'business'], keywords: ['restaurant'] },
      { title: 'FedEx Small Business Grant', description: 'Annual grant contest for small businesses', url: 'https://smallbusinessgrant.fedex.com/', categories: ['business'], keywords: ['small business'] },
      { title: 'Hello Alice Small Business Resources', description: 'Grants and resources for small businesses', url: 'https://helloalice.com/', categories: ['business'], keywords: ['small business'] },
      { title: 'NRAEF Manage My Restaurant', description: 'Restaurant industry resources', url: 'https://www.restaurant.org/education-and-resources', categories: ['food'], keywords: ['restaurant'] },
      { title: 'State Restaurant Associations', description: 'State-level restaurant resources', url: 'https://www.restaurant.org/about-us/state-restaurant-associations', categories: ['food'], keywords: ['restaurant'] },
      { title: 'USDA Value-Added Producer Grants', description: 'VAPG for value-added food products', url: 'https://www.rd.usda.gov/programs-services/value-added-producer-grants', categories: ['food', 'rural'], keywords: ['food'] },
    ],
  },

  // === EMS / FIRE / FIRST RESPONDERS ===
  {
    id: 'ems_equipment_grants',
    label: 'EMS Equipment Grants',
    description: 'Grants for EMS and ambulance equipment.',
    category: 'first responder',
    requiredSignals: [['occupation']],
    boostSignals: ['EMS', 'paramedic', 'ambulance'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'FEMA Assistance to Firefighters Grant', description: 'AFG program for fire and EMS', url: 'https://www.fema.gov/grants/preparedness/firefighters', categories: ['EMS', 'fire'], keywords: ['AFG'] },
      { title: 'Office for State and Local Government', description: 'DHS grant programs', url: 'https://www.dhs.gov/grants', categories: ['EMS'], keywords: ['EMS'] },
      { title: 'NHTSA EMS Grants', description: 'Traffic safety and EMS funding', url: 'https://www.nhtsa.gov/', categories: ['EMS'], keywords: ['EMS'] },
      { title: 'SAMHSA First Responder Grants', description: 'Behavioral health for first responders', url: 'https://www.samhsa.gov/grants', categories: ['EMS'], keywords: ['first responder'] },
      { title: 'State EMS Agencies', description: 'State-level EMS grant information', url: 'https://www.nasemso.org/state-ems-agencies/', categories: ['EMS'], keywords: ['EMS'] },
      { title: 'Rural Health Grants', description: 'HRSA rural health programs', url: 'https://www.hrsa.gov/rural-health', categories: ['EMS', 'rural'], keywords: ['rural'] },
    ],
  },
  {
    id: 'fire_department_funding',
    label: 'Fire Department Funding',
    description: 'Grants for fire departments and firefighting equipment.',
    category: 'first responder',
    requiredSignals: [['occupation']],
    boostSignals: ['fire', 'firefighter'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'FEMA Assistance to Firefighters Grant', description: 'AFG for equipment and training', url: 'https://www.fema.gov/grants/preparedness/firefighters', categories: ['fire'], keywords: ['fire'] },
      { title: 'Staffing for Adequate Fire and Emergency Response', description: 'SAFER grant program', url: 'https://www.fema.gov/grants/preparedness/firefighters/safer', categories: ['fire'], keywords: ['SAFER'] },
      { title: 'Fire Prevention and Safety Grants', description: 'FP&S program', url: 'https://www.fema.gov/grants/preparedness/firefighters/fire-prevention-safety', categories: ['fire'], keywords: ['fire'] },
      { title: 'USFA Grants', description: 'U.S. Fire Administration grant programs', url: 'https://www.usfa.fema.gov/grants/', categories: ['fire'], keywords: ['fire'] },
      { title: 'National Volunteer Fire Council', description: 'Resources for volunteer fire departments', url: 'https://www.nvfc.org/', categories: ['fire'], keywords: ['volunteer fire'] },
      { title: 'Firehouse Subs Foundation', description: 'Grants for fire departments', url: 'https://www.firehousesubsfoundation.org/', categories: ['fire'], keywords: ['fire'] },
    ],
  },
  {
    id: 'first_responder_mental_health_support',
    label: 'First Responder Mental Health Support',
    description: 'Programs and grants for first responder wellness and mental health.',
    category: 'first responder',
    requiredSignals: [['occupation']],
    boostSignals: ['first responder', 'PTSD', 'wellness'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'SAMHSA First Responder Grants', description: 'Behavioral health grants', url: 'https://www.samhsa.gov/grants', categories: ['mental health'], keywords: ['first responder'] },
      { title: 'National Fallen Firefighters Foundation', description: 'Firefighter wellness resources', url: 'https://www.firehero.org/', categories: ['fire', 'mental health'], keywords: ['firefighter'] },
      { title: 'Code Green Campaign', description: 'First responder mental health advocacy', url: 'https://www.codegreencampaign.org/', categories: ['mental health'], keywords: ['first responder'] },
      { title: 'IAFF Center of Excellence', description: 'Firefighter treatment center', url: 'https://www.iaff.org/center-of-excellence/', categories: ['fire'], keywords: ['firefighter'] },
      { title: 'All Clear Foundation', description: 'First responder wellness', url: 'https://www.allclearfoundation.org/', categories: ['first responder'], keywords: ['first responder'] },
      { title: 'VA PTSD Programs', description: 'PTSD treatment for veterans who are first responders', url: 'https://www.ptsd.va.gov/', categories: ['mental health'], keywords: ['PTSD'] },
    ],
  },
  {
    id: 'public_safety_technology_grants',
    label: 'Public Safety Technology Grants',
    description: 'Grants for public safety technology and communications.',
    category: 'first responder',
    requiredSignals: [['occupation']],
    boostSignals: ['technology', 'communications', 'public safety'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'NTIA Public Safety Grants', description: 'Broadband and public safety tech', url: 'https://www.ntia.gov/category/public-safety', categories: ['technology'], keywords: ['public safety'] },
      { title: 'DHS First Responder Tech', description: 'Technology grants for first responders', url: 'https://www.dhs.gov/science-and-technology/first-responder-resources', categories: ['technology'], keywords: ['first responder'] },
      { title: 'DOJ Byrne JAG', description: 'Justice Assistance Grants for technology', url: 'https://bja.ojp.gov/program/edward-byrne-memorial-justice-assistance-grant-jag-program/overview', categories: ['technology'], keywords: ['JAG'] },
      { title: 'FEMA Emergency Management Performance Grant', description: 'EMPG for emergency management', url: 'https://www.fema.gov/grants/emergency-managers/performance', categories: ['public safety'], keywords: ['EMPG'] },
      { title: 'State Homeland Security Grants', description: 'SHSP technology funding', url: 'https://www.fema.gov/grants/emergency-managers/homeland-security', categories: ['public safety'], keywords: ['homeland security'] },
      { title: 'COPS Technology Grants', description: 'Community policing technology', url: 'https://cops.usdoj.gov/grants', categories: ['technology'], keywords: ['COPS'] },
    ],
  },
  {
    id: 'emergency_preparedness_grants',
    label: 'Emergency Preparedness Grants',
    description: 'Grants for emergency preparedness and disaster readiness.',
    category: 'first responder',
    requiredSignals: [],
    boostSignals: ['emergency', 'preparedness', 'disaster'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'FEMA Emergency Management Performance Grant', description: 'EMPG program', url: 'https://www.fema.gov/grants/emergency-managers/performance', categories: ['emergency'], keywords: ['EMPG'] },
      { title: 'FEMA Hazard Mitigation Assistance', description: 'HMA grants for mitigation', url: 'https://www.fema.gov/grants/emergency-managers/hazard-mitigation', categories: ['emergency'], keywords: ['mitigation'] },
      { title: 'CDC Public Health Emergency Preparedness', description: 'PHEP cooperative agreement', url: 'https://www.cdc.gov/cpr/readiness/phep.htm', categories: ['emergency', 'health'], keywords: ['preparedness'] },
      { title: 'DHS Urban Area Security Initiative', description: 'UASI for urban preparedness', url: 'https://www.fema.gov/grants/emergency-managers/homeland-security', categories: ['emergency'], keywords: ['UASI'] },
      { title: 'EPA Water Infrastructure', description: 'Water system emergency preparedness', url: 'https://www.epa.gov/dwcapacity', categories: ['emergency'], keywords: ['water'] },
      { title: 'State Emergency Management Agencies', description: 'State-level preparedness grants', url: 'https://www.fema.gov/about/organization/region', categories: ['emergency'], keywords: ['emergency'] },
    ],
  },

  // === MINORITY / TRIBAL / REGIONAL ===
  {
    id: 'minority_grants',
    label: 'Minority Grants',
    description: 'Grants for racial and ethnic minority individuals and organizations.',
    category: 'minority',
    requiredSignals: [['demographics']],
    boostSignals: ['minority', 'diverse'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'MBDA Business Center', description: 'Minority Business Development Agency', url: 'https://www.mbda.gov/', categories: ['minority'], keywords: ['minority'] },
      { title: 'Office of Minority Health', description: 'HHS minority health resources', url: 'https://minorityhealth.hhs.gov/', categories: ['minority', 'health'], keywords: ['minority'] },
      { title: 'UNCF Scholarships', description: 'Scholarships for Black students', url: 'https://uncf.org/scholarships', categories: ['minority', 'education'], keywords: ['scholarship'] },
      { title: 'Hispanic Scholarship Fund', description: 'Scholarships for Hispanic students', url: 'https://www.hsf.net/', categories: ['minority', 'education'], keywords: ['Hispanic'] },
      { title: 'Asian and Pacific Islander American Scholarship', description: 'APIASF scholarships', url: 'https://apiasf.org/', categories: ['minority'], keywords: ['Asian'] },
      { title: 'Congressional Hispanic Caucus Institute', description: 'CHCI fellowship programs', url: 'https://chci.org/', categories: ['minority'], keywords: ['Hispanic'] },
    ],
  },
  {
    id: 'native_american_tribal_grants',
    label: 'Native American Tribal Grants',
    description: 'Grants for Native American individuals, tribes, and organizations.',
    category: 'minority',
    requiredSignals: [['demographics']],
    boostSignals: ['native', 'tribal', 'indigenous'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Bureau of Indian Affairs', description: 'BIA grant programs', url: 'https://www.bia.gov/service/grants', categories: ['native'], keywords: ['Native American'] },
      { title: 'Indian Health Service', description: 'IHS grants and programs', url: 'https://www.ihs.gov/grants/', categories: ['native', 'health'], keywords: ['Native'] },
      { title: 'Administration for Native Americans', description: 'ANA grant programs', url: 'https://www.acf.hhs.gov/ana', categories: ['native'], keywords: ['Native'] },
      { title: 'Native American Agriculture Fund', description: 'NAAF grants for Native farmers', url: 'https://nativeamericanagriculturefund.org/', categories: ['native'], keywords: ['Native'] },
      { title: 'Catching the Dream', description: 'Scholarships for Native American students', url: 'https://catchingthedream.org/', categories: ['native', 'education'], keywords: ['Native'] },
      { title: 'American Indian College Fund', description: 'Scholarships for Native students', url: 'https://collegefund.org/', categories: ['native'], keywords: ['Native'] },
    ],
  },
  {
    id: 'appalachian_region_funding',
    label: 'Appalachian Region Funding',
    description: 'Grants for the Appalachian region.',
    category: 'regional',
    requiredSignals: [],
    boostSignals: ['appalachian', 'rural'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Appalachian Regional Commission', description: 'ARC grant programs', url: 'https://www.arc.gov/grants/', categories: ['appalachian'], keywords: ['appalachian'] },
      { title: 'ARC POWER Initiative', description: 'Partnerships for Opportunity and Workforce', url: 'https://www.arc.gov/grants/power-initiative/', categories: ['appalachian'], keywords: ['appalachian'] },
      { title: 'ARC Community Infrastructure', description: 'Infrastructure grants', url: 'https://www.arc.gov/grants/', categories: ['appalachian'], keywords: ['appalachian'] },
      { title: 'Appalachian Community Capital', description: 'Business and community development', url: 'https://appalachiancommunitycapital.org/', categories: ['appalachian'], keywords: ['appalachian'] },
      { title: 'ARC Education and Training', description: 'Workforce development', url: 'https://www.arc.gov/grants/', categories: ['appalachian'], keywords: ['appalachian'] },
      { title: 'ARC Health', description: 'Health and substance use grants', url: 'https://www.arc.gov/grants/', categories: ['appalachian'], keywords: ['appalachian'] },
    ],
  },
  {
    id: 'immigrant_refugee_support',
    label: 'Immigrant and Refugee Support',
    description: 'Grants and programs for immigrants and refugees.',
    category: 'demographics',
    requiredSignals: [['demographics']],
    boostSignals: ['immigrant', 'refugee', 'asylum'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Office of Refugee Resettlement', description: 'ORR programs for refugees', url: 'https://www.acf.hhs.gov/orr', categories: ['refugee'], keywords: ['refugee'] },
      { title: 'U.S. Committee for Refugees and Immigrants', description: 'USCRI resources', url: 'https://refugees.org/', categories: ['refugee'], keywords: ['refugee'] },
      { title: 'International Rescue Committee', description: 'IRC refugee assistance', url: 'https://www.rescue.org/', categories: ['refugee'], keywords: ['refugee'] },
      { title: 'Catholic Charities Refugee Services', description: 'Refugee resettlement assistance', url: 'https://www.catholiccharitiesusa.org/', categories: ['refugee'], keywords: ['refugee'] },
      { title: 'UNHCR US', description: 'UN Refugee Agency US office', url: 'https://www.unhcr.org/us/', categories: ['refugee'], keywords: ['refugee'] },
      { title: 'Immigration Advocates Network', description: 'Legal and support resources', url: 'https://www.immigrationadvocates.org/', categories: ['immigrant'], keywords: ['immigrant'] },
    ],
  },
  {
    id: 'lgbtq_grants',
    label: 'LGBTQ+ Grants',
    description: 'Grants and programs for LGBTQ+ individuals and organizations.',
    category: 'demographics',
    requiredSignals: [['demographics']],
    boostSignals: ['LGBTQ', 'LGBT', 'queer'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Point Foundation', description: 'Scholarships for LGBTQ students', url: 'https://pointfoundation.org/', categories: ['LGBTQ', 'education'], keywords: ['LGBTQ'] },
      { title: 'Live Out Loud', description: 'LGBTQ youth scholarships', url: 'https://www.liveoutloud.info/', categories: ['LGBTQ'], keywords: ['LGBTQ'] },
      { title: 'Pride Foundation', description: 'LGBTQ community grants', url: 'https://www.pridefoundation.org/', categories: ['LGBTQ'], keywords: ['LGBTQ'] },
      { title: 'Horizons Foundation', description: 'LGBTQ philanthropy', url: 'https://horizonsfoundation.org/', categories: ['LGBTQ'], keywords: ['LGBTQ'] },
      { title: 'National LGBTQ Task Force', description: 'Advocacy and resources', url: 'https://www.thetaskforce.org/', categories: ['LGBTQ'], keywords: ['LGBTQ'] },
      { title: 'Human Rights Campaign', description: 'HRC resources and programs', url: 'https://www.hrc.org/', categories: ['LGBTQ'], keywords: ['LGBTQ'] },
    ],
  },

  // === EDUCATION ===
  {
    id: 'first_generation_scholarships',
    label: 'First-Generation Scholarships',
    description: 'Scholarships for first-generation college students.',
    category: 'education',
    requiredSignals: [['demographics'], ['academics']],
    boostSignals: ['first generation', 'first-gen'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'TRIO Programs', description: 'Federal TRIO for first-gen students', url: 'https://www2.ed.gov/programs/triostudent/index.html', categories: ['education'], keywords: ['first generation'] },
      { title: 'College Greenlight', description: 'First-gen college resources', url: 'https://www.collegegreenlight.org/', categories: ['education'], keywords: ['first generation'] },
      { title: 'QuestBridge', description: 'Full scholarships for low-income students', url: 'https://www.questbridge.org/', categories: ['education'], keywords: ['first generation'] },
      { title: 'Gates Scholarship', description: 'Scholarships for minority and first-gen', url: 'https://www.thegatesscholarship.org/', categories: ['education'], keywords: ['first generation'] },
      { title: 'Coca-Cola Scholars', description: 'Scholarships for first-gen and diverse students', url: 'https://www.coca-colascholarsfoundation.org/', categories: ['education'], keywords: ['scholarship'] },
      { title: 'Jack Kent Cooke Foundation', description: 'Undergraduate transfer scholarships', url: 'https://www.jkcf.org/', categories: ['education'], keywords: ['scholarship'] },
    ],
  },
  {
    id: 'nursing_student_grants',
    label: 'Nursing Student Grants',
    description: 'Grants and scholarships for nursing students.',
    category: 'education',
    requiredSignals: [['occupation'], ['academics']],
    boostSignals: ['nursing', 'RN', 'BSN'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Nursing Student Loan Forgiveness', description: 'HRSA Nurse Corps', url: 'https://bhw.hrsa.gov/funding/apply-loan-repayment/nurse-corps-loan-repayment-program', categories: ['nursing'], keywords: ['nursing'] },
      { title: 'AACN Scholarships', description: 'American Association of Colleges of Nursing', url: 'https://www.aacnnursing.org/Students/Financial-Aid', categories: ['nursing'], keywords: ['nursing'] },
      { title: 'NSNA Foundation', description: 'National Student Nurses Association scholarships', url: 'https://www.nsna.org/foundation-scholarships.html', categories: ['nursing'], keywords: ['nursing'] },
      { title: 'AfterCollege AACN Scholarship', description: 'Nursing student scholarships', url: 'https://www.aftercollege.com/', categories: ['nursing'], keywords: ['nursing'] },
      { title: 'Tylenol Future Care Scholarship', description: 'Healthcare student scholarships', url: 'https://www.tylenol.com/news/scholarship', categories: ['nursing'], keywords: ['healthcare'] },
      { title: 'HRSA Nursing Workforce Diversity', description: 'NWD grant program', url: 'https://bhw.hrsa.gov/funding/apply-grant/nursing-workforce-diversity', categories: ['nursing'], keywords: ['nursing'] },
    ],
  },
  {
    id: 'trade_school_grants',
    label: 'Trade School Grants',
    description: 'Grants for trade schools and vocational training.',
    category: 'education',
    requiredSignals: [['academics'], ['occupation']],
    boostSignals: ['trade', 'vocational', 'career'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Federal Pell Grant', description: 'Need-based grants for eligible students', url: 'https://studentaid.gov/understand-aid/types/grants/pell', categories: ['education'], keywords: ['Pell'] },
      { title: 'WIOA Workforce Funding', description: 'Workforce Innovation and Opportunity Act', url: 'https://www.dol.gov/agencies/eta/wioa', categories: ['education', 'workforce'], keywords: ['WIOA'] },
      { title: 'Trade School Scholarships', description: 'Scholarship search for trade programs', url: 'https://studentaid.gov/', categories: ['education'], keywords: ['trade'] },
      { title: 'State Workforce Development', description: 'State-level workforce grants', url: 'https://www.careeronestop.org/', categories: ['workforce'], keywords: ['workforce'] },
      { title: 'Skillful Careers', description: 'Career training resources', url: 'https://www.skillful.com/', categories: ['workforce'], keywords: ['career'] },
      { title: 'American Welding Society', description: 'Welding education scholarships', url: 'https://www.aws.org/foundation/scholarships', categories: ['trade'], keywords: ['welding'] },
    ],
  },
  {
    id: 'student_endowments',
    label: 'Student Endowments',
    description: 'Scholarship endowments and institutional aid programs.',
    category: 'education',
    requiredSignals: [['academics']],
    boostSignals: ['scholarship', 'endowment'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Fastweb Scholarship Search', description: 'Scholarship database', url: 'https://www.fastweb.com/', categories: ['education'], keywords: ['scholarship'] },
      { title: 'Scholarships.com', description: 'Scholarship search engine', url: 'https://www.scholarships.com/', categories: ['education'], keywords: ['scholarship'] },
      { title: 'Bold.org', description: 'Scholarships for students', url: 'https://bold.org/scholarships/', categories: ['education'], keywords: ['scholarship'] },
      { title: 'Cappex Scholarships', description: 'College and scholarship matching', url: 'https://www.cappex.com/', categories: ['education'], keywords: ['scholarship'] },
      { title: 'Niche Scholarships', description: 'Scholarship listings', url: 'https://www.niche.com/colleges/scholarships/', categories: ['education'], keywords: ['scholarship'] },
      { title: 'College Board Opportunity Scholarships', description: 'College Board scholarship program', url: 'https://opportunity.collegeboard.org/', categories: ['education'], keywords: ['scholarship'] },
    ],
  },
  {
    id: 'workforce_development_grants',
    label: 'Workforce Development Grants',
    description: 'Grants for workforce training and career development.',
    category: 'education',
    requiredSignals: [['occupation']],
    boostSignals: ['workforce', 'training', 'career'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Department of Labor Grants', description: 'DOL workforce grants', url: 'https://www.dol.gov/agencies/eta/grants', categories: ['workforce'], keywords: ['workforce'] },
      { title: 'WIOA Adult and Dislocated Worker', description: 'WIOA formula grants', url: 'https://www.dol.gov/agencies/eta/wioa', categories: ['workforce'], keywords: ['WIOA'] },
      { title: 'Trade Adjustment Assistance', description: 'TAA for workers impacted by trade', url: 'https://www.dol.gov/agencies/eta/trade-act', categories: ['workforce'], keywords: ['TAA'] },
      { title: 'Apprenticeship.gov', description: 'Registered apprenticeship programs', url: 'https://www.apprenticeship.gov/', categories: ['workforce'], keywords: ['apprenticeship'] },
      { title: 'CareerOneStop', description: 'Training and job resources', url: 'https://www.careeronestop.org/', categories: ['workforce'], keywords: ['career'] },
      { title: 'America\'s Promise Job Driven Grants', description: 'Workforce partnerships', url: 'https://www.dol.gov/agencies/eta', categories: ['workforce'], keywords: ['workforce'] },
    ],
  },
  {
    id: 'displaced_worker_retraining',
    label: 'Displaced Worker Retraining',
    description: 'Grants and programs for displaced workers needing retraining.',
    category: 'education',
    requiredSignals: [['occupation'], ['assistance']],
    boostSignals: ['displaced', 'retraining', 'laid off'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Trade Adjustment Assistance', description: 'TAA for trade-displaced workers', url: 'https://www.dol.gov/agencies/eta/trade-act', categories: ['displaced worker'], keywords: ['TAA'] },
      { title: 'WIOA Dislocated Worker', description: 'Dislocated worker program', url: 'https://www.dol.gov/agencies/eta/wioa', categories: ['displaced worker'], keywords: ['dislocated'] },
      { title: 'Rapid Response Services', description: 'State rapid response for layoffs', url: 'https://www.careeronestop.org/', categories: ['displaced worker'], keywords: ['layoff'] },
      { title: 'Unemployment Training Programs', description: 'Training while unemployed', url: 'https://www.careeronestop.org/', categories: ['displaced worker'], keywords: ['unemployed'] },
      { title: 'Pell Grant for Job Training', description: 'Pell for short-term programs', url: 'https://studentaid.gov/', categories: ['displaced worker'], keywords: ['Pell'] },
      { title: 'State Dislocated Worker Grants', description: 'State-level DWG', url: 'https://www.dol.gov/agencies/eta', categories: ['displaced worker'], keywords: ['dislocated'] },
    ],
  },
  {
    id: 'uaw_strike_relief',
    label: 'UAW Strike Relief',
    description: 'Assistance for UAW members affected by strikes.',
    category: 'labor',
    requiredSignals: [['occupation'], ['assistance']],
    boostSignals: ['UAW', 'strike', 'union'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'UAW Strike Fund', description: 'UAW strike benefits', url: 'https://uaw.org/', categories: ['labor'], keywords: ['UAW'] },
      { title: 'Union Plus Hardship Help', description: 'Union Plus hardship assistance', url: 'https://www.unionplus.org/hardship-help', categories: ['labor'], keywords: ['union'] },
      { title: 'AFL-CIO Community Services', description: 'Labor community services', url: 'https://aflcio.org/', categories: ['labor'], keywords: ['union'] },
      { title: 'United Way 211', description: 'Local assistance referrals', url: 'https://www.211.org/', categories: ['assistance'], keywords: ['assistance'] },
      { title: 'SNAP Emergency Assistance', description: 'Food assistance', url: 'https://www.fns.usda.gov/snap', categories: ['assistance'], keywords: ['SNAP'] },
      { title: 'State Unemployment', description: 'Unemployment benefits', url: 'https://www.careeronestop.org/', categories: ['assistance'], keywords: ['unemployment'] },
    ],
  },
  {
    id: 'labor_union_hardship_funds',
    label: 'Labor Union Hardship Funds',
    description: 'Hardship assistance for union members.',
    category: 'labor',
    requiredSignals: [['occupation']],
    boostSignals: ['union', 'labor', 'hardship'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Union Plus Hardship', description: 'Union Plus hardship programs', url: 'https://www.unionplus.org/hardship-help', categories: ['labor'], keywords: ['union'] },
      { title: 'AFL-CIO Community Services', description: 'Labor assistance', url: 'https://aflcio.org/', categories: ['labor'], keywords: ['union'] },
      { title: 'Union Benefits', description: 'Union member benefits', url: 'https://www.unionplus.org/', categories: ['labor'], keywords: ['union'] },
      { title: 'Union Sportsmen\'s Alliance', description: 'Union member programs', url: 'https://unionsportsmen.org/', categories: ['labor'], keywords: ['union'] },
      { title: '211 Community Resources', description: 'Local assistance', url: 'https://www.211.org/', categories: ['assistance'], keywords: ['assistance'] },
      { title: 'Emergency Food Assistance', description: 'TEFAP and food banks', url: 'https://www.fns.usda.gov/tefap', categories: ['assistance'], keywords: ['food'] },
    ],
  },

  // === ADDITIONAL DOMAIN CRAWLERS (31-60+) ===
  {
    id: 'single_parent_grants',
    label: 'Single Parent Grants',
    description: 'Grants and aid for single parents.',
    category: 'demographics',
    requiredSignals: [['demographics'], ['family']],
    boostSignals: ['single parent', 'single mother', 'single father'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Single Parent Scholarship Fund', description: 'Scholarships for single parents', url: 'https://www.aspsf.org/', categories: ['single parent'], keywords: ['single parent'] },
      { title: 'Patsy Takemoto Mink Award', description: 'Low-income mothers in education', url: 'https://www2.ed.gov/programs/mink/index.html', categories: ['single parent'], keywords: ['single parent'] },
      { title: 'Live Your Dream Awards', description: 'Soroptimist grants for women', url: 'https://www.soroptimist.org/grants.html', categories: ['women'], keywords: ['women'] },
      { title: 'YWCA Resources', description: 'Support for women and families', url: 'https://www.ywca.org/', categories: ['women'], keywords: ['women'] },
      { title: 'United Way 211', description: 'Local family resources', url: 'https://www.211.org/', categories: ['family'], keywords: ['family'] },
      { title: 'Child Care Subsidies', description: 'State child care assistance', url: 'https://www.childcare.gov/', categories: ['family'], keywords: ['child care'] },
    ],
  },
  {
    id: 'cancer_survivor_grants',
    label: 'Cancer Survivor Grants',
    description: 'Grants and assistance for cancer patients and survivors.',
    category: 'health',
    requiredSignals: [['health']],
    boostSignals: ['cancer', 'survivor'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'American Cancer Society', description: 'Patient assistance programs', url: 'https://www.cancer.org/treatment/support-programs-and-services.html', categories: ['cancer'], keywords: ['cancer'] },
      { title: 'Cancer Care', description: 'Financial assistance for cancer patients', url: 'https://www.cancercare.org/', categories: ['cancer'], keywords: ['cancer'] },
      { title: 'Patient Advocate Foundation', description: 'Co-pay relief and assistance', url: 'https://www.patientadvocate.org/', categories: ['cancer'], keywords: ['cancer'] },
      { title: 'Leukemia and Lymphoma Society', description: 'Blood cancer assistance', url: 'https://www.lls.org/', categories: ['cancer'], keywords: ['cancer'] },
      { title: 'Susan G. Komen', description: 'Breast cancer assistance', url: 'https://www.komen.org/', categories: ['cancer'], keywords: ['breast cancer'] },
      { title: 'Cancer Financial Assistance Coalition', description: 'Financial resources', url: 'https://www.cancerfac.org/', categories: ['cancer'], keywords: ['cancer'] },
    ],
  },
  {
    id: 'disability_employment_grants',
    label: 'Disability Employment Grants',
    description: 'Grants for disability employment and workplace accommodations.',
    category: 'disability',
    requiredSignals: [['demographics'], ['assistance']],
    boostSignals: ['disability', 'accommodation'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Vocational Rehabilitation', description: 'State VR services', url: 'https://www2.ed.gov/programs/rsabvrs/index.html', categories: ['disability'], keywords: ['disability'] },
      { title: 'Ticket to Work', description: 'SSA employment program', url: 'https://choosework.ssa.gov/', categories: ['disability'], keywords: ['disability'] },
      { title: 'Job Accommodation Network', description: 'Workplace accommodation ideas', url: 'https://askjan.org/', categories: ['disability'], keywords: ['accommodation'] },
      { title: 'Department of Labor ODEP', description: 'Office of Disability Employment', url: 'https://www.dol.gov/agencies/odep', categories: ['disability'], keywords: ['disability'] },
      { title: 'Ability One', description: 'Employment for people with disabilities', url: 'https://www.abilityone.gov/', categories: ['disability'], keywords: ['disability'] },
      { title: 'Employer Assistance and Resource Network', description: 'EARN disability employment', url: 'https://askearn.org/', categories: ['disability'], keywords: ['disability'] },
    ],
  },
  {
    id: 'senior_citizen_grants',
    label: 'Senior Citizen Grants',
    description: 'Grants and programs for seniors 65+.',
    category: 'demographics',
    requiredSignals: [['demographics']],
    boostSignals: ['senior', 'elderly', '65+'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Administration on Aging', description: 'AoA programs and services', url: 'https://acl.gov/programs/aging-and-disability-networks', categories: ['senior'], keywords: ['senior'] },
      { title: 'Medicare Savings Programs', description: 'Help with Medicare costs', url: 'https://www.medicare.gov/your-medicare-costs/get-help-paying-costs', categories: ['senior'], keywords: ['Medicare'] },
      { title: 'ElderCare Locator', description: 'Local senior resources', url: 'https://eldercare.acl.gov/', categories: ['senior'], keywords: ['senior'] },
      { title: 'Senior Community Service Employment', description: 'SCSEP job training', url: 'https://www.dol.gov/agencies/eta/seniors', categories: ['senior'], keywords: ['senior'] },
      { title: 'AARP Benefits', description: 'AARP programs and discounts', url: 'https://www.aarp.org/benefits-discounts/', categories: ['senior'], keywords: ['senior'] },
      { title: 'LIHEAP', description: 'Energy assistance for seniors', url: 'https://www.acf.hhs.gov/ocs/programs/liheap', categories: ['senior'], keywords: ['energy'] },
    ],
  },
  {
    id: 'foster_youth_grants',
    label: 'Foster Youth Grants',
    description: 'Grants and scholarships for current and former foster youth.',
    category: 'demographics',
    requiredSignals: [['demographics']],
    boostSignals: ['foster', 'emancipated'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Chafee Program', description: 'Education and training vouchers', url: 'https://www.acf.hhs.gov/cb/program-guide/chafee', categories: ['foster youth'], keywords: ['foster'] },
      { title: 'Foster Care to Success', description: 'Scholarships for foster youth', url: 'https://www.fc2success.org/', categories: ['foster youth'], keywords: ['foster'] },
      { title: 'John H. Chafee Foster Care Program', description: 'State Chafee programs', url: 'https://www.acf.hhs.gov/cb/program-guide/chafee', categories: ['foster youth'], keywords: ['foster'] },
      { title: 'National Foster Parent Association', description: 'Foster family resources', url: 'https://nfpaonline.org/', categories: ['foster'], keywords: ['foster'] },
      { title: 'Casey Family Programs', description: 'Foster care support', url: 'https://www.casey.org/', categories: ['foster'], keywords: ['foster'] },
      { title: 'Treehouse for Kids', description: 'Foster youth education', url: 'https://www.treehouseforkids.org/', categories: ['foster youth'], keywords: ['foster'] },
    ],
  },
  {
    id: 'homeless_assistance_grants',
    label: 'Homeless Assistance Grants',
    description: 'Grants and programs to prevent or end homelessness.',
    category: 'assistance',
    requiredSignals: [['assistance']],
    boostSignals: ['homeless', 'housing'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'HUD Homeless Assistance', description: 'Continuum of Care programs', url: 'https://www.hud.gov/homeless', categories: ['homeless'], keywords: ['homeless'] },
      { title: 'Emergency Solutions Grant', description: 'ESG program', url: 'https://www.hud.gov/program_offices/comm_planning/esg', categories: ['homeless'], keywords: ['homeless'] },
      { title: '211 Housing Help', description: 'Local housing resources', url: 'https://www.211.org/', categories: ['homeless'], keywords: ['housing'] },
      { title: 'National Alliance to End Homelessness', description: 'Resources and advocacy', url: 'https://endhomelessness.org/', categories: ['homeless'], keywords: ['homeless'] },
      { title: 'VA Homeless Programs', description: 'Support for homeless veterans', url: 'https://www.va.gov/homeless/', categories: ['homeless', 'veteran'], keywords: ['homeless'] },
      { title: 'Runaway and Homeless Youth', description: 'RHY program for youth', url: 'https://www.acf.hhs.gov/fysb/programs/runaway-homeless-youth', categories: ['homeless'], keywords: ['homeless'] },
    ],
  },
  {
    id: 'domestic_violence_grants',
    label: 'Domestic Violence Grants',
    description: 'Grants and emergency assistance for domestic violence survivors.',
    category: 'assistance',
    requiredSignals: [['assistance']],
    boostSignals: ['domestic violence', 'DV'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'National Domestic Violence Hotline', description: '24/7 support and referrals', url: 'https://www.thehotline.org/', categories: ['domestic violence'], keywords: ['domestic violence'] },
      { title: 'OVW Grants', description: 'Office on Violence Against Women', url: 'https://www.justice.gov/ovw/grant-programs', categories: ['domestic violence'], keywords: ['domestic violence'] },
      { title: 'National Coalition Against Domestic Violence', description: 'NCADV resources', url: 'https://ncadv.org/', categories: ['domestic violence'], keywords: ['domestic violence'] },
      { title: 'FVPSA', description: 'Family Violence Prevention Services', url: 'https://www.acf.hhs.gov/fysb/programs/family-violence-prevention-services', categories: ['domestic violence'], keywords: ['domestic violence'] },
      { title: 'RAINN', description: 'National sexual assault hotline', url: 'https://www.rainn.org/', categories: ['domestic violence'], keywords: ['sexual assault'] },
      { title: 'Safety Net Project', description: 'Technology safety for survivors', url: 'https://www.techsafety.org/', categories: ['domestic violence'], keywords: ['domestic violence'] },
    ],
  },
  {
    id: 'arts_culture_grants',
    label: 'Arts and Culture Grants',
    description: 'Grants for arts, culture, and creative projects.',
    category: 'arts',
    requiredSignals: [['occupation'], ['interests']],
    boostSignals: ['arts', 'culture', 'creative'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'National Endowment for the Arts', description: 'NEA grant programs', url: 'https://www.arts.gov/grants', categories: ['arts'], keywords: ['arts'] },
      { title: 'National Endowment for the Humanities', description: 'NEH grants', url: 'https://www.neh.gov/grants', categories: ['arts'], keywords: ['humanities'] },
      { title: 'State Arts Agencies', description: 'State-level arts funding', url: 'https://www.arts.gov/partners/state-regional', categories: ['arts'], keywords: ['arts'] },
      { title: 'Institute of Museum and Library Services', description: 'IMLS grants', url: 'https://www.imls.gov/grants', categories: ['arts'], keywords: ['museum'] },
      { title: 'ArtPlace America', description: 'Creative placemaking', url: 'https://www.artplaceamerica.org/', categories: ['arts'], keywords: ['arts'] },
      { title: 'Creative Capital', description: 'Artist grants', url: 'https://creative-capital.org/', categories: ['arts'], keywords: ['arts'] },
    ],
  },
  {
    id: 'environmental_grants',
    label: 'Environmental Grants',
    description: 'Grants for environmental conservation and sustainability.',
    category: 'environment',
    requiredSignals: [],
    boostSignals: ['environment', 'conservation', 'sustainability'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'EPA Grants', description: 'Environmental Protection Agency grants', url: 'https://www.epa.gov/grants', categories: ['environment'], keywords: ['environment'] },
      { title: 'National Fish and Wildlife Foundation', description: 'NFWF conservation grants', url: 'https://www.nfwf.org/programs', categories: ['environment'], keywords: ['conservation'] },
      { title: 'USDA Conservation Programs', description: 'NRCS and conservation', url: 'https://www.nrcs.usda.gov/programs', categories: ['environment'], keywords: ['conservation'] },
      { title: 'NOAA Grants', description: 'Ocean and atmospheric grants', url: 'https://www.noaa.gov/grants', categories: ['environment'], keywords: ['environment'] },
      { title: 'National Forest Foundation', description: 'Forest conservation', url: 'https://www.nationalforests.org/', categories: ['environment'], keywords: ['forest'] },
      { title: 'Keep America Beautiful', description: 'Community beautification', url: 'https://kab.org/', categories: ['environment'], keywords: ['environment'] },
    ],
  },
  {
    id: 'faith_based_grants',
    label: 'Faith-Based Organization Grants',
    description: 'Grants for churches and faith-based organizations.',
    category: 'organization',
    requiredSignals: [['demographics']],
    boostSignals: ['church', 'faith', 'ministry'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'USA.gov Faith-Based Funding', description: 'Federal faith-based initiatives and grant programs', url: 'https://www.usa.gov/non-profit-grants', categories: ['faith'], keywords: ['faith'] },
      { title: 'Lilly Endowment', description: 'Religious and community grants', url: 'https://lillyendowment.org/', categories: ['faith'], keywords: ['faith'] },
      { title: 'Scholarships for Ministry', description: 'Seminary and ministry education', url: 'https://studentaid.gov/', categories: ['faith'], keywords: ['ministry'] },
      { title: 'National Council of Churches', description: 'Ecumenical resources', url: 'https://nationalcouncilofchurches.us/', categories: ['faith'], keywords: ['faith'] },
      { title: 'Church Grants Resource', description: 'Grant information for churches', url: 'https://www.grants.gov/', categories: ['faith'], keywords: ['church'] },
      { title: 'Denomination Foundations', description: 'Denomination-specific funding', url: 'https://www.guidestar.org/', categories: ['faith'], keywords: ['faith'] },
    ],
  },
  {
    id: 'animal_welfare_grants',
    label: 'Animal Welfare Grants',
    description: 'Grants for animal rescue and welfare organizations.',
    category: 'organization',
    requiredSignals: [],
    boostSignals: ['animal', 'rescue', 'welfare'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'ASPCA Grants', description: 'Animal welfare grants', url: 'https://www.aspca.org/grants', categories: ['animal'], keywords: ['animal'] },
      { title: 'Petco Love', description: 'Animal welfare funding', url: 'https://petcolove.org/', categories: ['animal'], keywords: ['animal'] },
      { title: 'Maddie\'s Fund', description: 'Shelter and rescue grants', url: 'https://www.maddiesfund.org/', categories: ['animal'], keywords: ['animal'] },
      { title: 'Best Friends Animal Society', description: 'No-kill shelter support', url: 'https://bestfriends.org/', categories: ['animal'], keywords: ['animal'] },
      { title: 'American Humane', description: 'Animal welfare programs', url: 'https://www.americanhumane.org/', categories: ['animal'], keywords: ['animal'] },
      { title: 'Humane Society of the US', description: 'Animal protection resources', url: 'https://www.humanesociety.org/', categories: ['animal'], keywords: ['animal'] },
    ],
  },
  {
    id: 'youth_programs_grants',
    label: 'Youth Programs Grants',
    description: 'Grants for youth development and after-school programs.',
    category: 'education',
    requiredSignals: [],
    boostSignals: ['youth', 'after school', 'mentoring'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: '21st Century Community Learning Centers', description: 'After-school programs', url: 'https://www2.ed.gov/programs/21stcclc/index.html', categories: ['youth'], keywords: ['after school'] },
      { title: 'YouthBuild', description: 'Education and job training for youth', url: 'https://www.dol.gov/agencies/eta/youthbuild', categories: ['youth'], keywords: ['youth'] },
      { title: 'Boys and Girls Clubs', description: 'Youth development', url: 'https://www.bgca.org/', categories: ['youth'], keywords: ['youth'] },
      { title: '4-H', description: 'Youth development program', url: 'https://4-h.org/', categories: ['youth'], keywords: ['youth'] },
      { title: 'YMCA', description: 'Youth and community programs', url: 'https://www.ymca.net/', categories: ['youth'], keywords: ['youth'] },
      { title: 'Big Brothers Big Sisters', description: 'Mentoring programs', url: 'https://www.bbbs.org/', categories: ['youth'], keywords: ['mentoring'] },
    ],
  },
  {
    id: 'housing_development_grants',
    label: 'Housing Development Grants',
    description: 'Grants for affordable housing development.',
    category: 'housing',
    requiredSignals: [],
    boostSignals: ['housing', 'affordable', 'development'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'HUD Community Development Block Grant', description: 'CDBG program', url: 'https://www.hud.gov/program_offices/comm_planning/communitydevelopment', categories: ['housing'], keywords: ['CDBG'] },
      { title: 'HOME Investment Partnerships', description: 'HOME program', url: 'https://www.hud.gov/program_offices/comm_planning/home', categories: ['housing'], keywords: ['HOME'] },
      { title: 'Low Income Housing Tax Credit', description: 'LIHTC program', url: 'https://www.hud.gov/program_offices/housing/mfh/htsf/lihtc', categories: ['housing'], keywords: ['LIHTC'] },
      { title: 'USDA Rural Housing', description: 'Rural housing programs', url: 'https://www.rd.usda.gov/programs-services/all-programs/single-family-housing-programs', categories: ['housing'], keywords: ['housing'] },
      { title: 'NeighborWorks America', description: 'Community development', url: 'https://www.neighborworks.org/', categories: ['housing'], keywords: ['housing'] },
      { title: 'Local Housing Finance Agencies', description: 'State and local housing', url: 'https://www.hud.gov/', categories: ['housing'], keywords: ['housing'] },
    ],
  },
  {
    id: 'food_bank_grants',
    label: 'Food Bank and Hunger Grants',
    description: 'Grants for food banks and hunger relief programs.',
    category: 'assistance',
    requiredSignals: [],
    boostSignals: ['food bank', 'hunger', 'food pantry'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Feeding America', description: 'National food bank network', url: 'https://www.feedingamerica.org/', categories: ['food'], keywords: ['food bank'] },
      { title: 'TEFAP', description: 'Emergency food assistance', url: 'https://www.fns.usda.gov/tefap', categories: ['food'], keywords: ['food'] },
      { title: 'CSFP', description: 'Commodity Supplemental Food Program', url: 'https://www.fns.usda.gov/csfp', categories: ['food'], keywords: ['food'] },
      { title: 'USDA Food Distribution', description: 'Food distribution programs', url: 'https://www.fns.usda.gov/fdd', categories: ['food'], keywords: ['food'] },
      { title: 'Food Research and Action Center', description: 'Anti-hunger advocacy', url: 'https://frac.org/', categories: ['food'], keywords: ['hunger'] },
      { title: 'Meals on Wheels', description: 'Senior nutrition', url: 'https://www.mealsonwheelsamerica.org/', categories: ['food'], keywords: ['senior'] },
    ],
  },
  {
    id: 'mental_health_grants',
    label: 'Mental Health Grants',
    description: 'Grants for mental health services and programs.',
    category: 'health',
    requiredSignals: [['health']],
    boostSignals: ['mental health', 'behavioral health'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'SAMHSA Grants', description: 'Substance Abuse and Mental Health Services', url: 'https://www.samhsa.gov/grants', categories: ['mental health'], keywords: ['mental health'] },
      { title: 'National Institute of Mental Health', description: 'NIMH research and training', url: 'https://www.nimh.nih.gov/funding', categories: ['mental health'], keywords: ['mental health'] },
      { title: 'NAMI', description: 'National Alliance on Mental Illness', url: 'https://www.nami.org/', categories: ['mental health'], keywords: ['mental health'] },
      { title: 'Mental Health America', description: 'MHA programs', url: 'https://www.mhanational.org/', categories: ['mental health'], keywords: ['mental health'] },
      { title: '988 Suicide and Crisis Lifeline', description: '24/7 crisis support', url: 'https://988lifeline.org/', categories: ['mental health'], keywords: ['crisis'] },
      { title: 'Substance Abuse Block Grants', description: 'SABG program', url: 'https://www.samhsa.gov/grants/block-grants', categories: ['mental health'], keywords: ['substance abuse'] },
    ],
  },
  {
    id: 'substance_use_grants',
    label: 'Substance Use Disorder Grants',
    description: 'Grants for substance use treatment and recovery.',
    category: 'health',
    requiredSignals: [['health']],
    boostSignals: ['substance use', 'recovery', 'addiction'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'SAMHSA Substance Use Grants', description: 'Treatment and recovery grants', url: 'https://www.samhsa.gov/grants', categories: ['substance use'], keywords: ['substance'] },
      { title: 'State Opioid Response Grants', description: 'SOR program', url: 'https://www.samhsa.gov/grants/block-grants', categories: ['substance use'], keywords: ['opioid'] },
      { title: 'HRSA Substance Use Disorder', description: 'Rural SUD treatment', url: 'https://www.hrsa.gov/opioids', categories: ['substance use'], keywords: ['substance'] },
      { title: 'Partnership to End Addiction', description: 'Addiction resources', url: 'https://drugfree.org/', categories: ['substance use'], keywords: ['addiction'] },
      { title: 'Faces and Voices of Recovery', description: 'Recovery advocacy', url: 'https://facesandvoicesofrecovery.org/', categories: ['substance use'], keywords: ['recovery'] },
      { title: 'National Council for Mental Wellbeing', description: 'Behavioral health resources', url: 'https://www.thenationalcouncil.org/', categories: ['substance use'], keywords: ['behavioral health'] },
    ],
  },
  {
    id: 'veteran_education_benefits',
    label: 'Veteran Education Benefits',
    description: 'Education benefits and scholarships for veterans.',
    category: 'veteran',
    requiredSignals: [['military']],
    boostSignals: ['veteran', 'GI Bill', 'education'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Post-9/11 GI Bill', description: 'Education benefits for veterans', url: 'https://www.va.gov/education/about-gi-bill-benefits/post-9-11/', categories: ['veteran'], keywords: ['GI Bill'] },
      { title: 'Vocational Rehabilitation and Employment', description: 'VR&E for disabled veterans', url: 'https://www.benefits.va.gov/vocrehab/', categories: ['veteran'], keywords: ['veteran'] },
      { title: 'Montgomery GI Bill', description: 'MGIB education benefits', url: 'https://www.va.gov/education/about-gi-bill-benefits/montgomery-active-duty/', categories: ['veteran'], keywords: ['GI Bill'] },
      { title: 'Yellow Ribbon Program', description: 'Private school funding', url: 'https://www.va.gov/education/about-gi-bill-benefits/post-9-11/yellow-ribbon-program/', categories: ['veteran'], keywords: ['Yellow Ribbon'] },
      { title: 'Scholarships for Veterans', description: 'Additional veteran scholarships', url: 'https://www.va.gov/education/survivor-dependent-benefits/', categories: ['veteran'], keywords: ['veteran'] },
      { title: 'Student Veterans of America', description: 'SVA resources', url: 'https://studentveterans.org/', categories: ['veteran'], keywords: ['veteran'] },
    ],
  },
  {
    id: 'agriculture_farming_grants',
    label: 'Agriculture and Farming Grants',
    description: 'Grants for farmers and agricultural operations.',
    category: 'agriculture',
    requiredSignals: [['occupation']],
    boostSignals: ['farm', 'agriculture', 'rural'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'USDA Farm Service Agency', description: 'FSA programs for farmers', url: 'https://www.fsa.usda.gov/programs-and-services/index', categories: ['agriculture'], keywords: ['farm'] },
      { title: 'NRCS Conservation Programs', description: 'Conservation for agricultural land', url: 'https://www.nrcs.usda.gov/programs', categories: ['agriculture'], keywords: ['conservation'] },
      { title: 'Value-Added Producer Grants', description: 'VAPG for value-added products', url: 'https://www.rd.usda.gov/programs-services/value-added-producer-grants', categories: ['agriculture'], keywords: ['farm'] },
      { title: 'Beginning Farmer and Rancher', description: 'Programs for new farmers', url: 'https://www.usda.gov/topics/operations/beginning-farmers', categories: ['agriculture'], keywords: ['beginning farmer'] },
      { title: 'Organic Certification Cost Share', description: 'Organic certification assistance', url: 'https://www.ams.usda.gov/services/grants/ocep', categories: ['agriculture'], keywords: ['organic'] },
      { title: 'Local Food Promotion Program', description: 'Local food system grants', url: 'https://www.ams.usda.gov/services/grants/lfpp', categories: ['agriculture'], keywords: ['local food'] },
    ],
  },
  {
    id: 'green_energy_grants',
    label: 'Green Energy and Renewable Grants',
    description: 'Grants for renewable energy and energy efficiency.',
    category: 'environment',
    requiredSignals: [],
    boostSignals: ['solar', 'renewable', 'energy'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'DOE Weatherization Assistance', description: 'Home weatherization grants', url: 'https://www.energy.gov/scep/wap/weatherization-assistance-program', categories: ['energy'], keywords: ['weatherization'] },
      { title: 'USDA Rural Energy for America', description: 'REAP renewable energy', url: 'https://www.rd.usda.gov/programs-services/energy-programs/rural-energy-america-program-reap', categories: ['energy'], keywords: ['renewable'] },
      { title: 'State Energy Offices', description: 'State-level energy programs', url: 'https://www.energy.gov/scep/state-and-local-solution-center', categories: ['energy'], keywords: ['energy'] },
      { title: 'IRA Clean Energy Tax Credits', description: 'Inflation Reduction Act incentives', url: 'https://www.energy.gov/save/home-energy-rebate-programs', categories: ['energy'], keywords: ['solar'] },
      { title: 'EPA Brownfields Grants', description: 'Brownfield redevelopment', url: 'https://www.epa.gov/brownfields/brownfields-grant-information', categories: ['environment'], keywords: ['brownfield'] },
      { title: 'Database of State Incentives', description: 'DSIRE renewable incentives', url: 'https://www.dsireusa.org/', categories: ['energy'], keywords: ['renewable'] },
    ],
  },
  {
    id: 'technology_startup_grants',
    label: 'Technology Startup Grants',
    description: 'Grants for tech and innovation startups. Excludes loans.',
    category: 'business',
    requiredSignals: [['occupation']],
    boostSignals: ['tech', 'innovation', 'startup'],
    strict_no_loans: true,
    strict_no_matching: true,
    directoryResources: [
      { title: 'SBIR/STTR Programs', description: 'Small Business Innovation Research', url: 'https://www.sbir.gov/', categories: ['technology'], keywords: ['SBIR'] },
      { title: 'NSF Innovation Corps', description: 'I-Corps for STEM innovations', url: 'https://www.nsf.gov/news/special_reports/i-corps/', categories: ['technology'], keywords: ['innovation'] },
      { title: 'NIH Small Business Grants', description: 'NIH SBIR/STTR', url: 'https://seed.nih.gov/', categories: ['technology'], keywords: ['NIH'] },
      { title: 'DOE Small Business Program', description: 'DOE SBIR/STTR', url: 'https://science.osti.gov/sbir', categories: ['technology'], keywords: ['DOE'] },
      { title: 'DARPA Small Business Programs', description: 'Defense innovation', url: 'https://www.darpa.mil/work-with-us/for-small-businesses', categories: ['technology'], keywords: ['defense'] },
      { title: 'State Innovation Grants', description: 'State-level tech grants', url: 'https://www.sbir.gov/', categories: ['technology'], keywords: ['SBIR'] },
    ],
  },
  {
    id: 'nonprofit_capacity_grants',
    label: 'Nonprofit Capacity Building Grants',
    description: 'Grants to strengthen nonprofit organizations.',
    category: 'organization',
    requiredSignals: [],
    boostSignals: ['nonprofit', 'capacity'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Candid (Foundation Center)', description: 'Grant research and resources', url: 'https://candid.org/', categories: ['nonprofit'], keywords: ['nonprofit'] },
      { title: 'IRS Tax-Exempt Status', description: '501(c)(3) information', url: 'https://www.irs.gov/charities-non-profits', categories: ['nonprofit'], keywords: ['501c3'] },
      { title: 'BoardSource', description: 'Nonprofit governance', url: 'https://boardsource.org/', categories: ['nonprofit'], keywords: ['nonprofit'] },
      { title: 'National Council of Nonprofits', description: 'State association network', url: 'https://www.councilofnonprofits.org/', categories: ['nonprofit'], keywords: ['nonprofit'] },
      { title: 'TechSoup', description: 'Technology donations for nonprofits', url: 'https://www.techsoup.org/', categories: ['nonprofit'], keywords: ['nonprofit'] },
      { title: 'Independent Sector', description: 'Nonprofit leadership', url: 'https://independentsector.org/', categories: ['nonprofit'], keywords: ['nonprofit'] },
    ],
  },
  {
    id: 'research_grants',
    label: 'Research Grants',
    description: 'Grants for academic and scientific research.',
    category: 'education',
    requiredSignals: [['academics']],
    boostSignals: ['research', 'academic'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Grants.gov', description: 'Federal grant opportunities', url: 'https://www.grants.gov/', categories: ['research'], keywords: ['grant'] },
      { title: 'NSF Funding', description: 'National Science Foundation', url: 'https://www.nsf.gov/funding/', categories: ['research'], keywords: ['research'] },
      { title: 'NIH Research Funding', description: 'National Institutes of Health', url: 'https://grants.nih.gov/', categories: ['research'], keywords: ['research'] },
      { title: 'NEH Grant Programs', description: 'Humanities research', url: 'https://www.neh.gov/grants', categories: ['research'], keywords: ['humanities'] },
      { title: 'DOE Office of Science', description: 'Scientific research funding', url: 'https://science.osti.gov/grants', categories: ['research'], keywords: ['research'] },
      { title: 'Research Professional', description: 'Funding database', url: 'https://www.researchprofessional.com/', categories: ['research'], keywords: ['research'] },
    ],
  },
  {
    id: 'community_development_grants',
    label: 'Community Development Grants',
    description: 'Grants for community and economic development.',
    category: 'community',
    requiredSignals: [],
    boostSignals: ['community', 'development'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'CDBG Program', description: 'Community Development Block Grants', url: 'https://www.hud.gov/program_offices/comm_planning/communitydevelopment', categories: ['community'], keywords: ['CDBG'] },
      { title: 'CDFI Fund', description: 'Community Development Financial Institutions', url: 'https://www.cdfifund.gov/', categories: ['community'], keywords: ['CDFI'] },
      { title: 'EDA Grants', description: 'Economic Development Administration', url: 'https://www.eda.gov/grants', categories: ['community'], keywords: ['economic development'] },
      { title: 'NeighborWorks', description: 'Community development network', url: 'https://www.neighborworks.org/', categories: ['community'], keywords: ['community'] },
      { title: 'Local Initiatives Support Corporation', description: 'LISC community development', url: 'https://www.lisc.org/', categories: ['community'], keywords: ['community'] },
      { title: 'United Way Worldwide', description: 'Community impact', url: 'https://www.unitedway.org/', categories: ['community'], keywords: ['community'] },
    ],
  },
  {
    id: 'healthcare_access_grants',
    label: 'Healthcare Access Grants',
    description: 'Grants to improve healthcare access and delivery.',
    category: 'health',
    requiredSignals: [['health']],
    boostSignals: ['healthcare', 'access', 'medical'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'HRSA Health Center Program', description: 'Community health centers', url: 'https://bphc.hrsa.gov/', categories: ['health'], keywords: ['health center'] },
      { title: 'Rural Health Grants', description: 'HRSA rural health programs', url: 'https://www.hrsa.gov/rural-health', categories: ['health'], keywords: ['rural'] },
      { title: 'Ryan White HIV/AIDS Program', description: 'HIV care and treatment', url: 'https://hab.hrsa.gov/', categories: ['health'], keywords: ['HIV'] },
      { title: 'Maternal and Child Health', description: 'MCHB programs', url: 'https://mchb.hrsa.gov/', categories: ['health'], keywords: ['maternal'] },
      { title: 'Telehealth Programs', description: 'Rural telehealth grants', url: 'https://www.hrsa.gov/telehealth', categories: ['health'], keywords: ['telehealth'] },
      { title: 'Free Clinics', description: 'National Association of Free Clinics', url: 'https://www.nafcclinics.org/', categories: ['health'], keywords: ['free clinic'] },
    ],
  },
  {
    id: 'legal_aid_grants',
    label: 'Legal Aid Grants',
    description: 'Grants for legal services and pro bono programs.',
    category: 'assistance',
    requiredSignals: [],
    boostSignals: ['legal', 'pro bono'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Legal Services Corporation', description: 'LSC federally funded legal aid', url: 'https://www.lsc.gov/', categories: ['legal'], keywords: ['legal aid'] },
      { title: 'Pro Bono Net', description: 'Pro bono legal resources', url: 'https://www.probono.net/', categories: ['legal'], keywords: ['pro bono'] },
      { title: 'ABA Free Legal Answers', description: 'Free legal advice online', url: 'https://abafreelegalanswers.org/', categories: ['legal'], keywords: ['legal'] },
      { title: 'LawHelp.org', description: 'Legal information and referrals', url: 'https://www.lawhelp.org/', categories: ['legal'], keywords: ['legal'] },
      { title: 'State Bar Pro Bono', description: 'State bar pro bono programs', url: 'https://www.americanbar.org/groups/probono_public_service/', categories: ['legal'], keywords: ['pro bono'] },
      { title: 'NLADA', description: 'National Legal Aid and Defender Association', url: 'https://www.nlada.org/', categories: ['legal'], keywords: ['legal aid'] },
    ],
  },
  {
    id: 'disaster_relief_grants',
    label: 'Disaster Relief Grants',
    description: 'Grants for disaster recovery and emergency relief.',
    category: 'assistance',
    requiredSignals: [],
    boostSignals: ['disaster', 'emergency', 'FEMA'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'FEMA Individual Assistance', description: 'Disaster assistance for individuals', url: 'https://www.fema.gov/assistance/individual', categories: ['disaster'], keywords: ['FEMA'] },
      { title: 'SBA Disaster Recovery Grants', description: 'Disaster business grant assistance (non-loan programs only)', url: 'https://www.sba.gov/funding-programs/grants', categories: ['disaster'], keywords: ['disaster'] },
      { title: 'Red Cross Disaster Relief', description: 'Emergency assistance', url: 'https://www.redcross.org/get-help.html', categories: ['disaster'], keywords: ['disaster'] },
      { title: 'Salvation Army Disaster Services', description: 'Disaster response', url: 'https://www.salvationarmyusa.org/usn/disaster-services/', categories: ['disaster'], keywords: ['disaster'] },
      { title: '211 Disaster Help', description: 'Local disaster resources', url: 'https://www.211.org/services/disaster-recovery', categories: ['disaster'], keywords: ['disaster'] },
      { title: 'CDBG-DR', description: 'Disaster recovery block grants', url: 'https://www.hud.gov/info/disasterresources', categories: ['disaster'], keywords: ['disaster'] },
    ],
  },
  {
    id: 'childcare_grants',
    label: 'Child Care Grants',
    description: 'Grants for child care providers and families.',
    category: 'family',
    requiredSignals: [['family']],
    boostSignals: ['child care', 'daycare'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'Child Care and Development Fund', description: 'CCDF block grant', url: 'https://www.acf.hhs.gov/occ/ccdf-grantee-resources', categories: ['child care'], keywords: ['child care'] },
      { title: 'ChildCare.gov', description: 'Child care resources and subsidies', url: 'https://www.childcare.gov/', categories: ['child care'], keywords: ['child care'] },
      { title: 'Head Start and Early Head Start', description: 'Early childhood programs', url: 'https://www.acf.hhs.gov/ohs', categories: ['child care'], keywords: ['Head Start'] },
      { title: 'National Association for the Education of Young Children', description: 'NAEYC resources', url: 'https://www.naeyc.org/', categories: ['child care'], keywords: ['child care'] },
      { title: 'Child Care Aware', description: 'Child care information', url: 'https://www.childcareaware.org/', categories: ['child care'], keywords: ['child care'] },
      { title: 'State Child Care Agencies', description: 'State-level child care', url: 'https://www.childcare.gov/consumer-education/state-and-territory-child-care-agencies', categories: ['child care'], keywords: ['child care'] },
    ],
  },
  {
    id: 'transportation_grants',
    label: 'Transportation Grants',
    description: 'Grants for transportation and mobility programs.',
    category: 'community',
    requiredSignals: [],
    boostSignals: ['transportation', 'transit', 'mobility'],
    strict_no_loans: false,
    strict_no_matching: false,
    directoryResources: [
      { title: 'FTA Grants', description: 'Federal Transit Administration', url: 'https://www.transit.dot.gov/grants', categories: ['transportation'], keywords: ['transit'] },
      { title: 'FHWA Transportation', description: 'Highway and transportation grants', url: 'https://www.fhwa.dot.gov/', categories: ['transportation'], keywords: ['transportation'] },
      { title: 'Elderly and Disabled Transportation', description: 'Section 5310 program', url: 'https://www.transit.dot.gov/grants/5307-5339-program-grants', categories: ['transportation'], keywords: ['transportation'] },
      { title: 'Rural Transportation', description: 'Rural transit programs', url: 'https://www.transit.dot.gov/grants/rural-areas', categories: ['transportation'], keywords: ['rural'] },
      { title: 'Mobility Management', description: 'Coordinated transportation', url: 'https://www.transit.dot.gov/', categories: ['transportation'], keywords: ['mobility'] },
      { title: 'State DOT Grants', description: 'State transportation departments', url: 'https://www.fhwa.dot.gov/federalaid/', categories: ['transportation'], keywords: ['transportation'] },
    ],
  },
]

// ===========================================================================
// PROFILE-RELEVANCE SELECTION
// ---------------------------------------------------------------------------
// The corpus crawler used to run ALL ~56 domain corpora for every crawl, with
// no regard for the profile (a church profile got EMS/UAW domains; a paramedic
// got LGBTQ scholarships). Per the GrantFlow goal "use the FULL profile",
// selectRelevantDomainIds(signals) scores each registry config against the
// profile's signals (entityType / occupation / needs / keywords / demographics
// / military) and returns only the relevant subset of domain ids to crawl.
//
// Scoring is ADDITIVE and NEUTRAL on missing data (canonical_rules G4):
//   - a config's `category`, `boostSignals`, label/description text, and its
//     directoryResources' categories/keywords are matched against a flattened,
//     lowercased "profile term blob";
//   - configs with NO requiredSignals are treated as broad/directory-style and
//     get a small baseline so general resources survive (G4 directory rule);
//   - the result is never empty for a non-thin profile — if nothing scores we
//     fall back to the broad configs so discovery is never a zero-result set
//     (G2: zero results is a failure state).
// ===========================================================================

/** Map common entity / occupation hints to the registry categories they imply. */
const ENTITY_CATEGORY_HINTS = {
  // entity / applicant types
  nonprofit: ['organization', 'community'],
  organization: ['organization', 'community'],
  church: ['organization'],
  faith: ['organization'],
  faith_based: ['organization'],
  ministry: ['organization'],
  business: ['business'],
  small_business: ['business'],
  student: ['education'],
  college_student: ['education'],
  veteran: ['veteran'],
  military: ['veteran'],
  senior: ['demographics'],
  caregiver: ['health', 'disability'],
  // occupations / domains
  paramedic: ['first responder'],
  ems: ['first responder'],
  emt: ['first responder'],
  firefighter: ['first responder'],
  'first responder': ['first responder'],
  police: ['first responder'],
  nurse: ['education', 'health'],
  farmer: ['agriculture'],
  artist: ['arts'],
}

function _toIterable(v) {
  if (!v) return []
  if (Array.isArray(v)) return v
  if (typeof v[Symbol.iterator] === 'function') return Array.from(v)
  return []
}

/**
 * Build a flat, lowercased list of profile terms used for relevance matching.
 * Pulls from every signal facet that can describe WHAT a profile is about.
 */
function buildProfileTermBlob(signals) {
  if (!signals || typeof signals !== 'object') return { terms: [], categories: new Set() }
  const terms = []
  const push = (v) => { const s = String(v ?? '').toLowerCase().trim(); if (s) terms.push(s) }

  for (const k of _toIterable(signals.keywords)) push(k)
  for (const k of _toIterable(signals.keywordSet)) push(k)
  for (const k of _toIterable(signals.occupation)) push(k)
  for (const k of _toIterable(signals.needs)) push(k)
  for (const k of _toIterable(signals.demographics)) push(k)
  for (const k of _toIterable(signals.military)) push(k)
  for (const k of _toIterable(signals.interests)) push(k)
  for (const k of _toIterable(signals.assistance)) push(k)
  for (const k of _toIterable(signals.health)) push(k)
  for (const k of _toIterable(signals.applicantTypes)) push(k)
  push(signals.applicantType)
  push(signals.primaryType)
  push(signals.entityType)

  // Derive implied registry categories from entity/occupation/keyword hints.
  const categories = new Set()
  for (const term of terms) {
    for (const [hint, cats] of Object.entries(ENTITY_CATEGORY_HINTS)) {
      if (term === hint || term.includes(hint)) {
        for (const c of cats) categories.add(c)
      }
    }
  }
  return { terms, categories }
}

/** Score one registry config's relevance to the profile term blob. */
function scoreConfigRelevance(config, blob) {
  let score = 0
  const matched = []
  const { terms, categories } = blob
  const termSet = new Set(terms)

  // (1) Category match — strongest signal (a paramedic → 'first responder').
  const cat = String(config.category || '').toLowerCase()
  if (cat && categories.has(cat)) { score += 6; matched.push(`category:${cat}`) }

  // (2) boostSignals overlap with profile terms (substring both ways).
  for (const b of (config.boostSignals || [])) {
    const bl = String(b).toLowerCase()
    if (!bl) continue
    if (termSet.has(bl) || terms.some((t) => t.includes(bl) || bl.includes(t))) {
      score += 3
      matched.push(`boost:${bl}`)
    }
  }

  // (3) directoryResource categories/keywords overlap with profile terms.
  for (const res of (config.directoryResources || [])) {
    const resTerms = [
      ...(_toIterable(res.categories)),
      ...(_toIterable(res.keywords)),
    ].map((x) => String(x).toLowerCase())
    for (const rt of resTerms) {
      if (!rt) continue
      if (termSet.has(rt) || terms.some((t) => (t.length > 3 && (t.includes(rt) || rt.includes(t))))) {
        score += 1
        matched.push(`res:${rt}`)
        break // one hit per resource is enough to avoid over-weighting
      }
    }
  }

  // (4) label/description text overlap (cheap text scan for multi-word terms).
  const text = `${config.label || ''} ${config.description || ''}`.toLowerCase()
  for (const t of termSet) {
    if (t.length >= 5 && text.includes(t)) { score += 1; matched.push(`text:${t}`) }
  }

  return { score, matched }
}

/** Registry ids that are broad/directory-style (no required signals). */
function isBroadConfig(config) {
  return !Array.isArray(config.requiredSignals) || config.requiredSignals.length === 0
}

/**
 * Select the relevant subset of domain corpus ids for a profile.
 *
 * @param {Object} signals - buildProfileSignals() output (or compatible).
 * @param {Object} [opts]
 * @param {number} [opts.minScore=3] - minimum relevance score to include.
 * @param {number} [opts.maxIds]     - optional cap on number of ids.
 * @param {boolean} [opts.includeBroad=true] - always include broad/directory configs.
 * @returns {string[]} relevant domain ids (never empty for a non-empty registry).
 */
export function selectRelevantDomainIds(signals, opts = {}) {
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 3
  const includeBroad = opts.includeBroad !== false

  // No usable signals → return everything (admin/whole-corpus behavior).
  const blob = buildProfileTermBlob(signals)
  if (blob.terms.length === 0) {
    return DOMAIN_CRAWLER_REGISTRY.map((c) => c.id)
  }

  const scored = DOMAIN_CRAWLER_REGISTRY.map((config) => ({
    id: config.id,
    config,
    ...scoreConfigRelevance(config, blob),
  }))

  const relevant = scored.filter((s) => s.score >= minScore)
  const ids = new Set(relevant.map((s) => s.id))

  // Always keep broad/directory-style resources so general "where to find
  // grants" sources survive selection (canonical_rules G4 directory rule).
  if (includeBroad) {
    for (const s of scored) {
      if (isBroadConfig(s.config)) ids.add(s.id)
    }
  }

  // Never return an empty set for a profile that HAS signals — fall back to the
  // broad configs (G2: zero results is a failure state).
  if (ids.size === 0) {
    for (const s of scored) {
      if (isBroadConfig(s.config)) ids.add(s.id)
    }
    if (ids.size === 0) return DOMAIN_CRAWLER_REGISTRY.map((c) => c.id)
  }

  let result = [...ids]
  if (typeof opts.maxIds === 'number' && opts.maxIds > 0 && result.length > opts.maxIds) {
    // Keep highest-scoring first, then broad configs.
    const scoreById = new Map(scored.map((s) => [s.id, s.score]))
    result = result
      .sort((a, b) => (scoreById.get(b) ?? 0) - (scoreById.get(a) ?? 0))
      .slice(0, opts.maxIds)
  }
  return result
}

/** Detailed relevance scoring (for diagnostics / Sam observability). */
export function scoreDomainRelevance(signals) {
  const blob = buildProfileTermBlob(signals)
  return DOMAIN_CRAWLER_REGISTRY.map((config) => {
    const { score, matched } = scoreConfigRelevance(config, blob)
    return { id: config.id, category: config.category, score, matched, broad: isBroadConfig(config) }
  }).sort((a, b) => b.score - a.score)
}
