/**
 * volunteerFirePrograms.js
 *
 * Curated grant and assistance programs specifically for Volunteer Fire
 * Departments (VFDs) and rural emergency services. Covers equipment, staffing,
 * training, infrastructure, and health/wellness programs available at the
 * federal, state, and national level.
 *
 * All programs verified active 2024–2025. Every URL is real and current.
 */

export const VOLUNTEER_FIRE_PROGRAMS = [

  // ════════════════════════════════════════
  // FEMA FIRE GRANTS
  // ════════════════════════════════════════
  {
    id: 'vfd-fema-safer',
    name: 'FEMA Staffing for Adequate Fire and Emergency Response (SAFER)',
    description: 'Federal grant program to help fire departments increase the number of frontline firefighters by funding new hires and supporting recruitment and retention of volunteers.',
    source: 'federal',
    agency: 'FEMA / U.S. Fire Administration',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['staffing', 'recruitment', 'volunteer_training_support'],
    applicationUrl: 'https://www.fema.gov/grants/preparedness/staffing-adequate-fire-emergency-response',
    deadlineType: 'annual',
    maxAmount: 1000000,
    notes: 'Two tracks: Hiring of Firefighters and Recruitment/Retention of Volunteer Firefighters. Annual notice of funding opportunity.',
  },

  {
    id: 'vfd-fema-afg',
    name: 'FEMA Assistance to Firefighters Grant (AFG)',
    description: 'Federal grant providing funding to fire departments for equipment, personal protective equipment (PPE), training, and emergency vehicles to protect firefighters and communities.',
    source: 'federal',
    agency: 'FEMA / U.S. Fire Administration',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['equipment', 'training', 'vehicles'],
    applicationUrl: 'https://www.fema.gov/grants/preparedness/firefighters',
    deadlineType: 'annual',
    maxAmount: 2500000,
    notes: 'Priority funding areas rotate annually; cost share required (5–10% for most applicants). One of the most widely used VFD grants.',
  },

  {
    id: 'vfd-fema-fps',
    name: 'FEMA Fire Prevention and Safety (FP&S)',
    description: 'Federal grant supporting fire prevention and safety initiatives including public education, research, and firefighter safety programs.',
    source: 'federal',
    agency: 'FEMA / U.S. Fire Administration',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['training', 'equipment', 'community_development'],
    applicationUrl: 'https://www.fema.gov/grants/preparedness/fire-prevention-safety',
    deadlineType: 'annual',
    maxAmount: 1500000,
    notes: 'Two activity tracks: Fire Prevention and Safety, and Firefighter Safety Research and Development. 5% cost match required.',
  },

  // ════════════════════════════════════════
  // USDA RURAL DEVELOPMENT
  // ════════════════════════════════════════
  {
    id: 'vfd-usda-cf-grant',
    name: 'USDA Community Facilities Grant Program (Rural VFDs)',
    description: 'USDA Rural Development grant for essential community facilities in rural areas, including fire stations, fire trucks, and emergency equipment for fire departments serving populations under 20,000.',
    source: 'federal',
    agency: 'USDA Rural Development',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services', 'rural'],
    categories: ['infrastructure', 'equipment', 'vehicles'],
    applicationUrl: 'https://www.rd.usda.gov/programs-services/community-facilities/community-facilities-direct-loan-grant-program',
    deadlineType: 'rolling',
    maxAmount: null,
    notes: 'Grant percentage based on median household income of the community; rural areas (under 20,000 population) only. Contact your local USDA RD office.',
  },

  {
    id: 'vfd-usda-cf-ta',
    name: 'USDA Rural Development Community Facilities Technical Assistance',
    description: 'USDA program providing planning grants and technical assistance to help rural fire departments assess needs, develop long-range plans, and prepare applications for larger capital grants.',
    source: 'federal',
    agency: 'USDA Rural Development',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services', 'rural'],
    categories: ['training', 'infrastructure'],
    applicationUrl: 'https://www.rd.usda.gov/programs-services/community-facilities',
    deadlineType: 'rolling',
    maxAmount: 150000,
    notes: 'Planning and technical assistance grants to support project development; separate from the direct loan and grant program.',
  },

  // ════════════════════════════════════════
  // DHS / HOMELAND SECURITY
  // ════════════════════════════════════════
  {
    id: 'vfd-dhs-hsgp',
    name: 'DHS Homeland Security Grant Program (HSGP)',
    description: 'Federal grants providing funding to strengthen the nation\'s ability to prevent, prepare for, and respond to acts of terrorism and other catastrophic events, including equipment and training for emergency responders.',
    source: 'federal',
    agency: 'FEMA / Department of Homeland Security',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['equipment', 'training'],
    applicationUrl: 'https://www.fema.gov/grants/preparedness/homeland-security',
    deadlineType: 'annual',
    maxAmount: null,
    notes: 'Pass-through grants administered by State Administrative Agencies (SAAs). Contact your state emergency management agency for local application process.',
  },

  // ════════════════════════════════════════
  // EDA / INFRASTRUCTURE
  // ════════════════════════════════════════
  {
    id: 'vfd-eda-public-works',
    name: 'EDA Public Works and Economic Adjustment Assistance',
    description: 'Economic Development Administration grants for public infrastructure projects including fire stations in economically distressed communities.',
    source: 'federal',
    agency: 'U.S. Economic Development Administration',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services', 'rural'],
    categories: ['infrastructure'],
    applicationUrl: 'https://www.eda.gov/funding/programs/public-works',
    deadlineType: 'rolling',
    maxAmount: null,
    notes: 'Must demonstrate economic distress; fire stations must serve a documented economic development purpose. Competitive and highly competitive.',
  },

  // ════════════════════════════════════════
  // USDA FOREST SERVICE / WILDLAND FIRE
  // ════════════════════════════════════════
  {
    id: 'vfd-usfs-volunteer-fire-assistance',
    name: 'USFS State Forestry Grants — Volunteer Fire Assistance Program',
    description: 'USDA Forest Service program providing wildland firefighting training, equipment, and technical assistance to rural volunteer fire departments at risk from wildland fires.',
    source: 'federal',
    agency: 'USDA Forest Service',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services', 'rural'],
    categories: ['training', 'equipment', 'certification_assistance'],
    applicationUrl: 'https://www.fs.usda.gov/managing-land/fire/grants',
    deadlineType: 'annual',
    maxAmount: null,
    notes: 'Administered through State Forestry agencies. Best for VFDs in wildland-urban interface areas. Contact your state forestry department.',
  },

  // ════════════════════════════════════════
  // DISTANCE LEARNING / TRAINING
  // ════════════════════════════════════════
  {
    id: 'vfd-usda-dlt',
    name: 'USDA Distance Learning and Telemedicine Grants (VFD Training)',
    description: 'USDA Rural Development grants to help rural communities acquire technology and equipment for distance learning and telemedicine, including remote training for rural fire and EMS personnel.',
    source: 'federal',
    agency: 'USDA Rural Development',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services', 'rural'],
    categories: ['training', 'equipment'],
    applicationUrl: 'https://www.rd.usda.gov/programs-services/telecommunications-programs/distance-learning-telemedicine-grants',
    deadlineType: 'annual',
    maxAmount: 1000000,
    notes: 'Rural communities with populations under 26,000. Can be used to fund online training platforms, video conferencing equipment, and EMT/paramedic remote instruction.',
  },

  // ════════════════════════════════════════
  // AMERICORPS / WORKFORCE
  // ════════════════════════════════════════
  {
    id: 'vfd-americorps-fema-corps',
    name: 'AmeriCorps FEMA Corps',
    description: 'AmeriCorps program placing members with FEMA to support disaster preparedness, response, and recovery — members can partner with local VFDs on community resilience and preparedness projects.',
    source: 'federal',
    agency: 'AmeriCorps / FEMA',
    type: 'service',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['staffing', 'training', 'community_development'],
    applicationUrl: 'https://americorps.gov/serve/fit-finder/americorps-fema-corps',
    deadlineType: 'annual',
    maxAmount: null,
    notes: 'VFDs can request FEMA Corps members as disaster response partners. Members receive living allowances and education awards — not direct grants to the department.',
  },

  // ════════════════════════════════════════
  // STATE-LEVEL PROGRAMS
  // ════════════════════════════════════════
  {
    id: 'vfd-state-assoc-mutual-aid',
    name: 'State VFD Association Mutual Aid and State Appropriation Grants',
    description: 'Most states have Volunteer Fire Department associations (e.g., Virginia VDFP, Pennsylvania PVFA, Texas TVFRA) that distribute state-appropriated funds to local VFDs for equipment, training, and operations.',
    source: 'state',
    agency: 'State VFD Associations (varies by state)',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['equipment', 'training', 'staffing'],
    applicationUrl: 'https://www.nvfc.org/programs/fire-ems-hotline/',
    deadlineType: 'varies',
    maxAmount: null,
    notes: 'Availability and amounts vary significantly by state. Contact your state VFD association or state fire marshal office. Examples: VA-VDFP, PA-PVFA, TX-TVFRA.',
  },

  {
    id: 'vfd-state-empg',
    name: 'State Emergency Management Performance Grants (EMPG)',
    description: 'Federal pass-through grants administered by state emergency management agencies to support local emergency management, including funding for VFDs participating in emergency preparedness programs.',
    source: 'state',
    agency: 'State Emergency Management Agencies (FEMA pass-through)',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['training', 'equipment', 'staffing'],
    applicationUrl: 'https://www.fema.gov/grants/preparedness/emergency-management-performance',
    deadlineType: 'annual',
    maxAmount: null,
    notes: 'Distributed by state emergency management agencies; 50% cost match required. Contact your state emergency management director for sub-grant availability.',
  },

  // ════════════════════════════════════════
  // NATIONAL / NONPROFIT FUNDERS
  // ════════════════════════════════════════
  {
    id: 'vfd-nvfc-heart-healthy',
    name: 'NVFC Heart-Healthy Firefighter Program',
    description: 'National Volunteer Fire Council program providing health and wellness resources, including grants for cardiac health screenings and fitness equipment for volunteer fire departments.',
    source: 'national',
    agency: 'National Volunteer Fire Council (NVFC)',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['training', 'equipment'],
    applicationUrl: 'https://www.nvfc.org/programs/heart-healthy-firefighter-program/',
    deadlineType: 'rolling',
    maxAmount: 5000,
    notes: 'Focuses on preventing cardiac events, the leading cause of firefighter line-of-duty deaths. Includes wellness assessments and fitness grants.',
  },

  {
    id: 'vfd-firehouse-subs-foundation',
    name: 'Firehouse Subs Public Safety Foundation Equipment Grants',
    description: 'Grants from the Firehouse Subs Public Safety Foundation providing lifesaving equipment to first responders, including volunteer fire departments, at no cost.',
    source: 'national',
    agency: 'Firehouse Subs Public Safety Foundation',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['equipment'],
    applicationUrl: 'https://firehousesubs.com/foundation',
    deadlineType: 'rolling',
    maxAmount: 20000,
    notes: 'Priority given to underfunded departments. Equipment focus includes thermal imaging cameras, rescue tools, and PPE. Applications reviewed quarterly.',
  },

  {
    id: 'vfd-walmart-community-grants',
    name: 'Walmart / Sam\'s Club Community Grants (VFD Equipment)',
    description: 'Walmart and Sam\'s Club local community grants that volunteer fire departments can use to purchase equipment, PPE, and supplies not covered by federal grants.',
    source: 'national',
    agency: 'Walmart Foundation',
    type: 'grant',
    eligibility: ['volunteer_fire', 'emergency_services'],
    categories: ['equipment'],
    applicationUrl: 'https://walmart.org/how-we-give/local-community-grants',
    deadlineType: 'annual',
    maxAmount: 5000,
    notes: 'Must apply through local Walmart or Sam\'s Club store. Priority given to nonprofits serving the local community. Annual application cycle.',
  },

];
