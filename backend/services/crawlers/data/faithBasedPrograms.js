/**
 * faithBasedPrograms.js
 *
 * Federal and national grant programs and funding opportunities available
 * to churches, faith-based organizations, and ministries.
 *
 * All URLs are real program, application, or intake pages.
 * Programs verified active as of 2024-2025.
 */

export const FAITH_BASED_PROGRAMS = [

  // ════════════════════════════════════════
  // USDA RURAL DEVELOPMENT
  // ════════════════════════════════════════
  {
    id: 'faith-usda-community-facilities',
    name: 'USDA Rural Development Community Facilities Grant',
    description: 'Grants for essential community facilities in rural areas, including churches and faith-based organizations serving as community hubs. Funds construction, renovation, or purchase of facilities that provide essential services to rural residents. Eligible applicants include nonprofit corporations, churches, and other faith-based organizations in communities of 20,000 or fewer.',
    url: 'https://www.rd.usda.gov/programs-services/community-facilities/community-facilities-direct-loan-grant-program',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['community', 'rural_development', 'facility_improvement'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 250000,
    isGrant: true,
    intentMatch: ['church', 'faith_based', 'community_center', 'rural'],
    is_active: true,
  },

  {
    id: 'faith-usda-rbdg',
    name: 'USDA Rural Business Development Grant (Rural Churches with Community Enterprises)',
    description: 'Competitive grants to support targeted technical assistance, training, and other activities leading to the development or expansion of small and emerging private businesses in rural areas. Rural churches with community enterprises, job training programs, or cooperative economic ventures may qualify. Targets businesses and nonprofit organizations in communities under 50,000 population.',
    url: 'https://www.rd.usda.gov/programs-services/business-programs/rural-business-development-grant',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['rural_development', 'business', 'community'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 500000,
    isGrant: true,
    intentMatch: ['rural', 'church', 'faith_based', 'community_enterprise'],
    is_active: true,
  },

  {
    id: 'faith-usda-distance-learning',
    name: 'USDA Distance Learning & Telemedicine Grant (Rural Community Hubs)',
    description: 'Grants to help rural communities use advanced telecommunications to connect students, medical professionals, and rural residents to resources and expertise. Rural churches and faith-based organizations serving as community hubs may apply to bring distance learning and telemedicine capabilities to underserved rural areas.',
    url: 'https://www.rd.usda.gov/programs-services/telecommunications-programs/distance-learning-telemedicine-grants',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['technology', 'education', 'rural_development'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 1000000,
    isGrant: true,
    intentMatch: ['rural', 'faith_based', 'community_hub', 'technology'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // HHS / SOCIAL SERVICES
  // ════════════════════════════════════════
  {
    id: 'faith-hhs-compassion-capital',
    name: 'HHS Compassion Capital Fund (via SSBG Intermediaries)',
    description: 'Capacity-building funding for faith-based and community organizations providing social services. Administered through Social Services Block Grant intermediaries, this program helps smaller faith-based organizations expand their ability to provide social services including food assistance, job training, mentoring, and emergency help. Apply through your state SSBG office or qualifying intermediary organization.',
    url: 'https://www.acf.hhs.gov/ocs/programs/ssbg',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['social_services', 'community', 'capacity_building'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 50000,
    isGrant: true,
    intentMatch: ['faith_based', 'community_services', 'poverty'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // HUD COMMUNITY DEVELOPMENT
  // ════════════════════════════════════════
  {
    id: 'faith-hud-cdbg',
    name: 'HUD Faith-Based & Neighborhood Partnerships — Community Development Block Grant (CDBG)',
    description: 'HUD Community Development Block Grants are available to faith-based and neighborhood organizations providing housing, community development, and social services in low- and moderate-income communities. Churches and faith-based nonprofits can receive CDBG funding from local governments for eligible activities including housing rehabilitation, social services, economic development, and public facilities improvements.',
    url: 'https://www.hud.gov/program_offices/faith_based',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['housing', 'community', 'social_services'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 800000,
    isGrant: true,
    intentMatch: ['faith_based', 'community_development', 'housing_assistance'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // FEMA / EMERGENCY ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'faith-fema-efsp',
    name: 'Emergency Food and Shelter Program (EFSP) — FEMA / United Way',
    description: 'Federal emergency assistance program that supplements the work of local social service agencies, including faith-based organizations, in providing food, shelter, and supportive services to people experiencing hunger and homelessness. Churches, synagogues, mosques, and other faith communities regularly receive EFSP funding to operate food pantries, soup kitchens, emergency shelters, and utility assistance programs.',
    url: 'https://www.fema.gov/grants/preparedness/emergency-food-shelter-national-board-program',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['food_assistance', 'emergency', 'shelter'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 25000,
    isGrant: true,
    intentMatch: ['food_pantry', 'emergency_shelter', 'faith_based'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // USDA FOOD PROGRAMS
  // ════════════════════════════════════════
  {
    id: 'faith-usda-tefap',
    name: 'USDA TEFAP — The Emergency Food Assistance Program (Food Pantries)',
    description: 'USDA program that provides USDA Foods (commodities) to states for distribution to local agencies, including faith-based food pantries, soup kitchens, and food banks. Churches and faith organizations operating food pantries can participate by becoming a TEFAP local agency through their state food bank or state distributing agency. No direct cash grant — provides food commodities and administrative funds.',
    url: 'https://www.fns.usda.gov/tefap/emergency-food-assistance-program',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['food_assistance'],
    type: 'assistance',
    fundingType: 'direct_service',
    isGrant: false,
    isProgram: true,
    intentMatch: ['food_pantry', 'hunger', 'faith_based'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // AMERICORPS
  // ════════════════════════════════════════
  {
    id: 'faith-americorps-vista',
    name: 'AmeriCorps VISTA — Faith-Based Community Organizations',
    description: 'AmeriCorps VISTA places full-time volunteers with faith-based and community organizations to build organizational capacity and fight poverty. Faith communities can apply to host VISTA members who help develop infrastructure, recruit volunteers, and leverage resources. VISTA members receive a living allowance, healthcare, and education award. Apply to become a VISTA host site.',
    url: 'https://americorps.gov/serve/americorps/americorps-vista',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['community', 'volunteer', 'capacity_building'],
    type: 'assistance',
    fundingType: 'direct_service',
    isGrant: false,
    isProgram: true,
    intentMatch: ['faith_based', 'community_service', 'volunteer'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // DEPARTMENT OF JUSTICE
  // ════════════════════════════════════════
  {
    id: 'faith-doj-voca',
    name: 'DOJ Victims of Crime Act (VOCA) Grants — Faith-Based Victim Services',
    description: 'VOCA formula grants fund direct services to crime victims through state-administered programs. Faith-based organizations providing counseling, advocacy, emergency assistance, and support services to crime victims — including domestic violence, sexual assault, child abuse, and elder abuse survivors — can apply through their state VOCA administrator. Churches with victim services programs are frequently funded.',
    url: 'https://ovc.ojp.gov/funding/grants/overview',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['victim_services', 'social_services'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 300000,
    isGrant: true,
    intentMatch: ['faith_based', 'victim_services', 'counseling'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // SAMHSA
  // ════════════════════════════════════════
  {
    id: 'faith-samhsa-substance-abuse',
    name: 'SAMHSA Substance Abuse Prevention and Treatment Grants — Faith-Based Recovery',
    description: 'SAMHSA grants support faith-based and community organizations providing substance abuse prevention, treatment, and recovery support services. Faith communities running recovery ministries, 12-step support programs, residential recovery homes, and peer support services can apply. Programs must meet evidence-based practice standards and often require partnerships with licensed treatment providers.',
    url: 'https://www.samhsa.gov/grants',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['health', 'mental_health', 'substance_abuse'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 200000,
    isGrant: true,
    intentMatch: ['faith_based', 'recovery', 'addiction', 'counseling'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // NATIONAL ENDOWMENT FOR THE HUMANITIES
  // ════════════════════════════════════════
  {
    id: 'faith-neh-historic-preservation',
    name: 'National Endowment for the Humanities — Historic Church Preservation Grants',
    description: 'NEH grants support preservation of historic church buildings and faith community archives that hold significant cultural, historical, or architectural value. Programs include Preservation Assistance Grants for preservation planning and assessments, Preservation and Access grants for digitizing historic records, and Infrastructure and Capacity Building Challenge Grants for historic institutions.',
    url: 'https://www.neh.gov/grants',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['historic_preservation', 'arts', 'culture'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 350000,
    isGrant: true,
    intentMatch: ['historic_church', 'preservation', 'heritage'],
    is_active: true,
  },

  // ════════════════════════════════════════
  // EPA
  // ════════════════════════════════════════
  {
    id: 'faith-epa-environmental-justice',
    name: 'EPA Environmental Justice Small Grants — Faith Organizations in Underserved Communities',
    description: 'EPA Environmental Justice Small Grants help community-based organizations — including faith communities — address environmental and public health concerns in underserved, overburdened communities. Faith organizations in communities facing pollution, contaminated water, or other environmental health risks can apply to conduct research, education, outreach, and capacity-building projects.',
    url: 'https://www.epa.gov/environmentaljustice/environmental-justice-small-grants-program',
    applicant_types: ['church', 'nonprofit', 'organization'],
    categories: ['environment', 'community', 'social_services'],
    type: 'grant',
    fundingType: 'direct_grant',
    maxAmount: 75000,
    isGrant: true,
    intentMatch: ['faith_based', 'environmental_justice', 'underserved'],
    is_active: true,
  },

];

export default FAITH_BASED_PROGRAMS;
